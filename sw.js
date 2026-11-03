'use strict';
// Поднимать версию при любом изменении файлов приложения: без этого телефон не увидит обновление.
const CACHE = 'zakup-v20';

// Пути относительные: на GitHub Pages приложение живёт в подкаталоге.
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './reports.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/dexie.min.js',
  './vendor/xlsx.mini.min.js',
  './vendor/jszip.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/fonts/IBMPlexSans-Regular.ttf',
  './vendor/fonts/IBMPlexSans-SemiBold.ttf',
  './vendor/fonts/IBMPlexSans-Regular.woff2',
  './vendor/fonts/IBMPlexSans-Medium.woff2',
  './vendor/fonts/IBMPlexSans-SemiBold.woff2',
  './vendor/fonts/IBMPlexSansCondensed-SemiBold.woff2',
  './vendor/fonts/IBMPlexSansCondensed-Bold.woff2',
  './vendor/fonts/IBMPlexMono-Medium.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' — мимо HTTP-кэша, иначе в новую версию попадут старые файлы.
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)));
});
