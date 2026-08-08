const CACHE = 'secure-ai-chat-v6';
const SHELL = [
  '/',
  '/index.html',
  '/app',
  '/aichat.html',
  '/styles.css',
  '/page.css',
  '/app.js',
  '/favicon.svg',
  '/site.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const STATIC_PAGES = [
  '/about', '/features', '/faq', '/security',
  '/providers', '/privacy', '/terms', '/changelog', '/docs'
];

self.addEventListener('install', event =>
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
);

self.addEventListener('activate', event =>
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    const isStaticPage = url.pathname === '/' || STATIC_PAGES.includes(url.pathname);
    if (isStaticPage) {
      // Landing + SEO pages: network first, cache fallback
      event.respondWith(
        fetch(event.request).then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
          return response;
        }).catch(() => caches.match(event.request))
      );
      return;
    }
    // Chat app (/app): network first, fall back to cached aichat.html
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match('/aichat.html'))
    );
    return;
  }

  // Static assets: cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(response => {
        if (response.ok && url.origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
    )
  );
});
