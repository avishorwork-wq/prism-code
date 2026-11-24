/* First-run guide for use.html. Additive: only uses the page's existing element ids; touches nothing else.
   Make a sample, get the scanner onto a phone, scan it, in about ten seconds. */
(function(){
var KEY='prismFirstRunDone',$=function(i){return document.getElementById(i)};
var make=$('createBtn'),prev=$('preview'),nav=document.querySelector('nav[role=tablist]');
if(!make||!prev||!nav)return;
var SCAN='https://avishorwork-wq.github.io/prism-code/use.html#scan';
try{SCAN=new URL('use.html#scan',location.href.split('#')[0]).href}catch(e){}
var p=document.createElement('section');p.id='firstRun';p.setAttribute('aria-label','Quick start');
p.innerHTML='<div class="frHead"><h2>Try it in 10 seconds</h2><button class="frSkip" type="button">Hide</button></div><ol>'+
'<li id="frS1"><span class="frNum">1 · Make</span><h3>Here is a sample code</h3><p>It holds the words <strong>Hello, Prism!</strong>. Change the text below and press Make my code for your own.</p><canvas class="frCode" id="frCode" width="10" height="10" aria-label="Sample Prism Code"></canvas></li>'+
'<li id="frS2"><span class="frNum">2 · Get the scanner</span><h3 class="frDesktop">Open it on your phone</h3><h3 class="frPhoneOnly">You are on your phone</h3>'+
'<p class="frDesktop">Point your phone\'s normal camera at this link code. It opens the Prism scanner.</p><canvas class="frQR frDesktop" id="frQR" width="10" height="10" aria-label="Link to the Prism scanner"></canvas>'+
'<p class="frPhoneOnly">Save the picture of the code, or show it on another screen.</p>'+
'<div class="frRow"><button class="frBtn alt" id="frCopy" type="button">Copy link</button><button class="frBtn alt" id="frShare" type="button" hidden>Share link</button></div><p class="frNote">Your phone\'s normal camera cannot read a Prism Code. Only Prism\'s own scanner can.</p></li>'+
'<li id="frS3"><span class="frNum">3 · Scan</span><h3>Point it at the code</h3><p class="frDesktop">In the scanner on your phone, tap Open camera and aim at the code on this screen.</p><p class="frPhoneOnly">Tap Open camera and aim at a code on another screen.</p>'+
'<div class="frRow"><button class="frBtn" id="frRead" type="button">Read it here instead</button></div><p id="frOut" class="frNote" role="status" aria-live="polite">Reading it here takes about a second and uses no camera.</p></li></ol>';
nav.parentNode.insertBefore(p,nav);
function on(n){for(var i=1;i<=3;i++)$('frS'+i).classList.toggle('on',i<=n)}
if(localStorage.getItem(KEY)==='1'){p.hidden=true}
p.querySelector('.frSkip').onclick=function(){p.hidden=true;try{localStorage.setItem(KEY,'1')}catch(e){}};
function mirror(){var c=$('frCode'),s=prev;if(!s.width)return;c.width=s.width;c.height=s.height;c.getContext('2d').drawImage(s,0,0);on(3)}
function init(){
 if(!prev.width&&$('payload')&&!$('payload').value)$('payload').value='Hello, Prism!';
 if(!prev.width)try{make.click()}catch(e){}
 /* the page scrolls to the preview on Make; undo that for the automatic first render */
 window.scrollTo(0,0);mirror();on(3);
}
make.addEventListener('click',function(){setTimeout(mirror,60)});
var q=$('frQR');if(!(window.PrismQR&&PrismQR.draw(q,SCAN,5)))q.style.display='none';
$('frCopy').onclick=function(){var b=this;(navigator.clipboard?navigator.clipboard.writeText(SCAN):Promise.reject()).then(function(){b.textContent='Copied'},function(){b.textContent=SCAN});setTimeout(function(){b.textContent='Copy link'},2500)};
if(navigator.share){$('frShare').hidden=false;$('frShare').onclick=function(){navigator.share({title:'Prism scanner',url:SCAN}).catch(function(){})}}
var out=$('frOut'),res=$('result'),waiting=false;
$('frRead').onclick=function(){if(!$('readPreview'))return;waiting=true;out.className='frNote';out.textContent='Reading…';$('readPreview').click();setTimeout(function(){if(waiting){waiting=false;out.textContent='That took too long. Open the Scan tab to see why.'}},15000)};
new MutationObserver(function(){if(!waiting)return;var t=res.textContent||'';if(!t||/^(No code read yet|Reading)/i.test(t))return;waiting=false;
 out.className='frOut frOk';out.textContent='Read back: '+t;
 var b=document.getElementById('tab-generate');if(b)b.click();window.scrollTo({top:0,behavior:'smooth'})}).observe(res,{childList:true,characterData:true,subtree:true});
/* #scan and #make deep links open the matching tab (works with Prism's own tab buttons) */
function route(){var h=location.hash.slice(1),b={scan:'tab-scan',make:'tab-generate'}[h];if(b&&$(b))$(b).click()}
window.addEventListener('hashchange',route);
if(document.readyState==='complete')setTimeout(init,0);else window.addEventListener('load',function(){setTimeout(init,0)});
setTimeout(route,50);
})();
