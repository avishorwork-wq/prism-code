/* Prism Code, Copyright (c) 2026 Avi Shor. Use requires a visible credit "Prism Code by Avi Shor" linking to https://avishorwork-wq.github.io/prism-code/ . See LICENSE.md. No warranty. */
// Registers the Prism Code offline service worker. Safe to include on any page:
// <script src="prism-pwa.js"></script>  (duplicate includes are harmless)
if('serviceWorker'in navigator&&(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')){
  navigator.serviceWorker.register('prism-sw.js').catch(()=>{});
}
