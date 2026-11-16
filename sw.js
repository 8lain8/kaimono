/* 買い物リスト — オフラインでも開けるようにする仕組み（Service Worker）
   アプリ本体のファイルだけを端末に保存します。登録した品目や写真には触れません。

   動き方：
   1. 起動時は、端末に保存済みのファイルをすぐに表示する（電波が悪くても待たない）
   2. 表示が済んだあと、裏で新しい版がないか確認する
   3. 新しい版があれば全ファイルをまとめて入れ替え、次に開いた時から反映する */
'use strict';

const CACHE = 'kaimono-shell-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

// 転送（リダイレクト）された応答はそのまま画面表示に使えないので、中身だけ取り出して作り直す
async function clean(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function fetchFresh(url) {
  const response = await fetch(new Request(url, { cache: 'no-store' }));
  if (!response.ok) throw new Error(`取得できませんでした: ${url}`);
  return clean(response);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const fresh = await Promise.all(ASSETS.map(async (url) => [url, await fetchFresh(url)]));
    await Promise.all(fresh.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('kaimono-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    return fetch(request);
  })());
});

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

let refreshing = false;

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const cache = await caches.open(CACHE);
    // 1つでも取得に失敗したら何も入れ替えない（新旧のファイルが混ざるのを防ぐ）
    const fresh = await Promise.all(ASSETS.map(async (url) => [url, await fetchFresh(url)]));

    let changed = false;
    for (const [url, response] of fresh) {
      const next = await response.clone().arrayBuffer();
      const old = await cache.match(url);
      if (!old || !sameBytes(next, await old.arrayBuffer())) { changed = true; break; }
    }
    if (!changed) return;

    await Promise.all(fresh.map(([url, response]) => cache.put(url, response)));
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.postMessage({ type: 'updated' }));
  } catch (error) {
    // 圏外などで確認できない時は、保存済みの版をそのまま使い続ける
  } finally {
    refreshing = false;
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'refresh') event.waitUntil(refreshAll());
});
