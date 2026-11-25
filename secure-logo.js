/* Prism Secure animated logo ("Prism Code Secured").
   Mounts Avi's animation into a container on a page.

   mode "scrub" (home band, test page): the container is wrapped in a tall
   track (~250svh) with a sticky, viewport-high inner frame, so the logo
   stays pinned while the user scrolls through the track. Scroll position
   inside the track drives the animation as a pure function of progress
   (scroll-scrubbed): scrolling down plays it forward start to end (dots ->
   scramble -> "Secured", lock closes), then the page continues; scrolling
   back up scrubs it in reverse ("Secured" -> scramble -> dots). No loop, no
   autoplay, no timers: every frame is a function of scroll progress.

   mode "auto" (prism-secure.html hero): plays forward once when scrolled
   into view and holds the end state; click/tap plays it in reverse once
   (and again toggles). No loop.

   End states: secured = the word "Secured" + closed lock; unsecured = a row
   of dots (masked) + closed lock (per Avi: after the dots appear the
   shackle stays down/closed; it opens only mid-transition, "unscramble and
   unlock"). Transitions are a Battery Park scramble in two distinct phases.
   The lock hinge feel (rise, settle bounce, click) follows Avi's original
   keyframes.

   Honors prefers-reduced-motion and no-rAF by leaving the static lock
   fallback in the markup untouched. transform/opacity/textContent writes
   only; scroll work is a passive listener plus one rAF per scroll frame. */
window.PrismSecureLogo = (function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  var SVG_MARKUP =
    '<svg viewBox="300 150 1060 600" role="img" aria-label="Prism Code Secured logo" style="width:100%;height:auto;display:block;cursor:pointer">' +
      '<g id="shackleWrap"><path id="shackle" d="" fill="none" stroke="#fff" stroke-width="32"/></g>' +
      '<g id="hexes" stroke="#000" stroke-width="5" stroke-linejoin="round">' +
        '<g transform="translate(408 531)"><polygon fill="#1f4fff" points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
        '<g transform="translate(527 531)"><polygon fill="#fff"    points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
        '<g transform="translate(647 531)"><polygon fill="#ffcc10" points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
        '<g transform="translate(587 431)"><polygon fill="#ff8a00" points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
        '<g transform="translate(467 631)"><polygon fill="#00bfe3" points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
        '<g transform="translate(587 631)"><polygon fill="#1dbb5a" points="0,-66 57,-33 57,33 0,66 -57,33 -57,-33"/></g>' +
      '</g>' +
      '<text class="psl-t" x="745" y="541" font-size="100" fill="#fff" letter-spacing="-2">Prism Code</text>' +
      '<g id="sec"></g>' +
    '</svg>';

  var WORD = "Secured", ACC = "#7c9cf5", BASE = 611, MID = 593;
  var SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=";

  // progress map (fractions of track travel):
  //  0.00-0.15  dots rest (shackle closed)
  //  0.15-0.40  phase 1: dots expand into scrambling chars (staggered)
  //  0.40-0.52  whole word visibly scrambles
  //  0.52-0.79  phase 2: chars settle into "Secured" (staggered)
  //  0.79-1.00  "Secured" rest (shackle closed)
  // shackle: rises (unlocks) 0.18-0.38, holds open 0.38-0.62,
  //          falls and re-locks 0.62-0.82 with Avi's settle bounce.
  var P_DOT_END = 0.15, P_EXP_END = 0.40, P_SET_START = 0.52, P_SET_STEP = 0.045;
  var P_RISE0 = 0.18, P_RISE1 = 0.38, P_FALL0 = 0.62, P_FALL1 = 0.82;

  var ease = {
    io:  function (t) { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; },
    in:  function (t) { return t * t; },
    out: function (t) { return 1 - (1 - t) * (1 - t); }
  };
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function mount(container, anchor, opts) {
    if (!container) return;
    opts = opts || {};
    var section = anchor || container;
    // default: scrub when a separate section is given, auto for a lone hero container
    var mode = opts.mode || (section === container ? "auto" : "scrub");
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;                                 // static lock stays
    if (!("requestAnimationFrame" in window)) return;   // static lock stays
    if (mode === "auto" && !("IntersectionObserver" in window)) return;

    var shackle, wrap, hexes, letters = [], dots = [];
    var CX = 523, R = 66, ARC_Y = 326, LEFT_FOOT = 620, RIGHT_FOOT = 372;

    function buildDom() {
      container.innerHTML = SVG_MARKUP;
      var svg = container.querySelector("svg");
      var style = document.createElement("style");
      style.textContent = ".psl-t{font-family:\"Poppins\",\"Helvetica Neue\",Arial,sans-serif;font-weight:700}";
      container.appendChild(style);
      shackle = svg.querySelector("#shackle");
      wrap = svg.querySelector("#shackleWrap");
      hexes = svg.querySelector("#hexes");
      var sec = svg.querySelector("#sec"), ref = document.createElementNS(NS, "text");
      ref.setAttribute("class", "psl-t"); ref.setAttribute("x", 747); ref.setAttribute("y", BASE);
      ref.setAttribute("font-size", 66); ref.setAttribute("opacity", 0); ref.textContent = WORD;
      sec.appendChild(ref);
      for (var i = 0; i < WORD.length; i++) {
        var e = ref.getExtentOfChar(i), cx = e.x + e.width / 2;
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("class", "psl-t"); tx.setAttribute("x", e.x); tx.setAttribute("y", BASE);
        tx.setAttribute("font-size", 66); tx.setAttribute("fill", ACC); tx.textContent = WORD[i];
        sec.appendChild(tx); letters.push({ el: tx, cx: cx, ch: "" });
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("r", 9); c.setAttribute("fill", ACC); c.setAttribute("visibility", "hidden");
        sec.appendChild(c); dots.push({ el: c, cx: cx });
      }
      sec.removeChild(ref);
      return svg;
    }

    function drawShackle(y, clickDy) {
      shackle.setAttribute("d",
        "M" + (CX - R) + " " + LEFT_FOOT + " V" + ARC_Y +
        " A" + R + " " + R + " 0 0 1 " + (CX + R) + " " + ARC_Y +
        " V" + RIGHT_FOOT);
      wrap.setAttribute("transform", "translate(0 " + y + ")");
      wrap.setAttribute("opacity", 1);
      hexes.setAttribute("transform", "translate(0 " + clickDy + ")");
    }

    function drawLetter(i, ch, charScale, dotScale) {
      var L = letters[i], D = dots[i];
      if (dotScale > 0.01) {
        D.el.setAttribute("visibility", "visible");
        D.el.setAttribute("transform", "translate(" + D.cx + " " + (BASE - 22) + ") scale(" + dotScale + ")");
      } else D.el.setAttribute("visibility", "hidden");
      if (charScale > 0.01) {
        L.el.setAttribute("visibility", "visible");
        L.el.setAttribute("opacity", 1);
        L.el.setAttribute("transform", "translate(" + L.cx + " " + MID + ") scale(" + charScale + ") translate(" + (-L.cx) + " " + (-MID) + ")");
        if (L.ch !== ch) { L.el.textContent = ch; L.ch = ch; }
      } else { L.el.setAttribute("visibility", "hidden"); L.ch = ""; }
    }

    // Pure function of progress p in [0,1]. p=0: dots + lock closed.
    // p=1: "Secured" + lock closed. Reverse is the same function at lower p.
    function render(p) {
      // shackle
      var r = clamp((p - P_RISE0) / (P_RISE1 - P_RISE0), 0, 1);
      var f = clamp((p - P_FALL0) / (P_FALL1 - P_FALL0), 0, 1);
      var y;
      if (f > 0) {
        if (f < 0.52)      y = -80 + 88 * ease.in(f / 0.52);        // -80 -> 8
        else if (f < 0.76) y = 8 - 11 * ease.out((f - 0.52) / 0.24); // 8 -> -3
        else               y = -3 + 3 * ease.io((f - 0.76) / 0.24);  // -3 -> 0
      } else {
        y = -80 * ease.out(r);                                       // 0 -> -80
      }
      var clickDy = (f > 0.5 && f < 0.75) ? 3 * Math.sin((f - 0.5) / 0.25 * Math.PI) : 0;
      drawShackle(y, clickDy);

      // text
      var k = Math.floor(p * 120), i, m, settleAt, ch;
      for (i = 0; i < letters.length; i++) {
        m = clamp((p - P_DOT_END - i * 0.014) / 0.07, 0, 1);       // dot -> char
        settleAt = P_SET_START + i * P_SET_STEP;
        if (p >= settleAt) { drawLetter(i, WORD[i], 1, 0); continue; }
        if (m <= 0) { drawLetter(i, WORD[i], 0, 1); continue; }
        ch = SCRAMBLE_CHARS[(i * 31 + k * 17 + i * k * 7) % SCRAMBLE_CHARS.length];
        drawLetter(i, ch, m, 1 - m);
      }
    }

    var svg, ready = (document.fonts && document.fonts.load)
      ? Promise.race([document.fonts.load("700 66px Poppins"), new Promise(function (res) { setTimeout(res, 1500); })])
      : Promise.resolve();

    if (mode === "scrub") {
      // ---- scroll-scrubbed: tall track + sticky viewport frame ----
      var track = document.createElement("div");
      var pin = document.createElement("div");
      track.className = "psl-track";
      pin.className = "psl-pin";
      track.style.cssText = "position:relative;height:250vh;height:250svh";
      pin.style.cssText = "position:sticky;top:0;height:100vh;height:100svh;display:flex;align-items:center;justify-content:center;width:100%";
      var parent = container.parentNode;
      parent.insertBefore(track, container);
      pin.appendChild(container);
      track.appendChild(pin);
      // keep the text column pinned alongside on wide layouts, top-aligned
      var col = track.parentElement;
      var split = col && col.parentElement;
      if (split && split.classList && split.classList.contains("split")) {
        split.style.alignItems = "start";
        var textCol = split.children[0];
        if (textCol && textCol !== col) {
          textCol.style.position = "sticky";
          textCol.style.top = "18vh";
        }
      }

      var trackTop = 0, travel = 1, lastP = -1, raf = 0;
      function measure() {
        var rect = track.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight || 1;
        trackTop = rect.top + (window.scrollY || window.pageYOffset || 0);
        travel = Math.max(1, track.offsetHeight - vh);
      }
      function apply() {
        raf = 0;
        var y = window.scrollY || window.pageYOffset || 0;
        var p = clamp((y - trackTop) / travel, 0, 1);
        if (Math.abs(p - lastP) < 0.0005) return;
        lastP = p;
        render(p);
      }
      function onScroll() { if (!raf) raf = requestAnimationFrame(apply); }

      ready.then(function () {
        svg = buildDom();
        measure();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", function () { measure(); onScroll(); });
        apply();
        container.__psl = { get p() { return lastP; }, render: render, mode: "scrub" };
      }, function () {});
    } else {
      // ---- auto: play once on view, hold; click toggles direction ----
      var pcur = 0, target = 0, raf = 0, last = 0, SWEEP = 2.8; // seconds for a full run
      function frame(now) {
        var dt = (now - last) / 1000; last = now;
        if (dt > 0.1) dt = 0.1;
        var step = dt / SWEEP;
        if (pcur < target) pcur = Math.min(target, pcur + step);
        else pcur = Math.max(target, pcur - step);
        render(pcur);
        if (pcur !== target) raf = requestAnimationFrame(frame);
        else raf = 0;
      }
      function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

      ready.then(function () {
        svg = buildDom();
        render(0);
        var io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].intersectionRatio >= 0.6 && target === 0 && pcur === 0) {
              target = 1; start(); io.disconnect(); break;
            }
          }
        }, { threshold: [0.6] });
        io.observe(container);
        svg.addEventListener("click", function () { target = target === 1 ? 0 : 1; start(); });
        container.__psl = { get p() { return pcur; }, render: render, mode: "auto" };
      }, function () {});
    }
  }

  return { mount: mount };
})();
