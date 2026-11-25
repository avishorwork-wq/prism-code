/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
// Prism Code offline cache. Same-origin GET only. Bump VERSION to refresh.
const VERSION='prism-shell-21';
const SHELL=[
  './','index.html','landing.html','use.html','prism.html','docs.html','print.html','progress.html','install.html','prism-secure.html','boarding.html',
  'fast-camera.html','fast-reader.html','slow-reader.html','simulator.html','offline.html',
  'site.css','controls-motion.css','motion.js','use.css','common.css','site-reader.css','site-camera.css','site-install.css','site-secure.css','lab.html','a11y.css','reader-flow.css','reader-flow.js','first-run.css','first-run.js','prism-qrlink.js','camera-ux-overrides.css','prism-creator.css','prism-creator.js','prism-logo.js','prism-share.js','prism-pwa.js','manifest.webmanifest',  'brand/favicon.ico','brand/icon-32.png','brand/icon-180.png','brand/icon-192.png','brand/icon-512.png','brand/icon-maskable-512.png',
  'brand/prism-mark.svg','brand/prism-app-icon.svg','brand/prism-mark-color-on-dark.svg','brand/logo-horizontal.png','brand/sample-prism-code.png',
  'brand/fonts/Poppins-Regular.ttf','brand/fonts/Poppins-SemiBold.ttf','brand/fonts/Poppins-Bold.ttf'
];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==VERSION&&n.startsWith('prism-shell')).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method==='POST'&&new URL(r.url).pathname.endsWith('/share-target')){
    e.respondWith((async()=>{try{const fd=await r.formData();const f=fd.get('image');
      if(f&&f.size){const c=await caches.open('prism-share');await c.put('shared-image',new Response(f,{headers:{'content-type':f.type||'image/png','x-name':f.name||'shared.png'}}))}}catch(_){}
      return Response.redirect('./use.html?shared=1',303)})());return}if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(VERSION).then(c=>c.put(r,cp))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match(r.mode==='navigate'?'offline.html':'use.html'))));
});
