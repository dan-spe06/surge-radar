const C='sr-v1';self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./icon-192.png'])));self.skipWaiting()});
self.addEventListener('activate',e=>self.clients.claim());
self.addEventListener('fetch',e=>{if(e.request.url.includes('/api/'))return;e.respondWith(fetch(e.request).then(r=>{const cl=r.clone();caches.open(C).then(c=>c.put(e.request,cl));return r}).catch(()=>caches.match(e.request)))});
