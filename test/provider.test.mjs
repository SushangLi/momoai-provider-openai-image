import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../dist/index.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const webp = Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);

function input(content = JSON.stringify({ prompt: 'a small robot', aspect_ratio: '3:2', quality: 'high' })) {
  return {
    protocolVersion: 'momoai.provider-executor.v1',
    content,
    taskId: 'task-1',
    contextId: 'context-1',
    invocationToken: 'short-lived-token',
    options: {
      baseUrl: 'http://cliproxy.test/v1',
      platformBaseUrl: 'https://momoai.test',
      model: 'gpt-image-2'
    }
  };
}

function referencePart(assetId, uri, mimeType) {
  return {
    kind: 'file',
    file: { uri, mimeType, name: `${assetId}.image` },
    metadata: { asset_id: assetId, role: 'reference_image' }
  };
}

function editInput(parts) {
  return {
    ...input(),
    content: undefined,
    request: {
      params: {
        message: {
          role: 'user',
          parts: [
            { kind: 'data', data: { prompt: 'combine these references', aspect_ratio: '2:3', quality: 'low' } },
            ...parts
          ]
        }
      }
    },
    options: {
      ...input().options,
      referenceImageHosts: ['assets.test']
    }
  };
}

test('generates one PNG and uploads it as a caller asset', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/images/generations')) {
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
    }
    return Response.json({ success: true, data: {
      id: 'asset-42',
      access_url: '/api/media/asset-42/content',
      expires_at: '2026-08-17T00:00:00.000Z'
    } });
  });

  const result = await execute(input());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://cliproxy.test/v1/images/generations');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'gpt-image-2',
    prompt: 'a small robot',
    n: 1,
    size: '1536x1024',
    quality: 'high',
    output_format: 'png'
  });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].url, 'https://momoai.test/api/a2a/provider/assets');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer short-lived-token');
  assert.equal(result.state, 'TASK_STATE_COMPLETED');
  assert.equal(result.artifacts[0].parts[0].metadata.asset_id, 'asset-42');
  assert.equal(result.artifacts[0].parts[0].file.mimeType, 'image/png');
});

test('accepts a plain text prompt with defaults', async (t) => {
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/images/generations')) {
      requestBody = JSON.parse(init.body);
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
    }
    return Response.json({ success: true, data: { id: 'asset-7', access_url: '/api/media/asset-7/content' } });
  });
  await execute(input('draw a lighthouse'));
  assert.equal(requestBody.prompt, 'draw a lighthouse');
  assert.equal(requestBody.size, '1024x1024');
  assert.equal(requestBody.quality, 'medium');
});

test('downloads ordered A2A file parts and sends them to images/edits', async (t) => {
  const calls = [];
  let editForm;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://assets.test/first.png') {
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    if (String(url) === 'https://assets.test/second.webp') {
      return new Response(webp, { headers: { 'content-type': 'image/webp' } });
    }
    if (String(url).endsWith('/images/edits')) {
      editForm = init.body;
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
    }
    return Response.json({ success: true, data: { id: 'asset-edit', access_url: '/api/media/asset-edit/content' } });
  });

  await execute(editInput([
    referencePart('asset-first', 'https://assets.test/first.png', 'image/png'),
    referencePart('asset-second', 'https://assets.test/second.webp', 'image/webp')
  ]));

  assert.deepEqual(calls.map((call) => call.url), [
    'https://assets.test/first.png',
    'https://assets.test/second.webp',
    'http://cliproxy.test/v1/images/edits',
    'https://momoai.test/api/a2a/provider/assets'
  ]);
  assert.ok(editForm instanceof FormData);
  assert.equal(editForm.get('model'), 'gpt-image-2');
  assert.equal(editForm.get('prompt'), 'combine these references');
  assert.equal(editForm.get('size'), '1024x1536');
  assert.equal(editForm.get('quality'), 'low');
  const images = editForm.getAll('image[]');
  assert.equal(images.length, 2);
  assert.equal(images[0].name, 'reference-1.png');
  assert.equal(images[0].type, 'image/png');
  assert.equal(images[1].name, 'reference-2.webp');
  assert.equal(images[1].type, 'image/webp');
  assert.equal(calls[2].init.headers['Content-Type'], undefined);
});

test('prefers canonical message parts over legacy params parts', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url) === 'https://assets.test/canonical.png') {
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    if (String(url).endsWith('/images/edits')) {
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
    }
    return Response.json({ success: true, data: { id: 'asset-canonical', access_url: null } });
  });

  const request = editInput([
    referencePart('asset-canonical', 'https://assets.test/canonical.png', 'image/png')
  ]);
  request.request.params.parts = [
    referencePart('asset-shadow', 'https://assets.test/shadow.png', 'image/png')
  ];
  const result = await execute(request);
  assert.equal(calls.includes('https://assets.test/shadow.png'), false);
  assert.equal(result.artifacts[0].parts[0].file.uri, 'https://momoai.test/api/media/asset-canonical/content');
});

test('rejects non-allowlisted reference hosts before downloading', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not run');
  });
  await assert.rejects(
    () => execute(editInput([referencePart('asset-1', 'https://untrusted.test/image.png', 'image/png')])),
    /not allowlisted/
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects more than 16 reference images before downloading', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not run');
  });
  const parts = Array.from({ length: 17 }, (_, index) =>
    referencePart(`asset-${index}`, `https://assets.test/${index}.png`, 'image/png')
  );
  await assert.rejects(() => execute(editInput(parts)), /at most 16/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects a reference whose declared MIME does not match its bytes', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(webp, { headers: { 'content-type': 'image/webp' } })
  );
  await assert.rejects(
    () => execute(editInput([referencePart('asset-1', 'https://assets.test/image.png', 'image/png')])),
    /declared MIME type does not match/
  );
});

test('rejects non-PNG provider output before upload', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })
  );
  await assert.rejects(() => execute(input()), /not a PNG/);
});

test('rejects provider URL outputs instead of fetching arbitrary URLs', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/images/generations')) {
      return Response.json({ data: [{ url: 'http://127.0.0.1/private.png' }] });
    }
    throw new Error('unexpected fetch');
  });
  await assert.rejects(() => execute(input()), /URL outputs are disabled/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('rejects oversized base64 before decoding or uploading', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: [{ b64_json: 'A'.repeat(42 * 1024 * 1024) }] })
  );
  await assert.rejects(
    () => execute(input()),
    /provider response exceeds the allowed size|invalid or oversized base64/
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('requires the invocation token used for caller-owned assets', async () => {
  await assert.rejects(() => execute({ ...input(), invocationToken: undefined }), /invocation token/);
});

test('loads a provider key from a local-only file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'momoai-image-provider-'));
  const keyFile = join(directory, 'provider-key');
  await writeFile(keyFile, 'local-provider-key\n', { mode: 0o600 });
  let authorization;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/images/generations')) {
      authorization = init.headers.Authorization;
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
    }
    return Response.json({ success: true, data: { id: 'asset-8', access_url: '/api/media/asset-8/content' } });
  });
  await execute({ ...input(), options: { ...input().options, apiKeyFile: keyFile } });
  assert.equal(authorization, 'Bearer local-provider-key');
});
