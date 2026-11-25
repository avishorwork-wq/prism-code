/* Prism Secure animated logo ("Prism Code Secured"), scroll-LOCK variant v2.
   TEST BUILD - lives on secure-logo-lock2-test.html only. The production
   secure-logo.js (v6 scrub) is untouched.

   Same visuals/keyframes as v6 (Avi's 3.9s timeline, spin, click bounce,
   scramble -> dots, closed shackle at the end). Driver: v6's tall track +
   sticky pinned frame, but instead of scrubbing, crossing the pin point
   downward starts a FIXED-DURATION (3.9s) timeline forward; crossing the
   track end upward plays it in reverse at the same speed. While it plays,
   user input is blocked (non-passive touchmove/wheel preventDefault +
   touch-action/overscroll-behavior on the root); release = remove those
   blockers only. NO body-fixed, NO scrollTo, NO position changes of any
   kind - so there is nothing to jump. Triggers are edge crossings from
   OUTSIDE the track, so a play can never re-trigger itself: after it
   finishes, the next swipe simply scrolls on.

   Playback is setInterval-driven: on Android Chrome, rAF only fires on
   scroll frames while the scroll controller is active, which made earlier
   builds advance only while the user kept scrolling.

   Honors prefers-reduced-motion and no-rAF via the static-lock fallback. */
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
    var mode = opts.mode || (section === container ? "auto" : "lockpin");
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

    if (mode === "lockpin") {
      // ---- pinned section + fixed-duration timeline + input blockers only ----
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
      var col = track.parentElement;
      var split = col && col.parentElement;
      if (split && split.classList && split.classList.contains("split")) {
        split.style.alignItems = "start";
        var textCol = split.children[0];
        if (textCol && textCol !== col) {
          textCol.style.position = "sticky";
          textCol.style.zIndex = "2";
          var stacked = textCol.getBoundingClientRect().width >= col.getBoundingClientRect().width - 1;
          if (stacked) {
            // phone layout: pin the text below the site bar and park the logo at
            // the bottom of the frame so it clears the heading, paragraph and link
            var bar = document.querySelector(".sitebar");
            var topPad = Math.round(((bar && bar.offsetHeight) || 64) + 10);
            textCol.style.top = topPad + "px";
            pin.style.boxSizing = "border-box";
            // center the logo in the space left below the pinned text
            var pad = Math.min(topPad + textCol.offsetHeight + 24, Math.round(window.innerHeight * 0.45));
            pin.style.paddingTop = pad + "px";
          } else {
            textCol.style.top = "18vh";
          }
        }
      }

      var DUR = 3900; // ms - his 3.9s keyframe timing, same both directions
      // If a single scroll event moves more than this many viewport heights (try 3), it is
      // treated as a deliberate jump (Home/End, anchor link) and skips the animation instead
      // of hijacking it. Infinity = ALWAYS play, even after the wildest fling (never miss).
      var JUMP_LIMIT = Infinity;

      var trackTop = 0, trackBot = 1, jumpPx = 1e9;
      var playing = false, dir = 1, t0 = 0, timer = 0, raf = 0, lastTick = 0;
      var settled = 0;   // what is on screen at rest: 0 = open/readable, 1 = locked/dots
      var lastRendered = -1, lockY = 0;
      var htmlEl = document.documentElement;
      var saved = {};

      function curY() { return window.scrollY || window.pageYOffset || 0; }
      var prevY = curY();

      function measure() {
        var r = track.getBoundingClientRect();
        trackTop = r.top + curY();
        trackBot = trackTop + Math.max(1, track.offsetHeight - pin.offsetHeight);
        jumpPx = JUMP_LIMIT * window.innerHeight;
      }
      function renderOnce(p) { if (p !== lastRendered) { lastRendered = p; render(p); } }
      function jumpTo(y) { window.scrollTo({ top: y, left: 0, behavior: "instant" }); }

      function prevent(e) { if (e.cancelable) e.preventDefault(); }
      function preventKey(e) {
        var k = e.keyCode;
        if (k === 32 || k === 33 || k === 34 || k === 35 || k === 36 || k === 38 || k === 40) e.preventDefault();
      }
      // Blocking has FOUR layers because touch/wheel preventDefault alone can't stop
      // a fling that is already in flight, a scrollbar drag, or a touchmove the browser
      // has already committed to scrolling:
      //  1) overflow:hidden on <html> (NOT body - that would break position:sticky)
      //  2) touchmove/wheel/key preventDefault
      //  3) touch-action / overscroll-behavior
      //  4) onScroll() snaps any leftover drift back to lockY while playing
      function block() {
        saved.of = htmlEl.style.overflow; saved.sg = htmlEl.style.scrollbarGutter;
        htmlEl.style.scrollbarGutter = "stable";   // no layout shift when the scrollbar hides
        htmlEl.style.overflow = "hidden";
        htmlEl.style.touchAction = "none";
        htmlEl.style.overscrollBehavior = "none";
        window.addEventListener("touchmove", prevent, { passive: false });
        window.addEventListener("wheel", prevent, { passive: false });
        window.addEventListener("keydown", preventKey);
      }
      function unblock() {
        window.removeEventListener("touchmove", prevent);
        window.removeEventListener("wheel", prevent);
        window.removeEventListener("keydown", preventKey);
        htmlEl.style.overflow = saved.of || "";
        htmlEl.style.scrollbarGutter = saved.sg || "";
        htmlEl.style.touchAction = "";
        htmlEl.style.overscrollBehavior = "";
      }

      // y = where the user is now. We ALWAYS pin the logo on screen first (clamp into the
      // track), so a fast flick that overshoots the pin can't play it off-screen.
      function start(d, y) {
        measure();
        lockY = clamp(y, trackTop, trackBot);
        if (Math.abs(curY() - lockY) > 0.5) jumpTo(lockY);
        dir = d; playing = true;
        block();
        renderOnce(d === 1 ? 0 : 1);
        t0 = performance.now(); lastTick = 0;
        // Time-based playback => same speed no matter how often frames arrive.
        // Driven by BOTH setInterval (never starves on Android scroll-controller
        // quirks) and rAF (smooth, vsync-aligned). tick() de-dupes them.
        timer = setInterval(tick, 16);
        raf = requestAnimationFrame(loop);
      }
      function loop() { if (!playing) { raf = 0; return; } tick(); raf = requestAnimationFrame(loop); }
      function tick() {
        if (!playing) return;
        var now = performance.now();
        if (now - lastTick < 8) return;
        lastTick = now;
        var k = (now - t0) / DUR;
        if (k >= 1) { finish(); return; }
        var p = dir === 1 ? k : 1 - k;
        render(p); lastRendered = p;
      }
      function finish() {
        playing = false;
        if (timer) { clearInterval(timer); timer = 0; }
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        settled = dir === 1 ? 1 : 0;
        renderOnce(settled);
        unblock();
        if (Math.abs(curY() - lockY) > 0.5) jumpTo(lockY);
        prevY = lockY;
      }

      function onScroll() {
        var y = curY();
        if (!svg) { prevY = y; return; }
        if (playing) {                       // layer 4: undo any drift, ignore everything else
          if (Math.abs(y - lockY) > 0.5) jumpTo(lockY);
          return;
        }
        var was = prevY; prevY = y;
        measure();

        // Deliberate jump (Home/End/anchor): don't hijack it, just show the right resting state.
        if (Math.abs(y - was) > jumpPx) {
          if (y > trackBot) settled = 1; else if (y < trackTop) settled = 0;
          renderOnce(settled);
          return;
        }
        // Heading down, logo still open, and we reached OR FLEW PAST the pin point.
        if (y > was && settled === 0 && y >= trackTop) { start(1, y); return; }
        // Heading up, logo locked, and we came back into/through the track from below,
        // or left it through the top.
        if (y < was && settled === 1 && y <= trackBot && (was > trackBot || y < trackTop)) { start(-1, y); return; }
      }

      ready.then(function () {
        svg = buildDom();
        measure();
        var y0 = curY();
        prevY = y0;
        settled = y0 > trackBot ? 1 : 0;
        renderOnce(settled);
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", measure);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
        // Page opened (or reloaded) with the pin already active: play it now instead of waiting.
        if (y0 >= trackTop && y0 <= trackBot) start(1, y0);
        container.__psl = { get p() { return lastRendered; },
          get state() { return playing ? "playing" : (settled ? "locked" : "open"); },
          render: render, mode: "lockpin" };
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
