import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = 'momoai.provider-executor.v1';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_PLATFORM_BASE_URL = 'https://momoai.pro';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PROVIDER_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 16;
const REFERENCE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type UnknownRecord = Record<string, unknown>;

export interface ProviderExecutorInput {
  protocolVersion: typeof PROTOCOL_VERSION;
  request?: unknown;
  content?: string;
  taskId: string;
  contextId: string;
  invocationToken?: string;
  options?: UnknownRecord;
}

export interface ImageGenerationOptions {
  prompt: string;
  aspect_ratio?: '1:1' | '3:2' | '2:3';
  quality?: 'low' | 'medium' | 'high';
}

interface ReferenceImage {
  assetId: string;
  uri: string;
  name: string;
  mimeType: typeof REFERENCE_IMAGE_MIME_TYPES[number];
}

interface NormalizedImageRequest extends ImageGenerationOptions {
  referenceImages: ReferenceImage[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringOption(options: UnknownRecord, key: string, fallback: string) {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringListOption(options: UnknownRecord, key: string, environmentValue = '') {
  const value = options[key];
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : environmentValue.split(',');
  return [...new Set(candidates.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function resolveApiKey(options: UnknownRecord) {
  const apiKeyEnv = stringOption(options, 'apiKeyEnv', 'OPENAI_API_KEY');
  const fromEnvironment = process.env[apiKeyEnv]?.trim();
  if (fromEnvironment) return fromEnvironment;

  const apiKeyFile = stringOption(
    options,
    'apiKeyFile',
    process.env.MOMOAI_IMAGE_API_KEY_FILE || ''
  );
  if (!apiKeyFile) return undefined;
  try {
    const fromFile = readFileSync(apiKeyFile, 'utf8').trim();
    if (!fromFile) throw new Error('file is empty');
    return fromFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unable to read file';
    throw new Error(`Unable to load image API key file: ${detail}`);
  }
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function collectPartPayloads(value: unknown, output: unknown[]) {
  if (!isRecord(value)) return;
  const kind = String(value.kind || value.type || '').toLowerCase();
  if ((kind === 'data' || kind === 'json') && value.data !== undefined) output.push(value.data);
  if (kind === 'text' && typeof value.text === 'string') output.push(value.text);
  if (typeof value.content === 'string') output.push(value.content);
}

function requestParts(request: unknown): UnknownRecord[] {
  if (!isRecord(request)) return [];
  const params = isRecord(request.params) ? request.params : {};
  const message = isRecord(params.message) ? params.message : {};
  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(params.parts)
      ? params.parts
      : [];
  return parts.filter(isRecord);
}

function requestPayloads(request: unknown): unknown[] {
  const output: unknown[] = [];
  for (const part of requestParts(request)) collectPartPayloads(part, output);
  return output;
}

function normalizeReferenceImage(part: UnknownRecord, index: number): ReferenceImage | null {
  const kind = String(part.kind || part.type || '').toLowerCase();
  if (kind !== 'file') return null;
  const file = isRecord(part.file) ? part.file : {};
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const role = String(metadata.role || '').trim().toLowerCase();
  const assetId = String(metadata.asset_id || metadata.assetId || '').trim();
  const uri = String(file.uri || '').trim();
  const mimeType = String(file.mimeType || file.mime_type || '').trim().toLowerCase();

  if (role !== 'reference_image') {
    throw new Error(`Reference image #${index + 1} must declare metadata.role=reference_image.`);
  }
  if (!assetId) throw new Error(`Reference image #${index + 1} is missing metadata.asset_id.`);
  if (!uri) throw new Error(`Reference image #${index + 1} is missing file.uri.`);
  if (!REFERENCE_IMAGE_MIME_TYPES.includes(mimeType as ReferenceImage['mimeType'])) {
    throw new Error(`Reference image #${index + 1} has unsupported MIME type ${mimeType || '(missing)'}.`);
  }

  return {
    assetId,
    uri,
    name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : `reference-${index + 1}`,
    mimeType: mimeType as ReferenceImage['mimeType']
  };
}

function normalizeRequest(input: ProviderExecutorInput): NormalizedImageRequest {
  const candidates: unknown[] = [...requestPayloads(input.request)];
  if (input.content?.trim()) candidates.push(input.content.trim());

  let prompt = '';
  let aspectRatio: ImageGenerationOptions['aspect_ratio'];
  let quality: ImageGenerationOptions['quality'];

  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? parseJson(candidate) ?? candidate : candidate;
    if (typeof value === 'string' && !prompt) {
      prompt = value.trim();
      continue;
    }
    if (!isRecord(value)) continue;
    if (!prompt && typeof value.prompt === 'string') prompt = value.prompt.trim();
    const rawRatio = value.aspect_ratio ?? value.aspectRatio;
    if (rawRatio === '1:1' || rawRatio === '3:2' || rawRatio === '2:3') aspectRatio = rawRatio;
    if (value.quality === 'low' || value.quality === 'medium' || value.quality === 'high') quality = value.quality;
  }

  if (!prompt) throw new Error('Image generation requires a non-empty prompt.');
  if (prompt.length > 4000) throw new Error('Image generation prompt must not exceed 4000 characters.');
  const referenceImages = requestParts(input.request)
    .map((part, index) => normalizeReferenceImage(part, index))
    .filter((image): image is ReferenceImage => Boolean(image));
  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Image editing supports at most ${MAX_REFERENCE_IMAGES} reference images.`);
  }
  const duplicateAsset = referenceImages.find((image, index) =>
    referenceImages.findIndex((candidate) => candidate.assetId === image.assetId) !== index
  );
  if (duplicateAsset) throw new Error(`Duplicate reference image asset: ${duplicateAsset.assetId}.`);
  return {
    prompt,
    aspect_ratio: aspectRatio || '1:1',
    quality: quality || 'medium',
    referenceImages
  };
}

function imageSize(aspectRatio: ImageGenerationOptions['aspect_ratio']) {
  if (aspectRatio === '3:2') return '1536x1024';
  if (aspectRatio === '2:3') return '1024x1536';
  return '1024x1024';
}

function decodeBase64(value: string) {
  const normalized = value.replace(/^data:image\/png;base64,/i, '');
  const maximumEncodedLength = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4;
  if (
    normalized.length > maximumEncodedLength ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new Error('Image provider returned invalid or oversized base64 image data.');
  }
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function assertPng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength === 0) throw new Error('Image provider returned an empty image.');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds the 30 MB asset limit.');
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Image provider returned data that is not a PNG image.');
  }
}

function detectedImageMimeType(bytes: Uint8Array): ReferenceImage['mimeType'] | null {
  if (
    bytes.byteLength >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  ) return 'image/png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

function safeReferenceFilename(index: number, mimeType: ReferenceImage['mimeType']) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  return `reference-${index + 1}.${extension}`;
}

function allowedReferenceHosts(options: UnknownRecord, platformBaseUrl: string) {
  const configured = stringListOption(
    options,
    'referenceImageHosts',
    process.env.MOMOAI_REFERENCE_IMAGE_HOSTS || ''
  );
  if (configured.length) return configured;
  try {
    return [new URL(platformBaseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

function validateReferenceUrl(uri: string, allowedHosts: string[], index: number) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`Reference image #${index + 1} has an invalid URI.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`Reference image #${index + 1} must use a plain HTTPS URI.`);
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`Reference image #${index + 1} host is not allowlisted.`);
  }
  return url;
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
  label = 'Reference image'
) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the allowed size.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the allowed size.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadReferenceImage(
  image: ReferenceImage,
  index: number,
  hosts: string[],
  signal: AbortSignal
) {
  const url = validateReferenceUrl(image.uri, hosts, index);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: REFERENCE_IMAGE_MIME_TYPES.join(', ') },
    redirect: 'error',
    signal
  });
  if (!response.ok) await responseError(response, `Reference image #${index + 1} download`);
  const bytes = await readLimitedBody(response, MAX_REFERENCE_IMAGE_BYTES);
  const detectedMimeType = detectedImageMimeType(bytes);
  if (!detectedMimeType) throw new Error(`Reference image #${index + 1} is not a supported image file.`);
  const responseMimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (responseMimeType && responseMimeType !== detectedMimeType) {
    throw new Error(`Reference image #${index + 1} response MIME type does not match its contents.`);
  }
  if (image.mimeType !== detectedMimeType) {
    throw new Error(`Reference image #${index + 1} declared MIME type does not match its contents.`);
  }
  return { bytes, mimeType: detectedMimeType };
}

async function responseError(response: Response, label: string) {
  let detail = '';
  try {
    const body = await response.json() as unknown;
    if (isRecord(body)) {
      const error = isRecord(body.error) ? body.error : body;
      detail = typeof error.message === 'string' ? error.message : '';
    }
  } catch {
    // Do not echo arbitrary HTML or secrets from an upstream response.
  }
  throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function generatedPng(response: Response, signal: AbortSignal) {
  if (!response.ok) await responseError(response, 'Image generation');
  if (signal.aborted) throw signal.reason;
  const encodedBody = await readLimitedBody(
    response,
    MAX_PROVIDER_JSON_BYTES,
    'Image provider response'
  );
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(encodedBody));
  } catch {
    throw new Error('Image provider returned invalid JSON.');
  }
  const first = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
  if (!isRecord(first)) throw new Error('Image provider returned no image data.');

  let bytes: Uint8Array;
  if (typeof first.b64_json === 'string' && first.b64_json) {
    bytes = decodeBase64(first.b64_json);
  } else if (typeof first.url === 'string' && first.url) {
    throw new Error('Image provider URL outputs are disabled; b64_json is required.');
  } else {
    throw new Error('Image provider returned neither b64_json nor an image URL.');
  }
  assertPng(bytes);
  return bytes;
}

async function uploadAsset(
  platformBaseUrl: string,
  invocationToken: string,
  bytes: Uint8Array,
  signal: AbortSignal
) {
  const form = new FormData();
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  form.append('file', new Blob([blobBytes.buffer], { type: 'image/png' }), 'generated.png');
  form.append('output_index', '0');
  const response = await fetch(`${withoutTrailingSlash(platformBaseUrl)}/api/a2a/provider/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${invocationToken}` },
    body: form,
    signal
  });
  if (!response.ok) await responseError(response, 'MOMOAI asset upload');
  const body = await response.json() as unknown;
  const asset = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(asset) || typeof asset.id !== 'string' || !asset.id.trim()) {
    throw new Error('MOMOAI asset upload returned an invalid response.');
  }
  const accessUrl = typeof asset.access_url === 'string' && asset.access_url
    ? asset.access_url
    : `/api/media/${encodeURIComponent(asset.id)}/content`;
  return {
    asset_id: asset.id,
    url: new URL(accessUrl, `${withoutTrailingSlash(platformBaseUrl)}/`).toString(),
    expires_at: typeof asset.expires_at === 'string' ? asset.expires_at : undefined
  };
}

export async function execute(input: ProviderExecutorInput) {
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported provider executor protocol: ${String(input.protocolVersion)}`);
  }
  if (!input.invocationToken) throw new Error('Missing MOMOAI invocation token for asset upload.');

  const options = input.options || {};
  const providerBaseUrl = stringOption(
    options,
    'baseUrl',
    process.env.MOMOAI_IMAGE_BASE_URL || DEFAULT_PROVIDER_BASE_URL
  );
  const platformBaseUrl = stringOption(
    options,
    'platformBaseUrl',
    process.env.MOMOAI_API_URL || DEFAULT_PLATFORM_BASE_URL
  );
  const model = stringOption(options, 'model', process.env.MOMOAI_IMAGE_MODEL || DEFAULT_MODEL);
  const apiKey = resolveApiKey(options);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const request = normalizeRequest(input);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Image generation timed out.')), timeoutMs);
  try {
    let response: Response;
    if (request.referenceImages.length) {
      const hosts = allowedReferenceHosts(options, platformBaseUrl);
      const references = [];
      for (let index = 0; index < request.referenceImages.length; index += 1) {
        references.push(await downloadReferenceImage(
          request.referenceImages[index],
          index,
          hosts,
          controller.signal
        ));
      }
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', request.prompt);
      form.append('n', '1');
      form.append('size', imageSize(request.aspect_ratio));
      form.append('quality', request.quality || 'medium');
      form.append('output_format', 'png');
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        const copy = new Uint8Array(reference.bytes.byteLength);
        copy.set(reference.bytes);
        form.append(
          'image[]',
          new Blob([copy.buffer], { type: reference.mimeType }),
          safeReferenceFilename(index, reference.mimeType)
        );
      }
      response = await fetch(`${withoutTrailingSlash(providerBaseUrl)}/images/edits`, {
        method: 'POST',
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: form,
        signal: controller.signal
      });
    } else {
      response = await fetch(`${withoutTrailingSlash(providerBaseUrl)}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          n: 1,
          size: imageSize(request.aspect_ratio),
          quality: request.quality,
          output_format: 'png'
        }),
        signal: controller.signal
      });
    }
    const bytes = await generatedPng(response, controller.signal);
    const asset = await uploadAsset(platformBaseUrl, input.invocationToken, bytes, controller.signal);

    const filePart = {
      kind: 'file',
      file: {
        name: 'generated.png',
        mimeType: 'image/png',
        uri: asset.url
      },
      metadata: {
        asset_id: asset.asset_id,
        expires_at: asset.expires_at,
        aspect_ratio: request.aspect_ratio,
        quality: request.quality,
        model
      }
    };

    return {
      state: 'TASK_STATE_COMPLETED',
      taskId: input.taskId,
      contextId: input.contextId,
      message: { role: 'agent', parts: [filePart] },
      artifacts: [{ name: 'generated-image', parts: [filePart] }],
      metadata: { asset_id: asset.asset_id, output_count: 1 }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default execute;
