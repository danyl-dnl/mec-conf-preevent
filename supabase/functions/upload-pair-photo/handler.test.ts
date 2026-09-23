import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUploadHandler, MAX_PHOTO_BYTES } from './handler.ts';

const actor = '11111111-1111-4111-8111-111111111111';
const token = '22222222-2222-4222-8222-222222222222';
const publicId = 'mec-level1/33333333-3333-4333-8333-333333333333';
const completedAt = '2026-09-23T15:00:00Z';
const photo = () => new File([new Uint8Array([255, 216, 255, 224, 1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
function request(file = photo(), extraIdentity = false) {
  const body = new FormData(); body.set('photo', file);
  if (extraIdentity) body.set('pair_id', 'chosen-by-browser');
  return new Request('https://example.test/upload', { method: 'POST', headers: { Authorization: 'Bearer test-user-token' }, body });
}
function harness(options: { claim?: string; missingCloud?: boolean; authFail?: boolean; uploadFail?: boolean; finalizeFail?: boolean; wrongAsset?: boolean } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://supabase.example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-only',
    CLOUDINARY_CLOUD_NAME: 'test-cloud', CLOUDINARY_API_KEY: 'test-api-key', CLOUDINARY_API_SECRET: 'test-api-secret',
  };
  if (options.missingCloud) delete env.CLOUDINARY_API_SECRET;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: actor }, { status: options.authFail ? 401 : 200 });
    if (url.endsWith('/begin_pair_photo_upload')) return Response.json({ status: options.claim ?? 'RESERVED', upload_token: token, photo_public_id: publicId });
    if (url.includes('api.cloudinary.com')) {
      assert.ok(body instanceof FormData);
      assert.equal(body.get('overwrite'), 'false');
      assert.equal(body.get('public_id'), publicId);
      assert.equal(body.get('format'), 'jpg');
      // Cloudinary uses SHA-1 by default: 40-char hex digest.
      // Regression: SHA-256 (64-char) was previously used and caused HTTP 401 Invalid Signature → 502.
      assert.match(String(body.get('signature')), /^[a-f0-9]{40}$/);
      assert.equal(body.has('api_secret'), false);
      return Response.json({ resource_type: 'image', format: 'jpg', public_id: options.wrongAsset ? 'other' : publicId,
        secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${publicId}.jpg` }, { status: options.uploadFail ? 400 : 200 });
    }
    if (url.endsWith('/finalize_pair_photo_upload')) return Response.json({ status: 'COMPLETED', completed_at: completedAt }, { status: options.finalizeFail ? 500 : 200 });
    if (url.endsWith('/release_pair_photo_upload')) return new Response(null, { status: 204 });
    throw new Error('Unexpected network destination');
  };
  return { handler: createUploadHandler({ env: name => env[name], fetch: fakeFetch }), calls };
}

test('rejects absent and invalid authentication before upload', async () => {
  const absent = harness();
  assert.equal((await absent.handler(new Request('https://example.test', { method: 'POST' }))).status, 401);
  assert.equal(absent.calls.length, 0);
  const invalid = harness({ authFail: true });
  assert.equal((await invalid.handler(request())).status, 401);
  assert.equal(invalid.calls.length, 1);
});
test('rejects non-images, spoofed images, empty files, and identity parameters', async () => {
  for (const file of [new File(['text'], 'text.txt', { type: 'text/plain' }), new File(['<svg/>'], 'photo.jpg', { type: 'image/jpeg' }), new File([], 'empty.jpg', { type: 'image/jpeg' })]) {
    const { handler, calls } = harness();
    assert.equal((await handler(request(file))).status, 415);
    assert.equal(calls.length, 1);
  }
  const { handler, calls } = harness();
  assert.equal((await handler(request(photo(), true))).status, 400);
  assert.equal(calls.length, 1);
});
test('rejects oversized photos without trusting Content-Length', async () => {
  const { handler, calls } = harness();
  const file = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'large.jpg', { type: 'image/jpeg' });
  assert.equal((await handler(request(file))).status, 413);
  assert.equal(calls.length, 1);
  const huge = new File([new Uint8Array(MAX_PHOTO_BYTES + 100000)], 'large.jpg', { type: 'image/jpeg' });
  // Buffer Node's multipart encoder: cancelling its live File stream triggers an undici bug.
  const multipart = request(huge);
  const body = await multipart.arrayBuffer();
  assert.equal((await handler(new Request(multipart.url, { method: 'POST', headers: multipart.headers, body }))).status, 413);
});
test('missing Cloudinary configuration fails safely without claiming or uploading', async () => {
  const { handler, calls } = harness({ missingCloud: true });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'UPLOAD_NOT_CONFIGURED');
  assert.equal(calls.length, 1);
});
test('rejects unsolved, completed, and concurrent pair states before Cloudinary', async () => {
  for (const [claim, status] of [['NOT_ELIGIBLE', 403], ['ALREADY_COMPLETED', 409], ['UPLOAD_IN_PROGRESS', 409]] as const) {
    const { handler, calls } = harness({ claim });
    assert.equal((await handler(request())).status, status);
    assert.equal(calls.length, 2);
  }
});
test('successful upload uses server identity and returns no internal data', async () => {
  const { handler, calls } = harness();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'COMPLETED', completed_at: completedAt });
  assert.deepEqual(calls[1].body, { actor_user_id: actor });
  assert.deepEqual(calls.at(-1)?.body, { actor_user_id: actor, upload_token: token, photo_public_id: publicId,
    photo_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${publicId}.jpg` });
});
test('failed upload/finalization or mismatched asset releases only its reservation', async () => {
  for (const options of [{ uploadFail: true }, { finalizeFail: true }, { wrongAsset: true }]) {
    const { handler, calls } = harness(options);
    const response = await handler(request());
    assert.ok(response.status >= 500);
    assert.ok(calls.at(-1)?.url.endsWith('/release_pair_photo_upload'));
    assert.deepEqual(calls.at(-1)?.body, { actor_user_id: actor, upload_token: token });
    const output = JSON.stringify(await response.json());
    for (const secret of [actor, token, publicId, 'test-service-only', 'test-api-secret']) assert.equal(output.includes(secret), false);
  }
});
test('CORS preflight succeeds and other methods do not mutate', async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handler(new Request('https://example.test'))).status, 405);
  assert.equal(calls.length, 0);
});
