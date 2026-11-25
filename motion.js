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
var REVEAL='[data-reveal],#pwbox,#keybox,#resultbox,#expertOnly,#expertInfo,#encodeFileWrap,.prismTrace,#savewarn,#cpw';
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
})();
