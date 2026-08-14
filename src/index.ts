import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = 'momoai.provider-executor.v1';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_PLATFORM_BASE_URL = 'https://momoai.pro';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

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

function requestPayloads(request: unknown): unknown[] {
  if (!isRecord(request)) return [];
  const params = isRecord(request.params) ? request.params : {};
  const message = isRecord(params.message) ? params.message : {};
  const output: unknown[] = [];
  for (const part of Array.isArray(message.parts) ? message.parts : []) collectPartPayloads(part, output);
  for (const part of Array.isArray(params.parts) ? params.parts : []) collectPartPayloads(part, output);
  return output;
}

function normalizeRequest(input: ProviderExecutorInput): ImageGenerationOptions {
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
  return { prompt, aspect_ratio: aspectRatio || '1:1', quality: quality || 'medium' };
}

function imageSize(aspectRatio: ImageGenerationOptions['aspect_ratio']) {
  if (aspectRatio === '3:2') return '1536x1024';
  if (aspectRatio === '2:3') return '1024x1536';
  return '1024x1024';
}

function decodeBase64(value: string) {
  const normalized = value.replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '');
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
  const body = await response.json() as unknown;
  const first = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
  if (!isRecord(first)) throw new Error('Image provider returned no image data.');

  let bytes: Uint8Array;
  if (typeof first.b64_json === 'string' && first.b64_json) {
    bytes = decodeBase64(first.b64_json);
  } else if (typeof first.url === 'string' && first.url) {
    const imageResponse = await fetch(first.url, { signal });
    if (!imageResponse.ok) await responseError(imageResponse, 'Generated image download');
    bytes = new Uint8Array(await imageResponse.arrayBuffer());
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
  if (!isRecord(asset) || typeof asset.id !== 'string' || typeof asset.access_url !== 'string') {
    throw new Error('MOMOAI asset upload returned an invalid response.');
  }
  return {
    asset_id: asset.id,
    url: new URL(asset.access_url, `${withoutTrailingSlash(platformBaseUrl)}/`).toString(),
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
    const response = await fetch(`${withoutTrailingSlash(providerBaseUrl)}/images/generations`, {
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
