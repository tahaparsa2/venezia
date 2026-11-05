// Offline shell. Caches the app itself so an installed Venezia opens with no server and can say
// it is not connected. Never touches the API, the streams, evidence or pairing: factory state
// is only ever live. Plain Node serves this with ETags, so network first is cheap, and a
// reload never mixes old and new modules.

const VERSION = 'venezia-shell-v3';
const NETWORK_WAIT_MS = 2500;

const SHELL = [
  '/', '/index.html', '/deck.html', '/manifest.webmanifest',
  '/css/tokens.css', '/css/base.css', '/css/world.css', '/css/folio.css', '/css/cards.css', '/css/deck.css', '/css/intake.css',
  '/js/main.js', '/js/a11y.js', '/js/commands.js', '/js/layout.js', '/js/store.js', '/js/transport.js',
  '/js/world/index.js', '/js/folio/index.js', '/js/cards/index.js', '/js/deck/index.js', '/js/intake/index.js',
  '/shared/commands.mjs', '/shared/names.mjs', '/shared/reducer.mjs', '/shared/sim.mjs', '/shared/vocabulary.mjs',
  '/fonts/cardo-latin-400-normal.woff2', '/fonts/cardo-latin-400-italic.woff2', '/fonts/cardo-latin-700-normal.woff2',
  '/fonts/dm-mono-latin-400-normal.woff2', '/fonts/dm-mono-latin-500-normal.woff2',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png',
];

/** Only these are the shell. Anything else, the API above all, is left to the network. */
const SHELL_PATHS = /^\/(?:$|index\.html$|deck\.html$|manifest\.webmanifest$|(?:css|js|fonts|icons|shared)\/)/;
const CLIENT_ROUTES = /^\/(?:deck|ships)(?:\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One by one, so one missing file cannot stop the app from going offline-ready.
    await Promise.allSettled(SHELL.map((path) => cache.add(path)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('venezia-shell-') && name !== VERSION).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function pageFor(url) {
  return url.pathname === '/deck' || url.pathname.startsWith('/deck/') ? '/deck.html' : '/index.html';
}

async function networkFirst(request, key) {
  const cache = await caches.open(VERSION);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_WAIT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* The page tells us what it really loaded on its first visit, before this worker had control, so
   the whole app is here for the first offline open and the list can never drift from the code. */
self.addEventListener('message', (event) => {
  const { type, urls } = event.data ?? {};
  if (type !== 'cache-loaded' || !Array.isArray(urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const mine = urls.map((url) => new URL(url, location.origin)).filter((url) => url.origin === location.origin && SHELL_PATHS.test(url.pathname));
    await Promise.allSettled(mine.map((url) => cache.add(url.pathname)));
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || CLIENT_ROUTES.test(url.pathname))) {
    event.respondWith(networkFirst(request, pageFor(url)));
    return;
  }
  if (SHELL_PATHS.test(url.pathname)) event.respondWith(networkFirst(request, url.pathname));
});
