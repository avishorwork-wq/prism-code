// Prism Code offline cache. Same-origin GET only. Bump VERSION to refresh.
const VERSION='prism-shell-4';
const SHELL=['./','index.html','landing.html','use.html','prism.html','docs.html','site.css','use.css','site-reader.css','site-camera.css','common.css','fast-camera.html','fast-reader.html','slow-reader.html','simulator.html','install.html','manifest.webmanifest','brand/icon-192.png','brand/icon-512.png','brand/prism-mark.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==VERSION&&n.startsWith('prism-shell')).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method==='POST'&&new URL(r.url).pathname.endsWith('/share-target')){
    e.respondWith((async()=>{try{const fd=await r.formData();const f=fd.get('image');
      if(f&&f.size){const c=await caches.open('prism-share');await c.put('shared-image',new Response(f,{headers:{'content-type':f.type||'image/png','x-name':f.name||'shared.png'}}))}}catch(_){}
      return Response.redirect('./fast-reader.html?shared=1',303)})());return}if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(VERSION).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match('index.html'))));
});
