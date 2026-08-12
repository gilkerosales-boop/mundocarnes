// Service Worker para PWA Módulo de Ventas / Facturación - Mundocarnes
const CACHE_NAME = 'mundocarnes-pwa-v1.9.0';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  '../catalog.json',
  '../img/LOGOTIPO MUNDOCARNES.jpg',
  '../img/LOGO-MUNDO123.webp',
  '../img/MUNDOCARNE TRANSPARENTE.png',
  '../img/BOLIVARES.png',
  '../img/DOLARES.png',
  '../img/PAGO%20MOVIL.png',
  '../img/ZELLE.png',
  '../img/PAYPAL.png',
  '../img/PUNTO%20DE%20VENTA.png',
  '../img/BIOPAGO.png',
  '../img/CASHEA.png',
  '../img/PAGOS%20MIXTOS.png',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Aviso SW: Algunos recursos estáticos no pudieron ser almacenados en caché:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ignorar solicitudes que no sean GET (como las llamadas API POST)
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Devuelve la respuesta almacenada en caché e intenta actualizar en segundo plano
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {/* Ignorar errores de red offline */});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => {
        // Retorno de contingencia offline si es navegación HTML
        if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
          return caches.match('index.html');
        }
      });
    })
  );
});
