const CACHE = 'dochazka-v6';
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

// Do mezipaměti se ukládají jen soubory appky a knihovny z těchto CDN.
// Nikdy ne komunikace s databází a přihlašováním (*.googleapis.com) – dřív se tam
// ukládala i data docházky a mezipaměť rostla bez omezení.
const CDN = [
  { host: 'www.gstatic.com', path: '/firebasejs/' },
  { host: 'cdn.tailwindcss.com', path: '/' },
  { host: 'cdn.jsdelivr.net', path: '/npm/@phosphor-icons/' },
  { host: 'fonts.googleapis.com', path: '/css' },
  { host: 'fonts.gstatic.com', path: '/' },
];
function cacheable(url) {
  if (url.origin === self.location.origin) return true;
  return CDN.some(c => url.hostname === c.host && url.pathname.startsWith(c.path));
}

// ------------------------------------------------------------
// Upozornění (Firebase Cloud Messaging) – zobrazí je, i když je appka zavřená.
// Při nedostupné síti se skripty nenačtou; cache appky pak funguje dál
// a upozornění se zprovozní při příští aktualizaci.
// ------------------------------------------------------------
try {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js'
  );
  firebase.initializeApp({
    apiKey: 'AIzaSyCXeJSAeej49YIODneqfTuI9eT4u9QlmN0',
    authDomain: 'evidence-dochazky.firebaseapp.com',
    projectId: 'evidence-dochazky',
    storageBucket: 'evidence-dochazky.firebasestorage.app',
    messagingSenderId: '698522546437',
    appId: '1:698522546437:web:93b605318baf8a0b7ec76c'
  });
  // Zprávy s textem (notification) SDK samo zobrazí a po kliknutí otevře odkaz z odeslané zprávy.
  firebase.messaging();
} catch (e) {
  // bez upozornění – ostatní funkce sw.js nejsou dotčené
}

self.addEventListener('install', e => {
  self.skipWaiting();
  // soubory se ukládají jednotlivě: když jeden chybí, ostatní (i upozornění) fungují dál
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(ASSETS.map(a => cache.add(a).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: zkusí nejnovější verzi ze sítě, cache je jen záloha pro offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // zápisy do databáze apod. nechá na prohlížeči
  const url = new URL(e.request.url);
  if (!cacheable(url)) return; // databáze, přihlášení apod. jdou rovnou na síť, nic se neukládá
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => {
      if (hit) return hit;
      // offline otevření appky s parametry v adrese → vrátí uloženou appku
      if (e.request.mode === 'navigate') return caches.match('./index.html').then(r => r || Response.error());
      return Response.error();
    }))
  );
});
