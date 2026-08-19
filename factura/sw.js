// Service Worker PWA Módulo de Ventas / Facturación - Mundocarnes
// Estrategia Network-First con Auto-Update Inmediato y Fallback Offline
const CACHE_NAME = 'mundocarnes-pwa-v3.0.0';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'style.css',
  'script.js',
  'fiscalDriver.js',
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
  '../img/CREDITO.png',
  '../img/PAGOS%20MIXTOS.png',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Forzar activación inmediata sin esperar a cerrar pestañas
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Aviso SW: Caché inicial parcial:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('🔄 Purgando caché obsoleta de versión anterior:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const esRecursoLocal = url.origin === location.origin;

  // 1. REGLA NETWORK-FIRST (Código JS, CSS, HTML, JSON): Prioriza la versión más reciente en línea
  if (esRecursoLocal && (event.request.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname.endsWith('.css') || url.pathname.endsWith('.json'))) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback a caché local si el dispositivo está sin internet (Offline a 0ms)
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            if (event.request.mode === 'navigate') return caches.match('index.html');
          });
        })
    );
    return;
  }

  // 2. REGLA CACHE-FIRST (Imágenes y librerías CDN): Carga rápida con actualización en segundo plano
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) return networkResponse;
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('index.html');
        }
      });
    })
  );
});
