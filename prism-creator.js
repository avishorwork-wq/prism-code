/* Prism creator piece (index.html + prism.html Create tab).
   Additive enhancement: plain-English guidance, sharper live preview,
   descriptive PNG filenames, and a "now scan it" handoff after download.
   Hooks existing controls only; never overrides encoder or reader logic.
   If anything it expects is missing, it quietly does nothing. */
(() => {
'use strict';
if (typeof Prism === 'undefined' || typeof UI === 'undefined' || !UI.getCode) return;
const $ = id => document.getElementById(id);
const generate = $('generate'), payload = $('payload'), size = $('size'),
      ecc = $('ecc'), mode = $('mode'), radius = $('radius'),
      capacity = $('capacity'), downloadBtn = $('downloadPNG'),
      preview = $('preview'), encodeStatus = $('encodeStatus');
if (!generate || !payload || !downloadBtn || !preview) return;

const Q = 3 * Math.sqrt(3);
const TE = new TextEncoder();

/* ---------- plain-English labels (values unchanged) ---------- */

const SIZE_NAMES = { '0': 'Smallest', '1': 'Small', '2': 'Medium', '3': 'Large', '4': 'Extra large', '5': 'Maximum' };
const SIZE_CELLS = { '0': '21 × 24', '1': '29 × 33', '2': '41 × 47', '3': '57 × 66', '4': '81 × 94', '5': '113 × 130' };
/* Guidance below matches what the encoder itself allows at 30% repair data
   in color: 81, 188, 419, 864, 1809 and 3561 bytes for sizes 0 to 5. */
const SIZE_HINTS = {
  '0': 'a link or a short sentence',
  '1': 'a couple of sentences',
  '2': 'a short paragraph',
  '3': 'a long paragraph',
  '4': 'about 300 words',
  '5': 'the most data, about 600 words'
};
const ECC_LABELS = {
  '0': '10% repair data · fits the most',
  '1': '20% repair data',
  '2': '30% repair data · recommended',
  '3': '40% repair data · toughest against damage'
};
const MODE_LABELS = { '0': 'Color · holds 3× more', '1': 'Black & white' };
const RADIUS_NAMES = { '8': 'Compact', '12': 'Standard', '20': 'Large', '32': 'Print' };

function relabel(sel, map, keep) {
  if (!sel) return;
  for (const opt of sel.options) {
    if (map[opt.value]) opt.textContent = map[opt.value];
  }
}
if (size) {
  for (const opt of size.options) {
    if (opt.value === '-1') opt.textContent = 'Automatic · grows to fit (recommended)';
    else if (SIZE_NAMES[opt.value]) opt.textContent = SIZE_NAMES[opt.value] + ' · ' + SIZE_CELLS[opt.value] + ' cells';
  }
}
relabel(ecc, ECC_LABELS);
relabel(mode, MODE_LABELS);

/* friendlier field labels */
function setLabel(forId, text) {
  const l = generate.querySelector('label[for="' + forId + '"]');
  if (l) l.textContent = text;
}
setLabel('ecc', 'Damage repair');
setLabel('radius', 'PNG size');

/* ---------- hint elements ---------- */
function hintUnder(el, cls) {
  if (!el) return null;
  const host = el.closest('div') || el.parentElement;
  const d = document.createElement('div');
  d.className = cls;
  host.appendChild(d);
  return d;
}
const sizeHint = hintUnder(size, 'pcx-hint');
const eccHint = hintUnder(ecc, 'pcx-hint');
if (eccHint) eccHint.textContent = 'More repair data survives more damage, and leaves less room for text.';

/* live byte/character count under the textarea */
const count = document.createElement('div');
count.className = 'pcx-count';
payload.insertAdjacentElement('afterend', count);

/* handoff card, inserted right after the button row that holds Download PNG */
const actionsRow = downloadBtn.closest('.actions') || downloadBtn.parentElement;
const handoff = document.createElement('div');
handoff.className = 'pcx-handoff';
handoff.hidden = true;
handoff.innerHTML =
  '<div class="pcx-handoff-main"><strong class="pcx-handoff-title"></strong>' +
  '<span class="pcx-handoff-sub">Now scan it to check it reads.</span></div>' +
  '<div class="pcx-handoff-actions">' +
  '<button type="button" class="pcx-open-reader">Open the reader</button>' +
  '<a class="pcx-print" href="print.html">Print tips</a>' +
  '<button type="button" class="pcx-dismiss" aria-label="Dismiss">×</button></div>' +
  '<small class="pcx-handoff-phone">On your phone: open this page, tap Read, and pick the saved PNG.</small>';
actionsRow.insertAdjacentElement('afterend', handoff);
handoff.querySelector('.pcx-dismiss').addEventListener('click', () => { handoff.hidden = true; });
handoff.querySelector('.pcx-open-reader').addEventListener('click', () => {
  const tab = $('tab-scan');
  if (tab) { tab.click(); tab.focus(); }
});

/* ---------- helpers ---------- */

function currentBytes() {
  try {
    const rawMode = $('rawMode');
    if (rawMode && rawMode.checked) return null; /* file mode: byte count shown by capacity line */
    return TE.encode(payload.value).length;
  } catch (e) { return null; }
}

function slug(text) {
  const s = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || 'code';
}

function fileName(code) {
  try {
    const rawMode = $('rawMode');
    const base = (rawMode && rawMode.checked) ? 'file' : slug(payload.value);
    return 'prism-' + base + '-' + code.layout.C + 'x' + code.layout.R + '.png';
  } catch (e) { return 'prism-code.png'; }
}

/* ---------- dynamic refresh, runs after the page's own generate() ---------- */

let mirroredError = false;

function refresh() {
  const code = UI.getCode && UI.getCode();

  /* character / byte counter */
  const n = currentBytes();
  if (n === null) count.textContent = 'Encoding a file instead of text';
  else count.textContent = n + (n === 1 ? ' byte' : ' bytes');

  if (!code) {
    /* encode failed: make the page's error actionable, and mirror it where visible */
    if (capacity && capacity.classList.contains('error')) {
      let msg = capacity.textContent || '';
      if (/does not fit/i.test(msg) && !/Shorten it/.test(msg)) {
        msg += '. Shorten it, pick a bigger size, or lower damage repair.';
        capacity.textContent = msg;
      } else if (/too large/i.test(msg) && !/Shorten it/.test(msg)) {
        msg += '. Shorten it, or lower damage repair.';
        capacity.textContent = msg;
      }
      const capHidden = capacity.offsetParent === null;
      if (encodeStatus && capHidden) {
        encodeStatus.textContent = msg;
        encodeStatus.className = 'status error';
        mirroredError = true;
      }
    }
    return;
  }

  if (mirroredError && encodeStatus) {
    encodeStatus.textContent = '';
    encodeStatus.className = 'status';
    mirroredError = false;
  }

  /* capacity line in plain English (parse the page's own "N of M bytes used") */
  if (capacity && !capacity.classList.contains('error')) {
    const m = /(\d+) of (\d+) bytes/.exec(capacity.textContent || '');
    if (m) {
      const used = +m[1], cap = +m[2];
      const pct = cap ? Math.round(100 * used / cap) : 0;
      capacity.textContent = used + ' of ' + cap + ' bytes · ' + pct + '% full';
    }
  }

  /* size hint for the current grid */
  if (sizeHint && size) {
    const v = size.value;
    if (v === '-1') {
      const grid = code.layout.C + ' × ' + code.layout.R;
      sizeHint.textContent = 'Right now: ' + grid + ' cells, fits ' + code.capacity.payload + ' bytes.';
    } else if (SIZE_HINTS[v]) {
      sizeHint.textContent = 'Fits ' + SIZE_HINTS[v] + ' at 30% repair data in color.';
    }
  }

  /* PNG size options with real output dimensions for this code */
  if (radius) {
    const w = code.layout.W + 2 * Q, h = code.layout.H + 2 * Q;
    for (const opt of radius.options) {
      const r = +opt.value;
      if (!RADIUS_NAMES[opt.value]) continue;
      opt.textContent = RADIUS_NAMES[opt.value] + ' · ' + Math.ceil(w * r) + ' × ' + Math.ceil(h * r) + ' px';
    }
  }

  /* sharper live preview: re-render at a higher internal resolution.
     Target roughly 1100 px wide, at least the page's own radius, at most 24 px per cell. */
  try {
    const rBase = Math.min(12, +radius.value || 12);
    const wCells = code.layout.W + 2 * Q;
    let r2 = Math.round(1100 / wCells);
    r2 = Math.max(rBase, Math.min(24, Math.min(2 * rBase, Math.max(r2, rBase))));
    if (r2 > rBase) Prism.render(code, r2, preview);
  } catch (e) {}
}

for (const el of [payload, size, ecc, mode, radius]) {
  if (el) el.addEventListener('input', () => { handoff.hidden = true; refresh(); });
}
for (const id of ['rawMode', 'encodeFile', 'expertMode']) {
  const el = $(id);
  if (el) el.addEventListener('change', () => setTimeout(refresh, 0));
}
const createBtn = $('createBtn');
if (createBtn) createBtn.addEventListener('click', () => setTimeout(refresh, 0));

/* ---------- download: descriptive filename + handoff ----------
   Replace the button node so the page's earlier click handler does not also
   fire, then run the same render-and-save flow with a better name. */
const btn = downloadBtn.cloneNode(true);
downloadBtn.replaceWith(btn);
btn.addEventListener('click', () => {
  const code = UI.getCode && UI.getCode();
  if (!code) return;
  let name = 'prism-code.png';
  try {
    name = fileName(code);
    const r = radius ? (+radius.value || 12) : 12;
    const can = Prism.render(code, r);
    can.toBlob(blob => {
      if (!blob) {
        if (encodeStatus) { encodeStatus.textContent = 'PNG export failed'; encodeStatus.className = 'status error'; }
        return;
      }
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url; a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      handoff.querySelector('.pcx-handoff-title').textContent = 'Saved ' + name;
      handoff.hidden = false;
      if (encodeStatus) { encodeStatus.textContent = ''; encodeStatus.className = 'status'; }
    }, 'image/png');
  } catch (e) {
    if (encodeStatus) { encodeStatus.textContent = String(e && e.message || e); encodeStatus.className = 'status error'; }
  }
});

/* initial paint */
refresh();
})();
