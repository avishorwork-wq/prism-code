/* Prism Secure animated logo ("Prism Code Secured").
   Mounts Avi's animation into a container on a page and plays it when the
   watched section scrolls fully into view (IntersectionObserver, ~0.9 with
   hysteresis + debounce so slow scrolling near the edge never re-triggers).
   Click/tap the logo to play it in reverse; click again for forward.
   Scrolling out of the section also reverses it; scrolling back in replays
   from the first frame.
   Text states: secured = the word "Secured"; unsecured = a row of dots
   (masked). Forward play Battery-Park-scramble-decodes the dots into
   "Secured"; reverse scrambles "Secured" back out into dots. The lock
   hinge timeline itself is Avi's, unchanged.
   Honors prefers-reduced-motion and no-IntersectionObserver by leaving the
   static lock fallback in the markup untouched. */
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

  function mount(container, section) {
    if (!container || !section) return;
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;                            // static lock stays
    if (!("IntersectionObserver" in window)) return; // static lock stays

    container.innerHTML = SVG_MARKUP;
    var svg = container.querySelector("svg");
    var style = document.createElement("style");
    style.textContent = ".psl-t{font-family:\"Poppins\",\"Helvetica Neue\",Arial,sans-serif;font-weight:700}";
    container.appendChild(style);

    var shackle = svg.querySelector("#shackle");
    var wrap = svg.querySelector("#shackleWrap");
    var hexes = svg.querySelector("#hexes");
    var CX = 523, R = 66, ARC_Y = 326, LEFT_FOOT = 620, RIGHT_FOOT = 372, T = 6;

    var KF = [
      [0.00,  40, 0.05, 0, "out"],
      [0.45, -80, 0.05, 1, "io"],
      [0.60, -80, 0.05, 1, "io"],
      [1.30, -80, 1.00, 1, "io"],
      [1.60, -80, 1.00, 1, "in"],
      [1.82,   8, 1.00, 1, "out"],
      [1.92,  -3, 1.00, 1, "io"],
      [2.02,   0, 1.00, 1, "io"],
      [4.20,   0, 1.00, 1, "out"],
      [4.50, -80, 1.00, 1, "io"],
      [5.20, -80, 0.05, 1, "in"],
      [5.55,  40, 0.05, 0, "io"],
      [6.00,  40, 0.05, 0, "io"]
    ];
    var ease = {
      io:  function (t) { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; },
      in:  function (t) { return t * t; },
      out: function (t) { return 1 - (1 - t) * (1 - t); }
    };

    function state(t) {
      for (var i = 0; i < KF.length - 1; i++) {
        var a = KF[i], b = KF[i + 1];
        if (t >= a[0] && t <= b[0]) {
          var k = ease[b[4]]((t - a[0]) / (b[0] - a[0]));
          return { y: a[1] + (b[1] - a[1]) * k, s: a[2] + (b[2] - a[2]) * k, o: a[3] + (b[3] - a[3]) * k };
        }
      }
      return { y: 40, s: 0.05, o: 0 };
    }

    function draw(st, clickDy) {
      var r = R * st.s;
      shackle.setAttribute("d",
        "M" + (CX - R) + " " + LEFT_FOOT + " V" + ARC_Y +
        " A" + r + " " + R + " 0 0 1 " + (CX - R + 2 * r) + " " + ARC_Y +
        " V" + RIGHT_FOOT);
      wrap.setAttribute("transform", "translate(0 " + st.y + ")");
      wrap.setAttribute("opacity", st.o);
      hexes.setAttribute("transform", "translate(0 " + clickDy + ")");
    }

    // ---- "Secured" word: letters (secured) <-> dots (unsecured) ----
    var WORD = "Secured", ACC = "#7c9cf5", BASE = 611, MID = 593;
    var letters = [], dots = [];

    function build() {
      var sec = svg.querySelector("#sec"), ref = document.createElementNS(NS, "text");
      ref.setAttribute("class", "psl-t"); ref.setAttribute("x", 747); ref.setAttribute("y", BASE);
      ref.setAttribute("font-size", 66); ref.setAttribute("opacity", 0); ref.textContent = WORD;
      sec.appendChild(ref);
      for (var i = 0; i < WORD.length; i++) {
        var e = ref.getExtentOfChar(i), cx = e.x + e.width / 2;
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("class", "psl-t"); tx.setAttribute("x", e.x); tx.setAttribute("y", BASE);
        tx.setAttribute("font-size", 66); tx.setAttribute("fill", ACC); tx.textContent = WORD[i];
        sec.appendChild(tx); letters.push({ el: tx, cx: cx });
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("r", 9); c.setAttribute("fill", ACC); c.setAttribute("visibility", "hidden");
        sec.appendChild(c); dots.push({ el: c, cx: cx });
      }
      sec.removeChild(ref);
    }

    // ---- Battery Park scramble transitions, two distinct phases ----
    // Reverse (unsecure): "Secured" scrambles as a whole word (phase 1),
    // then each scrambling character collapses into a dot (phase 2).
    // Forward (secure): dots expand into scrambling characters (phase 1),
    // then the characters settle into "Secured" (phase 2).
    var SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=";
    var textMode = "dots"; // resting state: "dots" (unsecured) or "letters" (secured)
    var trans = null;      // {t0, dir, cfg:[{delay,settle,last}], ch:[current chars]}
    var SCRAMBLE_ALL = 650, MORPH = 260, SETTLE_HOLD = 450, STAG = 60;

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
        L.el.textContent = ch;
      } else L.el.setAttribute("visibility", "hidden");
    }

    function restText(mode) {
      for (var i = 0; i < letters.length; i++) drawLetter(i, WORD[i], mode === "dots" ? 0 : 1, mode === "dots" ? 1 : 0);
      textMode = mode;
    }

    function startTransition(now, dir) {
      trans = { t0: now, dir: dir, ch: letters.map(function () { return WORD[0]; }),
        last: 0, cfg: letters.map(function (l, i) { return { delay: i * STAG, settle: i * 50 }; }) };
    }

    function drawTransition(now) {
      var done = true, i, c, e, m;
      var cycle = now - trans.last >= 55;
      if (cycle) trans.last = now;
      for (i = 0; i < letters.length; i++) {
        c = trans.cfg[i]; e = now - trans.t0;
        if (cycle) trans.ch[i] = SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
        if (trans.dir === -1) {
          // phase 1: whole word scrambles; phase 2: chars collapse into dots, staggered
          m = (e - SCRAMBLE_ALL - c.delay) / MORPH;
          if (m < 0) { drawLetter(i, trans.ch[i], 1, 0); done = false; }
          else if (m < 1) { drawLetter(i, trans.ch[i], 1 - m, m); done = false; }
          else drawLetter(i, WORD[i], 0, 1);
        } else {
          // phase 1: dots expand into scrambling chars, staggered; phase 2: settle into Secured
          m = (e - c.delay) / MORPH;
          var settleAt = letters.length * STAG + MORPH + SETTLE_HOLD + c.settle;
          if (e >= settleAt) drawLetter(i, WORD[i], 1, 0);
          else if (m < 0) { drawLetter(i, WORD[i], 0, 1); done = false; }
          else if (m < 1) { drawLetter(i, trans.ch[i], m, 1 - m); done = false; }
          else { drawLetter(i, trans.ch[i], 1, 0); done = false; }
        }
      }
      if (done) { textMode = trans.dir === 1 ? "letters" : "dots"; trans = null; }
    }

    // ---- driver: virtual time + direction ----
    var vt = 0, dir = 1, raf = 0, last = 0;

    function renderShackle(v) {
      var click = (v > 1.82 && v < 1.97) ? 3 * Math.sin((v - 1.82) / 0.15 * Math.PI) : 0;
      draw(state(v), click);
    }

    function frame(now) {
      var dt = (now - last) / 1000; last = now;
      if (dt > 0.1) dt = 0.1;
      vt = (vt + dir * dt) % T; if (vt < 0) vt += T;
      renderShackle(vt);
      if (trans) drawTransition(now);
      else if ((dir === 1 && textMode !== "letters") || (dir === -1 && textMode !== "dots")) startTransition(now, dir);
      raf = requestAnimationFrame(frame);
    }

    function start() { if (raf) return; last = performance.now(); raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    svg.addEventListener("click", function () { dir = -dir; start(); });

    // ---- scroll trigger: hysteresis + debounce, no churn near the edge ----
    var trigIn = 0.9, trigOut = 0.7;
    function updateTrigs() {
      var h = section.getBoundingClientRect().height;
      var vh = window.innerHeight || document.documentElement.clientHeight || 1;
      trigIn = h > vh ? Math.max(0.2, 0.9 * vh / h) : 0.9;
      trigOut = Math.max(0.05, trigIn - 0.2);
    }

    var view = "out"; // "out" | "in" | "reverse"
    var want = null, timer = 0;
    function applyState(s) {
      if (s === view) return;
      if (s === "in") { dir = 1; vt = 0; renderShackle(0); start(); }
      else if (s === "reverse") { if (raf && dir === 1) dir = -1; }
      else if (s === "out") { stop(); }
      view = s;
    }
    function requestState(s) {
      if (s === null || s === want) return;
      want = s;
      clearTimeout(timer);
      timer = setTimeout(function () { applyState(want); want = null; }, 180);
    }
    function desired(r) {
      if (r >= trigIn) return "in";
      if (r <= 0.001) return "out";
      if (r < trigOut) return view === "in" ? "reverse" : view;
      return view; // dead band between trigOut and trigIn: keep
    }

    function begin() {
      build();
      renderShackle(0); restText("dots"); // pre-play: unsecured logo (dots)
      updateTrigs();
      var io = new IntersectionObserver(function (entries) {
        updateTrigs();
        for (var i = 0; i < entries.length; i++) requestState(desired(entries[i].intersectionRatio));
      }, { threshold: [0, 0.15, 0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1] });
      io.observe(section);
    }

    var ready = (document.fonts && document.fonts.load)
      ? Promise.race([document.fonts.load("700 66px Poppins"), new Promise(function (r) { setTimeout(r, 1500); })])
      : Promise.resolve();
    ready.then(begin, begin);

    container.__psl = { get vt() { return vt; }, get dir() { return dir; }, get view() { return view; }, get textMode() { return textMode; } };
  }

  return { mount: mount };
})();
