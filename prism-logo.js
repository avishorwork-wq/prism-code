/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
/* Logo or photo in the middle of a code (Create tab).
   Additive: wraps Prism.encode and Prism.render. With no logo chosen it does nothing.
   With a logo, the encoder puts the repair data under the middle of the code, the
   logo is drawn over it, and the page reads the finished code back to check it. */
(() => {
'use strict';
if (typeof Prism === 'undefined' || typeof UI === 'undefined' || !UI.getCode) return;
const $ = id => document.getElementById(id);
const generate = $('generate'), ecc = $('ecc'), downloadBtn = $('downloadPNG');
if (!generate || !ecc || !downloadBtn || !$('preview')) return;

const state = { img: null, pct: 15, url: null };
const origEncode = Prism.encode, origRender = Prism.render;

Prism.encode = function (bytes, opts) {
  const o = Object.assign({}, opts || {});
  if (state.img && o.logo === undefined) { o.logo = 1; o.ecc = 3; }
  const code = origEncode.call(Prism, bytes, o);
  code.logo = !!(state.img && o.logo);
  return code;
};

Prism.render = function (code, r, canvas) {
  if (!code || !code.logo || !state.img) return origRender.call(Prism, code, r, canvas);
  const l = code.layout, Q = Prism.Q;
  const W = Math.ceil((l.W + 2 * Q) * r), H = Math.ceil((l.H + 2 * Q) * r);
  const side = Math.sqrt(state.pct / 100 * l.W * l.H) * r;
  const cx = (l.W / 2 + Q) * r, cy = (l.H / 2 + Q) * r;
  const iw = state.img.naturalWidth || state.img.width, ih = state.img.naturalHeight || state.img.height;
  const k = Math.min(side / iw, side / ih);
  const lg = document.createElement('canvas'); lg.width = W; lg.height = H;
  const g = lg.getContext('2d', { willReadFrequently: true });
  g.drawImage(state.img, cx - iw * k / 2, cy - ih * k / 2, iw * k, ih * k);
  const a = g.getImageData(0, 0, W, H).data, syms = code.symbols.slice();
  let d = 1e9; const c0 = l.cells[0];
  for (const c of l.cells) { const q = Math.hypot(c.x - c0.x, c.y - c0.y); if (q > 0 && q < d) d = q; }
  const rr = d / Math.sqrt(3) * (window.__PLK || 1.4) * r, offs = [[0, 0]];
  for (let i = 0; i < 6; i++) offs.push([rr * Math.cos(i * Math.PI / 3), rr * Math.sin(i * Math.PI / 3)]);
  for (const c of l.cells) {
    const px = (c.x + Q) * r, py = (c.y + Q) * r;
    for (const o of offs) {
      const x = Math.round(px + o[0]), y = Math.round(py + o[1]);
      if (x >= 0 && y >= 0 && x < W && y < H && a[(y * W + x) * 4 + 3] > 20) { syms[c.index] = 8; break; }
    }
  }
  const c2 = origRender.call(Prism, Object.assign({}, code, { symbols: syms }), r, canvas);
  c2.getContext('2d').drawImage(lg, 0, 0);
  return c2;
};

/* ---------- controls ---------- */
const box = document.createElement('div');
box.className = 'pcx-logo';
box.style.cssText = 'margin:14px 0;padding:12px 14px;border:1px solid rgba(128,128,128,.35);border-radius:10px';
box.innerHTML = '<label for="logoFile" style="display:block;font-weight:600">Logo or photo in the middle (optional)</label>' +
  '<input id="logoFile" type="file" accept="image/*" style="margin-top:6px">' +
  '<div id="logoControls" hidden style="margin-top:8px"><label for="logoSize">Logo size</label> ' +
  '<select id="logoSize"><option value="10">Small</option><option value="15" selected>Medium</option><option value="20">Large</option><option value="25">Largest</option></select> ' +
  '<button type="button" id="logoClear">Remove logo</button></div>' +
  '<div id="logoNote" style="margin-top:8px;font-size:.92em;opacity:.85">The repair data sits under the logo, so the code stays readable. Damage repair is set to the highest level while a logo is on.</div>';
const anchor = downloadBtn.closest('.actions') || downloadBtn.parentElement;
anchor.parentElement.insertBefore(box, anchor);
const note = box.querySelector('#logoNote'), controls = box.querySelector('#logoControls');

let timer = 0;
function regenerate() { generate.dispatchEvent(new Event('input', { bubbles: true })); ($('payload') || generate).dispatchEvent(new Event('input', { bubbles: true })); scheduleCheck(); }
function scheduleCheck() { clearTimeout(timer); timer = setTimeout(check, 400); }

function stepDown() {
  const sel = box.querySelector('#logoSize'), opts = [10, 15, 20, 25], i = opts.indexOf(state.pct);
  state.pct = opts[Math.max(0, i - 1)]; state.auto = true; sel.value = String(state.pct); regenerate();
}

function check() {
  const code = UI.getCode();
  if (!state.img || !code || !code.logo) { note.style.color = ''; return; }
  if (typeof PrismReader === 'undefined') return;
  note.textContent = 'Checking that the code still reads...';
  setTimeout(() => {
    try {
      const prev = $('preview'), img = prev.getContext('2d').getImageData(0, 0, prev.width, prev.height);
      const res = PrismReader.read(img);
      const ok = res.bytes.length === code.bytes.length && res.bytes.every((x, i) => x === code.bytes[i]);
      if (!ok && state.pct > 10) { stepDown(); return; }
      note.style.color = ok ? '#1a7f37' : '#b35900';
      note.textContent = ok ? 'Checked: this code reads back with the logo in place.' + (state.auto ? ' The logo size was adjusted to fit.' : '')
        : 'Make the logo a little smaller or the text a little shorter.';
    } catch (e) {
      if (state.pct > 10) { stepDown(); return; }
      note.style.color = '#b35900';
      note.textContent = 'Make the logo a little smaller or the text a little shorter.';
    }
  }, 30);
}

box.querySelector('#logoFile').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.auto = false; state.url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => { state.img = im; controls.hidden = false; ecc.value = '3'; ecc.disabled = true; regenerate(); };
  im.onerror = () => { note.textContent = 'Choose an image file (PNG, JPG or WebP).'; };
  im.src = state.url;
});
box.querySelector('#logoSize').addEventListener('change', e => { state.auto = false; state.pct = +e.target.value; regenerate(); });
box.querySelector('#logoClear').addEventListener('click', () => {
  state.img = null; controls.hidden = true; ecc.disabled = false; box.querySelector('#logoFile').value = '';
  note.style.color = ''; note.textContent = 'Logo removed.'; regenerate();
});
for (const id of ['payload', 'size', 'mode']) { const el = $(id); if (el) el.addEventListener('input', scheduleCheck); }
})();
