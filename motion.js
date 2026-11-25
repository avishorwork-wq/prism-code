/* Prism Code motion layer: smooth accordions, reveals and message fades.
   Additive only, no dependencies, honors prefers-reduced-motion.
   Fluid-motion pass: interruptible (mid-animation reversals continue from the
   current position), entrance/exit easing pair, distance-scaled durations. */
(function(){
"use strict";
if(window.__prismMotion)return;window.__prismMotion=1;
var RM=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):{matches:false};
/* Shared easing language (Material motion):
   ENT decelerate for entrances, EXT accelerate for exits, STD for reversals. */
var ENT='cubic-bezier(0,0,.2,1)';
var EXT='cubic-bezier(.4,0,1,1)';
var STD='cubic-bezier(.4,0,.2,1)';
function rm(){return RM.matches;}
function boxH(el){return el.getBoundingClientRect().height;}
function stopAnim(el){
  var a=el.__animA;
  if(a){a.onfinish=null;a.oncancel=null;try{a.cancel();}catch(e){}}
  el.__animA=null;
}
/* Scale duration with travel distance so interrupted runs stay calm:
   ~0.85ms per px, clamped 150-300ms. */
function durFor(dist){return Math.round(Math.min(300,Math.max(150,dist*0.85)));}
function slideFromTo(el,from,to,ms,ease,done){
  if(rm()||Math.abs(from-to)<1){el.style.overflow='';if(done)done();return;}
  el.style.overflow='hidden';
  var a;
  try{a=el.animate([{height:from+'px'},{height:to+'px'}],{duration:ms,easing:ease});}
  catch(err){el.style.overflow='';if(done)done();return;}
  el.__animA=a;
  a.onfinish=a.oncancel=function(){
    if(el.__animA===a)el.__animA=null;
    el.style.overflow='';
    if(done)done();
  };
}

/* ---- Smooth <details> open/close with a real height slide, interruptible ---- */
document.addEventListener('click',function(e){
  var t=e.target;
  var s=t&&t.closest?t.closest('summary'):null;
  if(!s)return;
  var d=s.parentElement;
  if(!d||d.tagName!=='DETAILS')return;
  if(d.hasAttribute('data-no-motion'))return;
  if(t.closest('summary a,summary button,summary input,summary select,summary textarea,summary label'))return;
  if(rm())return;
  e.preventDefault();
  /* Reverse mid-animation: continue from the height on screen right now. */
  var reversing=!!d.__animA;
  var wantOpen=d.__dir?(d.__dir==='closing'):!d.open;
  var from=boxH(d);
  stopAnim(d);
  if(wantOpen){
    d.open=true;
    var ov=d.style.overflow;d.style.overflow='';
    var to=d.offsetHeight;
    d.style.overflow=ov;
    d.__dir='opening';
    slideFromTo(d,from,to,durFor(to-from),reversing?STD:ENT,function(){d.__dir=null;});
  }else{
    var cs=getComputedStyle(d);
    var closedH=s.offsetHeight+(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0)+(parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.borderBottomWidth)||0);
    d.__dir='closing';
    slideFromTo(d,from,closedH,durFor(from-closedH),reversing?STD:EXT,function(){d.open=false;d.__dir=null;});
  }
},true);

/* ---- Smooth reveals: elements shown/hidden through the hidden attribute ---- */
var REVEAL='[data-reveal],#pwbox,#keybox,#resultbox,#expertOnly,#expertInfo,#encodeFileWrap,.prismTrace,#savewarn,#cpw,#firstRun,.pp-dark .pp-body';
/* Hide runs keep the hidden attribute in place (so the app's later show write
   is always a real mutation we can interrupt on) and override display instead.
   The real display value is captured whenever the element is seen visible. */
function runReveal(el,hide){
  var from,to,fromO,toO,ease;
  var had=!!el.__animA;
  if(hide){
    el.style.setProperty('display',el.__disp||'block','important');
    from=el.offsetHeight;
    var o=parseFloat(getComputedStyle(el).opacity);fromO=isNaN(o)?1:o;
    stopAnim(el);
    to=0;toO=0;ease=had?STD:EXT;
  }else{
    el.style.removeProperty('display');
    if(had){from=boxH(el);var o2=parseFloat(getComputedStyle(el).opacity);fromO=isNaN(o2)?0:o2;}
    else{from=0;fromO=0;}
    stopAnim(el);
    var ov=el.style.overflow;el.style.overflow='';
    to=el.offsetHeight;
    el.style.overflow=ov;
    toO=1;ease=had?STD:ENT;
    el.__disp=getComputedStyle(el).display;
  }
  if(Math.abs(from-to)<1){
    if(hide)el.style.removeProperty('display');
    return;
  }
  el.style.overflow='hidden';
  var a;
  try{a=el.animate([{height:from+'px',opacity:String(fromO)},{height:to+'px',opacity:String(toO)}],{duration:durFor(Math.abs(to-from)),easing:ease});}
  catch(err){el.style.overflow='';if(hide)el.style.removeProperty('display');return;}
  el.__animA=a;
  a.onfinish=a.oncancel=function(){
    if(el.__animA===a)el.__animA=null;
    el.style.overflow='';
    if(hide)el.style.removeProperty('display');
  };
}
function watch(el){
  if(el.__revealWatched)return;
  el.__revealWatched=1;
  el.__appliedHidden=el.hidden;
  if(!el.hidden)el.__disp=getComputedStyle(el).display;
  new MutationObserver(function(){
    var h=el.hidden;
    if(h===el.__appliedHidden)return;
    el.__appliedHidden=h;
    if(rm())return;
    runReveal(el,h);
  }).observe(el,{attributes:true,attributeFilter:['hidden']});
}
function scanReveals(root){
  if(root.matches&&root.matches(REVEAL))watch(root);
  if(root.querySelectorAll)root.querySelectorAll(REVEAL).forEach(watch);
}
if(document.documentElement)scanReveals(document.documentElement);
new MutationObserver(function(recs){
  for(var i=0;i<recs.length;i++){
    var added=recs[i].addedNodes;
    for(var j=0;j<added.length;j++)if(added[j].nodeType===1)scanReveals(added[j]);
  }
}).observe(document.documentElement,{childList:true,subtree:true});

/* ---- Crossfade helper for status/message text swaps ---- */
window.pcSetText=function(el,txt){
  if(!el)return;
  if(el.textContent===txt||rm()){el.textContent=txt;return;}
  var a;
  try{a=el.animate([{opacity:'1'},{opacity:'0'}],{duration:110,easing:EXT});}catch(err){el.textContent=txt;return;}
  a.onfinish=a.oncancel=function(){
    el.textContent=txt;
    el.animate([{opacity:'0'},{opacity:'1'}],{duration:150,easing:ENT});
  };
};

/* ---- Batch 2 additions ---- */

/* Smooth progress bars: tween value changes instead of jumping (interruptible). */
(function(){
  var desc=Object.getOwnPropertyDescriptor(HTMLProgressElement.prototype,'value');
  if(!desc||!desc.set)return;
  function smooth(p){
    if(p.__smoothed)return;p.__smoothed=1;
    var cur=parseFloat(p.value)||0,raf=null;
    Object.defineProperty(p,'value',{
      configurable:true,
      get:function(){return desc.get.call(p);},
      set:function(v){
        var t=parseFloat(v)||0;
        if(rm()){cur=t;desc.set.call(p,t);return;}
        /* Small, frequent updates (self-test progress) pass straight through:
           their steps are already gradual, and tweening them can starve under load.
           Only large jumps (reset/finish) get the ease. */
        if(Math.abs(t-cur)<=0.05){cur=t;desc.set.call(p,t);return;}
        if(raf)cancelAnimationFrame(raf);
        var from=cur,t0=performance.now(),dur=180;
        raf=requestAnimationFrame(function step(now){
          var k=Math.min(1,(now-t0)/dur);
          var e=1-Math.pow(1-k,3); /* easeOutCubic: fast response, soft landing */
          cur=from+(t-from)*e;
          desc.set.call(p,cur);
          if(k<1)raf=requestAnimationFrame(step);
        });
      }
    });
  }
  document.querySelectorAll('progress').forEach(smooth);
})();

/* Staggered entrances for batched result rows. */
(function(){
  function stagger(c){
    if(c.__staggerWatched)return;c.__staggerWatched=1;
    new MutationObserver(function(recs){
      if(rm())return;
      var added=[];
      for(var i=0;i<recs.length;i++){
        var n=recs[i].addedNodes;
        for(var j=0;j<n.length;j++)if(n[j].nodeType===1)added.push(n[j]);
      }
      added.forEach(function(el,i){el.style.animationDelay=Math.min(i,6)*45+'ms';});
    }).observe(c,{childList:true});
  }
  var t=document.getElementById('testResults');if(t)stagger(t);
})();

/* Scroll reveals: below-fold sections fade/rise in on first approach. */
(function(){
  if(rm())return;
  var io;
  try{io=new IntersectionObserver(function(en){
    en.forEach(function(x){if(x.isIntersecting){x.target.classList.add('pc-sr-in');io.unobserve(x.target);}});
  },{rootMargin:'0px 0px -8% 0px'});}catch(e){return;}
  var els=document.querySelectorAll('main section, body>section');
  var watched=[];
  for(var i=0;i<els.length;i++){
    var r=els[i].getBoundingClientRect();
    if(r.top>window.innerHeight*0.92){els[i].classList.add('pc-sr');io.observe(els[i]);watched.push(els[i]);}
  }
  /* fast flings can jump a whole section between frames; catch up on scroll */
  var ticking=false;
  window.addEventListener('scroll',function(){
    if(ticking)return;ticking=true;
    requestAnimationFrame(function(){
      ticking=false;
      for(var j=watched.length-1;j>=0;j--){
        var el=watched[j];
        if(el.getBoundingClientRect().top<window.innerHeight*0.92){el.classList.add('pc-sr-in');io.unobserve(el);watched.splice(j,1);}
      }
    });
  },{passive:true});
})();

/* Never-blank safety net for scroll reveals (page .rv sections and .pc-sr).
   IntersectionObserver can miss a section on a fast phone flick (it jumps past between
   frames) or fire late while the main thread is busy; then the section stays at opacity 0.
   Reveal anything whose top is above the viewport bottom, including sections already
   scrolled past, on every scroll frame, touch event, load, and a slow timer. */
(function(){
  function sweep(){
    var vh=window.innerHeight||document.documentElement.clientHeight,left=0;
    var list=document.querySelectorAll('.rv:not(.on),.pc-sr:not(.pc-sr-in)');
    for(var i=0;i<list.length;i++){
      var el=list[i],r=el.getBoundingClientRect();
      if(r.top<vh*0.95){
        if(el.classList.contains('rv'))el.classList.add('on');
        if(el.classList.contains('pc-sr'))el.classList.add('pc-sr-in');
      }else left++;
    }
    return left;
  }
  var tick=false;
  function soon(){if(tick)return;tick=true;requestAnimationFrame(function(){tick=false;sweep();});}
  window.addEventListener('scroll',soon,{passive:true});
  window.addEventListener('touchmove',soon,{passive:true});
  window.addEventListener('touchend',soon,{passive:true});
  window.addEventListener('resize',soon);
  window.addEventListener('load',function(){sweep();setTimeout(sweep,600);});
  /* slow timer covers missed events (a flick that ends with no further scroll event) */
  setInterval(function(){if(!document.hidden)sweep();},500);
  sweep();
})();
})();
