const CACHE_VERSION = 'fc3237385ec6b7a8d3d5eb669f1e2e784bd824db75df8982cde46d287dae63ff';
const PRECACHE = [{"path":"./index.html","sha256":"9fea34b4268aec19e3068b65d7302dfee04be303cfbf1fb718e055d08d272c49"},{"path":"./manifest.webmanifest","sha256":"7870a038d1c1e3738dc29c8225102615596cf8f4c78d34b108960dafbc95ac20"},{"path":"./icons/icon-192.png","sha256":"4e14004973e99a08138231cc32ab9ea447548c05bce132d65b7b79214e701534"},{"path":"./icons/icon-512.png","sha256":"6fc604870442fb572bb4bb9990122b32f0393757a5b5ec557fb331d4d27dd29a"},{"path":"./icons/apple-touch-icon.png","sha256":"8672fc11bf213b7528674f730d4c133098ba39e9c9e2c9b00b49adeee709a435"}];
const APP_SCOPE = self.registration.scope;
const CACHE_PREFIX = `qisma-offline:${encodeURIComponent(APP_SCOPE)}:`;
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const ASSETS = new Map(PRECACHE.map(asset => [new URL(asset.path, APP_SCOPE).href, asset]));
const INDEX_URL = new URL('./index.html', APP_SCOPE).href;
let preparation;

async function verifiedDownload(url) {
  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error('Offline asset unavailable.');
  const bytes = await response.clone().arrayBuffer();
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (checksum !== ASSETS.get(url).sha256) throw new Error('Offline asset version mismatch.');
  return response;
}

function prepareOffline() {
  preparation ??= populateOfflineCache().finally(() => { preparation = null; });
  return preparation;
}

async function populateOfflineCache() {
  const existed = (await caches.keys()).includes(CACHE_NAME);
  try {
    const downloads = await Promise.all([...ASSETS.keys()].map(async url => [url, await verifiedDownload(url)]));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(downloads.map(([url, response]) => cache.put(url, response)));
  } catch (error) {
    // A failed repair must not remove assets the active worker can still serve.
    if (!existed) await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function offlineReady() {
  if (!(await caches.keys()).includes(CACHE_NAME)) return false;
  const cache = await caches.open(CACHE_NAME);
  return (await Promise.all([...ASSETS.keys()].map(url => cache.match(url)))).every(Boolean);
}

self.addEventListener('message', event => {
  const port = event.ports?.[0], type = event.data?.type;
  if (!port || !['QISMA_OFFLINE_STATUS', 'QISMA_PREPARE_OFFLINE'].includes(type)) return;
  event.waitUntil((async () => {
    let ready = false, failed = false;
    try {
      if (type === 'QISMA_PREPARE_OFFLINE' && !await offlineReady()) await prepareOffline();
      ready = await offlineReady();
    } catch { failed = true; }
    try { port.postMessage({ type: 'QISMA_OFFLINE_STATUS', ready, version: CACHE_VERSION, scope: APP_SCOPE, ...(failed ? { error: true } : {}) }); } catch { /* The requesting page may have closed. */ }
  })());
});

self.addEventListener('install', event => event.waitUntil(prepareOffline()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url), withoutQuery = new URL(url.href);
  withoutQuery.search = ''; withoutQuery.hash = '';
  const target = request.mode === 'navigate' && (withoutQuery.href === APP_SCOPE || withoutQuery.href === INDEX_URL)
    ? INDEX_URL : ASSETS.has(url.href) ? url.href : null;
  if (!target) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => await cache.match(target) || fetch(target)));
});
