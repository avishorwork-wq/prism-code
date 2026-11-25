/* Prism Code motion layer: smooth accordions, reveals and message fades.
   Additive only, no dependencies, honors prefers-reduced-motion. */
(function(){
"use strict";
if(window.__prismMotion)return;window.__prismMotion=1;
var RM=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):{matches:false};
var EASE='cubic-bezier(.4,0,.2,1)';
function rm(){return RM.matches;}

/* ---- Smooth <details> open/close with a real height slide ---- */
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
  if(d.__anim)return;
  d.__anim=1;
  if(!d.open){
    var h0=d.offsetHeight;
    d.open=true;
    var h1=d.offsetHeight;
    slideH(d,h0,h1,280,function(){d.__anim=0;});
  }else{
    var hc=d.offsetHeight;
    var cs=getComputedStyle(d);
    var closedH=s.offsetHeight+(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0)+(parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.borderBottomWidth)||0);
    slideH(d,hc,closedH,240,function(){d.open=false;d.__anim=0;});
  }
},true);

function slideH(el,from,to,ms,done){
  if(rm()||from===to){done();return;}
  el.style.overflow='hidden';
  var a;
  try{a=el.animate([{height:from+'px'},{height:to+'px'}],{duration:ms,easing:EASE});}catch(err){el.style.overflow='';done();return;}
  a.onfinish=a.oncancel=function(){el.style.overflow='';done();};
}

/* ---- Smooth reveals: elements shown/hidden through the hidden attribute ---- */
var REVEAL='[data-reveal],#pwbox,#keybox,#resultbox,#expertOnly,#expertInfo,#encodeFileWrap,.prismTrace,#savewarn,#cpw';
function watch(el){
  if(el.__revealWatched)return;
  el.__revealWatched=1;
  el.__appliedHidden=el.hidden;
  new MutationObserver(function(){
    var h=el.hidden;
    if(el.__anim||h===el.__appliedHidden)return;
    el.__appliedHidden=h;
    if(rm())return;
    el.__anim=1;
    if(h){
      /* it was just hidden: bring it back for the closing slide, then hide again */
      el.__appliedHidden=false;el.hidden=false;
      var hc=el.offsetHeight;
      el.style.overflow='hidden';
      var a;
      try{a=el.animate([{height:hc+'px',opacity:'1'},{height:'0px',opacity:'0'}],{duration:220,easing:EASE});}catch(err){el.hidden=true;el.__appliedHidden=true;el.__anim=0;el.style.overflow='';return;}
      a.onfinish=a.oncancel=function(){el.style.overflow='';el.__appliedHidden=true;el.hidden=true;el.__anim=0;};
    }else{
      var ho=el.offsetHeight;
      el.style.overflow='hidden';
      var a2;
      try{a2=el.animate([{height:'0px',opacity:'0'},{height:ho+'px',opacity:'1'}],{duration:280,easing:EASE});}catch(err2){el.__anim=0;el.style.overflow='';return;}
      a2.onfinish=a2.oncancel=function(){el.style.overflow='';el.__anim=0;};
    }
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
  try{a=el.animate([{opacity:'1'},{opacity:'0'}],{duration:110,easing:'ease-out'});}catch(err){el.textContent=txt;return;}
  a.onfinish=a.oncancel=function(){
    el.textContent=txt;
    el.animate([{opacity:'0'},{opacity:'1'}],{duration:150,easing:'ease-out'});
  };
};
})();
