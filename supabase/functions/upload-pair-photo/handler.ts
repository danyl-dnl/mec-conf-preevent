export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
type Dependencies = { env: (name: string) => string | undefined; fetch: typeof fetch };
class UploadError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Do not trust MIME alone. Cloudinary's image decoder performs final validation.
export async function isPhoto(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (file.type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (file.type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  if (file.type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (file.type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (['image/heic', 'image/heif', 'image/avif'].includes(file.type) && ascii(4, 8) === 'ftyp') {
    const brands = file.type === 'image/avif' ? ['avif', 'avis'] : ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];
    return brands.some(brand => ascii(8, 64).includes(brand));
  }
  return false;
}

async function readPhoto(request: Request): Promise<File> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;') || !request.body) {
    throw new UploadError(400, 'INVALID_FILE', 'Choose one photo to upload.');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new UploadError(413, 'FILE_TOO_LARGE', 'Photo must be 5 MB or smaller.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new UploadError(413, 'FILE_TOO_LARGE', 'Photo must be 5 MB or smaller.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new UploadError(400, 'INVALID_FILE', 'Choose one photo to upload.'); }
  const entries = [...form.entries()];
  // Reject identity fields rather than ever forwarding browser-chosen identity.
  if (entries.length !== 1 || entries[0][0] !== 'photo' || !(entries[0][1] instanceof File)) {
    throw new UploadError(400, 'INVALID_FILE', 'Choose one photo to upload.');
  }
  const photo = entries[0][1];
  if (photo.size > MAX_PHOTO_BYTES) throw new UploadError(413, 'FILE_TOO_LARGE', 'Photo must be 5 MB or smaller.');
  if (photo.size === 0 || !(await isPhoto(photo))) {
    throw new UploadError(415, 'INVALID_FILE', 'Use a JPEG, PNG, WebP, GIF, HEIC, HEIF, or AVIF photo.');
  }
  return photo;
}

export function createUploadHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    let reservation: { actor: string; token: string } | undefined;
    const url = deps.env('SUPABASE_URL');
    const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
    async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
      const response = await deps.fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new UploadError(503, 'UPLOAD_UNCONFIRMED', 'Upload could not be confirmed. Refresh status before retrying.');
      return response.status === 204 ? null : response.json();
    }
    try {
      const authorization = request.headers.get('authorization');
      if (!authorization || !/^Bearer \S+$/i.test(authorization)) throw new UploadError(401, 'UNAUTHENTICATED', 'Please sign in again.');
      if (!url || !serviceKey) throw new UploadError(503, 'UPLOAD_NOT_CONFIGURED', 'Photo upload is not configured. Contact an organizer.');
      // Online Auth validation, not decoding an untrusted JWT payload.
      const auth = await deps.fetch(`${url}/auth/v1/user`, {
        headers: { apikey: deps.env('SUPABASE_ANON_KEY') || serviceKey, Authorization: authorization },
        signal: AbortSignal.timeout(10000),
      });
      if (!auth.ok) throw new UploadError(401, 'UNAUTHENTICATED', 'Please sign in again.');
      const user: unknown = await auth.json();
      if (!record(user) || !uuid(user.id) || user.is_anonymous === true) throw new UploadError(401, 'UNAUTHENTICATED', 'Please sign in again.');
      const photo = await readPhoto(request);
      const cloud = deps.env('CLOUDINARY_CLOUD_NAME');
      const key = deps.env('CLOUDINARY_API_KEY');
      const secret = deps.env('CLOUDINARY_API_SECRET');
      if (!cloud || !/^[a-zA-Z0-9_-]+$/.test(cloud) || !key || !secret) {
        throw new UploadError(503, 'UPLOAD_NOT_CONFIGURED', 'Photo upload is not configured. Contact an organizer.');
      }
      const claim = await rpc('begin_pair_photo_upload', { actor_user_id: user.id });
      if (record(claim) && claim.status === 'ALREADY_COMPLETED') throw new UploadError(409, 'ALREADY_COMPLETED', 'Your pair has already completed Level 1. Refresh status.');
      if (record(claim) && claim.status === 'UPLOAD_IN_PROGRESS') throw new UploadError(409, 'UPLOAD_IN_PROGRESS', 'A pair photo upload is in progress. Refresh status shortly.');
      if (record(claim) && claim.status === 'NOT_ELIGIBLE') throw new UploadError(403, 'NOT_ELIGIBLE', 'Both participants must verify and solve the puzzle before uploading.');
      if (!record(claim) || claim.status !== 'RESERVED' || !uuid(claim.upload_token) ||
          typeof claim.photo_public_id !== 'string' || !/^mec-level1\/[0-9a-f-]{36}$/.test(claim.photo_public_id)) {
        throw new UploadError(503, 'UPLOAD_UNCONFIRMED', 'Could not start upload. Please refresh status.');
      }
      reservation = { actor: user.id, token: claim.upload_token };
      const params: Record<string, string> = {
        allowed_formats: 'jpg,png,webp,gif,heic,heif,avif', format: 'jpg', overwrite: 'false',
        public_id: claim.photo_public_id, timestamp: String(Math.floor(Date.now() / 1000)),
      };
      const canonical = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
      // Cloudinary's default signing algorithm is SHA-1 (produces a 40-char hex digest).
      // SHA-256 produces a 64-char digest that Cloudinary rejects with 401 Invalid Signature.
      const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(canonical + secret));
      const signature = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
      const upload = new FormData();
      for (const [name, value] of Object.entries(params)) upload.set(name, value);
      upload.set('api_key', key); upload.set('signature', signature);
      upload.set('file', photo, 'pair-photo');
      const response = await deps.fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
        method: 'POST', body: upload, signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        // Safe diagnostic: log Cloudinary's status and error message only — never credentials or signature.
        try {
          const errBody: unknown = await response.clone().json();
          const errMsg = (errBody && typeof errBody === 'object' && 'error' in errBody &&
            errBody.error && typeof errBody.error === 'object' && 'message' in errBody.error)
            ? String((errBody.error as Record<string, unknown>).message) : '(no message)';
          console.error(`[upload-pair-photo] Cloudinary rejected upload: HTTP ${response.status} – ${errMsg}`);
        } catch { console.error(`[upload-pair-photo] Cloudinary rejected upload: HTTP ${response.status}`); }
        throw new UploadError(502, 'UPLOAD_FAILED', 'Photo upload failed. Please retry with a valid photo.');
      }
      const asset: unknown = await response.json();
      if (!record(asset) || asset.public_id !== claim.photo_public_id || asset.resource_type !== 'image' ||
          asset.format !== 'jpg' || typeof asset.secure_url !== 'string') {
        throw new UploadError(502, 'UPLOAD_FAILED', 'Photo upload could not be confirmed. Please retry.');
      }
      const assetUrl = new URL(asset.secure_url);
      if (assetUrl.protocol !== 'https:' || assetUrl.host !== 'res.cloudinary.com' ||
          !assetUrl.pathname.startsWith(`/${cloud}/image/upload/`) ||
          !assetUrl.pathname.endsWith(`/${claim.photo_public_id}.jpg`)) {
        throw new UploadError(502, 'UPLOAD_FAILED', 'Photo upload could not be confirmed. Please retry.');
      }
      const completed = await rpc('finalize_pair_photo_upload', {
        actor_user_id: user.id, upload_token: claim.upload_token,
        photo_url: asset.secure_url, photo_public_id: asset.public_id,
      });
      if (!record(completed) || completed.status !== 'COMPLETED' || typeof completed.completed_at !== 'string' ||
          !Number.isFinite(Date.parse(completed.completed_at))) {
        throw new UploadError(503, 'UPLOAD_UNCONFIRMED', 'Refresh status to confirm completion.');
      }
      reservation = undefined;
      // No IDs, URL, Cloudinary metadata, signatures, or credentials reach the browser.
      return json(200, { status: 'COMPLETED', completed_at: completed.completed_at });
    } catch (error) {
      if (reservation) {
        try { await rpc('release_pair_photo_upload', { actor_user_id: reservation.actor, upload_token: reservation.token }); }
        catch { /* The reservation expires after five minutes; retries retain the same asset ID. */ }
      }
      if (error instanceof UploadError) return json(error.status, { code: error.code, message: error.message });
      return json(503, { code: 'UPLOAD_UNCONFIRMED', message: 'Upload could not be confirmed. Refresh status before retrying.' });
    }
  };
}
