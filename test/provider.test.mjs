import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../dist/index.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

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

test('rejects non-PNG provider output before upload', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })
  );
  await assert.rejects(() => execute(input()), /not a PNG/);
});

test('requires the invocation token used for caller-owned assets', async () => {
  await assert.rejects(() => execute({ ...input(), invocationToken: undefined }), /invocation token/);
});
