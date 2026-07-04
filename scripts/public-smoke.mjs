import 'dotenv/config';

const baseUrl = normalizeBaseUrl(process.env.PUBLIC_SMOKE_BASE_URL || process.env.PUBLIC_URL);
if (!baseUrl) {
  throw new Error('Set PUBLIC_SMOKE_BASE_URL or PUBLIC_URL before running public smoke.');
}
const bridgeToken = process.env.SMOKE_BRIDGE_TOKEN || process.env.MENTRA_BRIDGE_TOKEN || '';
const reviewToken = process.env.SMOKE_REVIEW_TOKEN || process.env.READWISE_REVIEW_TOKEN || process.env.ALERIO_REVIEW_TOKEN || '';

const headers = bridgeToken ? { 'x-mentra-bridge-token': bridgeToken } : {};
const reviewHeaders = reviewToken ? { 'x-alerio-review-token': reviewToken } : {};
const requestId = `smoke_readwise_${Date.now()}`;
let highlightId = '';

try {
  const manifest = await requestJson('/.well-known/mentra-app.json');
  assert(manifest.packageName === 'com.alerio.mentra.bookreadwise', `unexpected package name: ${manifest.packageName}`);
  assert(manifest.reviewUrl === `${baseUrl}/review`, `unexpected review URL: ${manifest.reviewUrl}`);
  assert(manifest.iconUrl === `${baseUrl}/assets/app-icon.png`, `unexpected icon URL: ${manifest.iconUrl}`);
  assert(manifest.bridgeAuthRequired === true, 'bridge token auth is not required');
  assert(manifest.writeMode === 'dry_run', `refusing public smoke because writeMode is ${manifest.writeMode}`);
  assert(!JSON.stringify(manifest).includes('apiKey'), 'publish manifest leaks apiKey');
  assert(manifest.endpoints?.authCheck === `${baseUrl}/api/bridge-auth-check`, 'manifest auth-check endpoint is wrong');
  assert(manifest.endpoints?.capture?.includes(`${baseUrl}/webhooks/mentra/book-video`), 'manifest is missing video capture endpoint');

  const authCheck = await requestJson('/api/bridge-auth-check', { headers });
  assert(authCheck.ok === true, 'bridge auth check failed');
  assert(authCheck.bridgeAuthRequired === true, 'bridge auth check did not require auth');

  const form = new FormData();
  form.set('requestId', requestId);
  form.set('transcript', 'scan page smoke test');
  form.set('photo', new Blob(['readwise-smoke-page'], { type: 'image/jpeg' }), 'page.jpg');

  const created = await requestJson('/webhooks/mentra/book-page', {
    method: 'POST',
    headers,
    body: form
  });
  highlightId = created.id;

  assert(/^highlight_/.test(highlightId), `unexpected highlight id: ${highlightId}`);
  assert(created.draft?.imageUrl, 'page upload did not return an image URL');
  assert(created.draft?.highlight, 'page upload did not return a highlight draft');

  await requestJson(`/webhooks/mentra/book-page/${encodeURIComponent(highlightId)}/reject`, {
    method: 'POST',
    headers: reviewHeaders
  });

  const { highlights } = await requestJson('/api/highlights', { headers: reviewHeaders });
  assert(!highlights.some((entry) => entry.id === highlightId), 'smoke highlight is still in the queue after reject');

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        manifest: true,
        created: highlightId,
        cleaned: true
      },
      null,
      2
    )
  );
} catch (error) {
  if (highlightId) {
    await requestJson(`/webhooks/mentra/book-page/${encodeURIComponent(highlightId)}/reject`, {
      method: 'POST',
      headers: reviewHeaders
    }).catch(() => {});
  }
  console.error(error.message || error);
  process.exitCode = 1;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? parseJson(text, path) : null;

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${text.slice(0, 500)}`);
  }

  return body;
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 500)}`);
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
