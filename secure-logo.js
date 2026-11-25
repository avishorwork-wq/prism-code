/* Prism Secure animated logo ("Prism Code Secured").
   Mounts Avi's animation into a container on a page.

   mode "scrub" (home band, test page): the container is wrapped in a tall
   track (~250svh) with a sticky, viewport-high inner frame, so the logo
   stays pinned while the user scrolls through the track. Scroll position
   inside the track drives the animation as a pure function of progress
   (scroll-scrubbed), no timers and no loop.

   mode "auto" (prism-secure.html hero): plays once when scrolled into view
   (masked dots -> revealed "Secured") and holds; click/tap toggles.

   Direction (Avi, 2026-11-25): the top of the track is READABLE - the word
   "Secured" with the shackle rested away (his loop's t=0 state). Scrolling
   down plays his keyframes forward: the shackle fades in, rises, SPINS
   open (his arc sweep, scale 0.05 -> 1 while raised), drops and locks with
   the click bounce; then "Secured" Battery-Park-scrambles as a whole word
   and the chars collapse into a row of dots (masked), shackle staying
   CLOSED once the dots appear. Track end = dots + locked. Scrolling back
   up runs the same function in reverse: the dots unscramble into "Secured"
   and the shackle rises/unlocks, spins away and rests.

   The shackle timeline (KF table, easing, click) is Avi's original,
   unchanged. Text uses his two-phase scramble spec ("scramble, then dots")
   placed in his original text window (t 2.4 - 3.9 of the 6s loop).

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

  // Avi's original shackle keyframes: [t, y, arcScale, opacity, ease]
  var T_LOCK = 3.9; // scrub maps p in [0,1] to his t in [0,3.9] (lock+dots half of the 6s loop)
  var KF = [
    [0.00,  40, 0.05, 0, "out"],
    [0.45, -80, 0.05, 1, "io"],
    [0.60, -80, 0.05, 1, "io"],
    [1.30, -80, 1.00, 1, "io"],
    [1.60, -80, 1.00, 1, "in"],
    [1.82,   8, 1.00, 1, "out"],
    [1.92,  -3, 1.00, 1, "io"],
    [2.02,   0, 1.00, 1, "io"],
    [4.20,   0, 1.00, 1, "out"]
  ];
  var ease = {
    io:  function (t) { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; },
    in:  function (t) { return t * t; },
    out: function (t) { return 1 - (1 - t) * (1 - t); }
  };
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // text windows within his timeline (seconds): rest, whole-word scramble,
  // then per-char collapse into dots (staggered). Reverse is automatic.
  var T_SCRAMBLE0 = 2.4, T_UNSET_STAG = 0.03, T_COLLAPSE0 = 2.95, T_COLL_STAG = 0.12, T_COLLAPSE = 0.22;

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

    // his state(), verbatim
    function shackleState(t) {
      for (var i = 0; i < KF.length - 1; i++) {
        var a = KF[i], b = KF[i + 1];
        if (t >= a[0] && t <= b[0]) {
          var k = ease[b[4]]((t - a[0]) / (b[0] - a[0]));
          return { y: a[1] + (b[1] - a[1]) * k, s: a[2] + (b[2] - a[2]) * k, o: a[3] + (b[3] - a[3]) * k };
        }
      }
      return { y: 40, s: 0.05, o: 0 };
    }

    // his draw(), verbatim
    function drawShackle(st, clickDy) {
      var r = R * st.s;
      shackle.setAttribute("d",
        "M" + (CX - R) + " " + LEFT_FOOT + " V" + ARC_Y +
        " A" + r + " " + R + " 0 0 1 " + (CX - R + 2 * r) + " " + ARC_Y +
        " V" + RIGHT_FOOT);
      wrap.setAttribute("transform", "translate(0 " + st.y + ")");
      wrap.setAttribute("opacity", st.o);
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

    // Pure function of his timeline t in [0, T_LOCK]; t=0: readable "Secured",
    // shackle rested away. t=T_LOCK: dots, shackle locked.
    function renderT(t) {
      var click = (t > 1.82 && t < 1.97) ? 3 * Math.sin((t - 1.82) / 0.15 * Math.PI) : 0;
      drawShackle(shackleState(t), click);

      var k = Math.floor(t * 18), i, ch, unsetAt, c0, m;
      for (i = 0; i < letters.length; i++) {
        unsetAt = T_SCRAMBLE0 + i * T_UNSET_STAG;
        c0 = T_COLLAPSE0 + i * T_COLL_STAG;
        if (t < unsetAt) { drawLetter(i, WORD[i], 1, 0); continue; }
        if (t >= c0 + T_COLLAPSE) { drawLetter(i, WORD[i], 0, 1); continue; }
        ch = SCRAMBLE_CHARS[(i * 31 + k * 17 + i * k * 7) % SCRAMBLE_CHARS.length];
        if (t < c0) { drawLetter(i, ch, 1, 0); continue; }
        m = (t - c0) / T_COLLAPSE;
        drawLetter(i, ch, 1 - m, m);
      }
    }

    function render(p) { renderT(clamp(p, 0, 1) * T_LOCK); }

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
      // rests at p=0 (readable "Secured"); on view it plays once from the
      // masked state (dots, locked) into the revealed one and holds.
      var pcur = 1, target = 1, raf = 0, last = 0, SWEEP = 3.2; // seconds for a full run
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
        render(1);
        var io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].intersectionRatio >= 0.6 && target === 1 && pcur === 1) {
              target = 0; start(); io.disconnect(); break;
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
