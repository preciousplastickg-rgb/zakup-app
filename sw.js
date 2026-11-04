'use strict';
// Поднимать версию при любом изменении файлов приложения: без этого телефон не увидит обновление.
const CACHE = 'zakup-v22';
// Библиотеки и шрифты весят в десять раз больше приложения и меняются редко, поэтому лежат отдельно
// и при обновлении заново не скачиваются. Эту версию поднимать только при замене файлов в vendor/.
const VENDOR_CACHE = 'zakup-vendor-v1';

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
];

const VENDOR_ASSETS = [
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

// cache: 'reload' — мимо HTTP-кэша, иначе в новую версию попадут старые файлы.
const fresh = url => new Request(url, { cache: 'reload' });

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(fresh));
    // Докачиваются только недостающие: при первой установке и после смены VENDOR_CACHE это все файлы.
    const vendor = await caches.open(VENDOR_CACHE);
    const cached = await Promise.all(VENDOR_ASSETS.map(url => vendor.match(url)));
    await vendor.addAll(VENDOR_ASSETS.filter((url, i) => !cached[i]).map(fresh));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE && key !== VENDOR_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)));
});
