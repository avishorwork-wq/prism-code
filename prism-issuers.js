/* Prism Issuers: name lookup for signed Prism Secure payloads.
   When a scanned payload is a signed Prism Secure envelope, this verifies the
   ECDSA P-256 signature on the device, takes the signing key's fingerprint,
   and checks it against issuers.json (hosted next to the site, cached for
   offline). It then shows a small honest badge next to the scan result:
   a valid signature proves the code was made by one key and not changed;
   the list only says which name this site attaches to that key.
   No network account, no paid service. */
(function (root) {
  'use strict';
  const subtle = root.crypto && root.crypto.subtle;
  const LIST_URL = 'issuers.json';
  const CACHE_KEY = 'prismIssuers.v1';
  const MAGIC = [0x50, 0x53, 0x43], F_SIG = 2, F_ENC = 1;
  let listPromise = null;

  /* Load the issuer list: fresh copy when online, last copy when offline. */
  function loadList() {
    if (listPromise) return listPromise;
    listPromise = (async () => {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
      try {
        const res = await fetch(LIST_URL, { cache: 'no-cache' });
        if (!res.ok) throw Error('list fetch failed');
        const data = await res.json();
        if (!data || !Array.isArray(data.issuers)) throw Error('list is damaged');
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
        return { issuers: data.issuers, fresh: true };
      } catch (e) {
        if (cached && Array.isArray(cached.issuers)) return { issuers: cached.issuers, fresh: false };
        return { issuers: [], fresh: false };
      }
    })();
    return listPromise;
  }

  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  /* Same fingerprint as Prism Secure: SHA-256 of the raw public key, first 8 bytes. */
  async function fingerprint(pub) {
    const h = new Uint8Array(await subtle.digest('SHA-256', pub));
    return hex(h.slice(0, 8)).replace(/(....)(?=.)/g, '$1-').toUpperCase();
  }

  /* Inspect decoded payload bytes. Returns null for plain or unsigned payloads,
     else { signatureValid, fingerprint, encrypted, message }. Read-only: never decrypts.
     message is the decoded text for signed-but-not-encrypted payloads, else null. */
  async function identify(bytes) {
    if (!subtle || !bytes || bytes.length < 5 + 65 + 64) return null;
    if (!MAGIC.every((m, i) => bytes[i] === m) || (bytes[3] !== 1 && bytes[3] !== 2)) return null;
    if (!(bytes[4] & F_SIG)) return null;
    const end = bytes.length;
    const pub = bytes.slice(end - 129, end - 64), sig = bytes.slice(end - 64), body = bytes.slice(0, end - 129);
    let valid = false;
    try {
      const k = await subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, body);
    } catch (e) { valid = false; }
    const encrypted = !!(bytes[4] & F_ENC);
    let message = null;
    if (valid && !encrypted) {
      try { message = new TextDecoder('utf-8', { fatal: true }).decode(body.slice(5)); } catch (e) { message = null; }
    }
    return { signatureValid: valid, fingerprint: await fingerprint(pub), encrypted, message };
  }

  const norm = f => (f || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  function findIssuer(issuers, fp) {
    for (const it of issuers) if (norm(it.fingerprint) === norm(fp)) return it;
    return null;
  }

  function injectStyle() {
    if (document.getElementById('prism-issuer-style')) return;
    const st = document.createElement('style');
    st.id = 'prism-issuer-style';
    st.textContent = [
      '.prism-issuer{margin:8px 0 0;padding:9px 12px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:12px;font:13px/1.45 system-ui,sans-serif;overflow:hidden}',
      '.prism-issuer,.prism-issuer a{-webkit-tap-highlight-color:transparent}',
      '.prism-issuer b{font-weight:650}',
      '.prism-issuer .pi-fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.02em;overflow-wrap:anywhere}',
      '.prism-issuer .pi-msg{display:block;margin-top:4px;padding:6px 8px;border-radius:8px;background:color-mix(in srgb,currentColor 7%,transparent);overflow-wrap:anywhere;white-space:pre-wrap}',
      '.prism-issuer .pi-note{display:block;opacity:.75;font-size:12px;margin-top:2px}',
      '.prism-issuer a{color:inherit;text-underline-offset:3px}',
      '.prism-issuer.pi-ok{border-color:#2e7d52;background:color-mix(in srgb,#2e7d52 10%,transparent)}',
      '.prism-issuer.pi-warn{border-color:#A65200;background:color-mix(in srgb,#A65200 10%,transparent)}',
      '.prism-issuer.pi-bad{border-color:#b3261e;background:color-mix(in srgb,#b3261e 10%,transparent)}',
      '@media (prefers-reduced-motion: no-preference){.prism-issuer{opacity:0;transform:translateY(4px);transition:opacity .18s ease-out,transform .18s ease-out}.prism-issuer.pi-in{opacity:1;transform:none}}'
    ].join('\n');
    document.head.append(st);
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* Render the badge into host (a container element). Replaces any prior badge. */
  async function onBytes(bytes, host) {
    if (!host || !host.isConnected) return;
    let info = null;
    try { info = await identify(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch (e) { return; }
    host.querySelectorAll('.prism-issuer').forEach(n => n.remove());
    if (!info) return;
    injectStyle();
    const box = el('div', 'prism-issuer');
    box.setAttribute('role', 'note');
    if (!info.signatureValid) {
      box.classList.add('pi-bad');
      box.append(el('b', null, 'Signature check failed.'));
      box.append(el('span', 'pi-note', 'This code was changed after it was signed, or was not signed by the key it names.'));
    } else {
      const { issuers, fresh } = await loadList();
      const issuer = findIssuer(issuers, info.fingerprint);
      if (issuer) {
        box.classList.add('pi-ok');
        const head = el('div');
        head.append(el('b', null, 'Signed by ' + issuer.name + ' '));
        if (issuer.url) {
          const a = el('a', null, new URL(issuer.url, location.href).hostname);
          a.href = issuer.url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
          head.append(a);
        }
        box.append(head);
      } else {
        box.classList.add('pi-warn');
        box.append(el('b', null, 'Signed by a key that is not on the issuer list yet.'));
      }
      box.append(el('span', 'pi-fp', info.fingerprint));
      if (info.message) {
        const m = info.message.length > 200 ? info.message.slice(0, 200) + '\u2026' : info.message;
        box.append(el('span', 'pi-msg', m));
      } else if (info.encrypted) {
        box.append(el('span', 'pi-note', 'The content is locked with a password.'));
      }
      box.append(el('span', 'pi-note', issuer
        ? 'The signature is valid: this code is unchanged and was made by this key. The name comes from this site\u2019s issuer list' + (fresh ? '' : ' (saved copy, offline)') + '. Match the fingerprint above with the one the issuer publishes to confirm.'
        : 'The signature is valid: this code is unchanged and was made by this key. If you know the issuer\u2019s fingerprint, you can match it with the one above.'));
    }
    host.append(box);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('pi-in')));
  }

  const api = { identify, onBytes, loadList, fingerprint };
  root.PrismIssuers = api;

  /* Live scanner (fast-camera.html) announces every verified read. */
  root.addEventListener('prismdecoded', e => {
    const d = e && e.detail;
    if (!d || !d.bytes) return;
    const sheet = document.getElementById('resultSheet');
    if (sheet) onBytes(d.bytes, sheet);
  });

  /* Photo scan pages: clear a stale badge when a new read starts or fails. */
  const res = document.getElementById('result');
  if (res) new MutationObserver(() => {
    const t = res.textContent || '';
    if (/Reading|No verified|No code read/.test(t) && res.parentElement)
      res.parentElement.querySelectorAll('.prism-issuer').forEach(n => n.remove());
  }).observe(res, { childList: true, characterData: true, subtree: true });
})(typeof window !== 'undefined' ? window : globalThis);
