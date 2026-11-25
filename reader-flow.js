/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
/* Prism reader flow: additive. Uses only the page's own UI.readFile and tab buttons. Nothing is uploaded. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const scan=$('scan'),up=$('upload'),st=$('scanStatus'),res=$('result');
if(!scan||!up||!st||!res||typeof UI==='undefined'||!UI.readFile)return;
const openRead=()=>{if($('scan').hidden)$('tab-scan').click();};
/* 1. Deep links: #scan (or #read, ?tab=scan), #generate (or #create), #test */
const deepTab=()=>{let h=location.hash.slice(1).toLowerCase(),q=(location.search.match(/[?&]tab=(\w+)/i)||[])[1];h=h||(q||'').toLowerCase();
  const m={scan:'scan',read:'scan',generate:'generate',create:'generate',test:'test'}[h];
  if(m&&$('tab-'+m)&&$(m).hidden)$('tab-'+m).click();};
deepTab();addEventListener('hashchange',deepTab);
/* Reflect tab choice in the hash without adding history entries. */
for(const [t,h] of [['generate','#create'],['scan','#scan']]){const b=$('tab-'+t);if(b)b.addEventListener('click',()=>{try{history.replaceState(null,'',location.pathname+location.search+h)}catch(e){}});}
/* 2. Drop zone + paste button (the native input stays, visually hidden but focusable by label) */
const zone=document.createElement('button');zone.type='button';zone.className='rf-zone';
zone.innerHTML='<svg class="rf-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg><b>Drop a photo here</b><span>or tap to choose one. Paste also works.</span>';
zone.addEventListener('click',()=>up.click());
const row=document.createElement('div');row.className='rf-row';
const pasteBtn=document.createElement('button');pasteBtn.type='button';pasteBtn.className='rf-btn';pasteBtn.textContent='Paste image';
row.append(pasteBtn);
const hint=document.createElement('p');hint.className='rf-hint';hint.id='rfHint';
const lab=scan.querySelector('label[for=upload]');
(lab||up).before(zone,row,hint);
const setHint=(t)=>{hint.textContent=t;};
const isImg=f=>f&&/^image\//.test(f.type||'')||(f&&/\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(f.name||''));
function feed(file,source){
  if(!file){setHint('That did not contain an image. Copy or drop a photo of the code.');return;}
  if(!isImg(file)){setHint('That file is not an image. Use a PNG or JPEG photo of the code.');return;}
  openRead();setHint('');UI.readFile(file);
}
pasteBtn.addEventListener('click',async()=>{
  if(!navigator.clipboard||!navigator.clipboard.read){setHint('This browser cannot paste from a button. Press Ctrl+V or Cmd+V on this page instead.');return;}
  try{
    for(const item of await navigator.clipboard.read()){
      const type=item.types.find(t=>t.startsWith('image/'));
      if(type){const blob=await item.getType(type);return feed(new File([blob],'pasted-image.'+(type.split('/')[1]||'png'),{type}),'paste');}
    }
    setHint('The clipboard has no image. Copy a photo or a screenshot first.');
  }catch(e){setHint('Clipboard access was blocked. Press Ctrl+V or Cmd+V on this page instead.');}
});
document.addEventListener('paste',e=>{
  const a=document.activeElement;
  if(a&&(a.tagName==='TEXTAREA'||(a.tagName==='INPUT'&&a.type==='text')||a.isContentEditable))return;
  const files=[...(e.clipboardData?.files||[])];
  const f=files.find(isImg);
  if(f){e.preventDefault();feed(f,'paste');}
  else if(!$('scan').hidden)setHint('The clipboard has no image. Copy a photo or a screenshot first.');
});
/* Drag and drop anywhere on the page */
const ov=document.createElement('div');ov.className='rf-drop';ov.setAttribute('aria-hidden','true');ov.innerHTML='<div>Drop to read this photo<small>It stays on your device.</small></div>';document.body.append(ov);
let depth=0;
const hasFiles=e=>e.dataTransfer&&[...(e.dataTransfer.types||[])].includes('Files');
addEventListener('dragenter',e=>{if(!hasFiles(e))return;depth++;ov.classList.add('on');});
addEventListener('dragleave',e=>{if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)ov.classList.remove('on');});
addEventListener('dragover',e=>{if(hasFiles(e))e.preventDefault();});
addEventListener('drop',e=>{if(!hasFiles(e))return;e.preventDefault();depth=0;ov.classList.remove('on');
  const files=[...e.dataTransfer.files];feed(files.find(isImg)||files[0],'drop');
  if(files.length>1)setHint('Several files dropped. Reading the first image only.');});
/* 3. Upload and read states */
const bar=document.createElement('div');bar.className='rf-bar';bar.setAttribute('aria-hidden','true');bar.innerHTML='<i></i>';
st.after(bar);
const guide=document.createElement('div');guide.id='rfGuide';guide.setAttribute('aria-live','polite');
const card=document.createElement('div');card.id='rfCard';card.setAttribute('aria-live','polite');
res.parentElement.insertBefore(card,res.nextSibling);
st.after(guide);bar.after(guide);
let lastResultText='';
function setState(s){scan.classList.remove('rf-reading','rf-ok','rf-bad');if(s)scan.classList.add('rf-'+s);}
function guidanceFor(msg){
  const m=(msg||'').toLowerCase();
  if(/too large|40 mb/.test(m))return ['This image is over 40 MB.',['Share a smaller copy, or take a new photo at normal quality.']];
  if(/not supported|format/.test(m))return ['This image format is not supported.',['Use a PNG or JPEG.','On iPhone, choose "Most Compatible" in camera settings, or screenshot the photo.']];
  return ['No verified code was read.',['Fit the whole code and its white margin in the photo.','Move closer so the code fills about half the frame. Hold still to avoid blur.','Tilt away from lights to remove glare and reflections.','Use even light. A shadow across the code hurts more than a dim room.','Keep it flat. Crumpled or curved paper is the hardest case.','Try the live camera. It takes many frames and can read what a single photo cannot.']];
}
function renderGuide(msg){
  guide.replaceChildren();
  const [title,tips]=guidanceFor(msg);
  const c=document.createElement('div');c.className='rf-card bad';
  const h=document.createElement('h3');h.textContent=title;c.append(h);
  const p=document.createElement('p');p.textContent='A wrong result is never shown. A read only counts when its checksum matches.';c.append(p);
  const ul=document.createElement('ul');for(const t of tips){const li=document.createElement('li');li.textContent=t;ul.append(li);}c.append(ul);
  const r=document.createElement('div');r.className='rf-row';
  const cam=document.createElement('button');cam.type='button';cam.className='rf-btn pri';cam.textContent='Open camera';cam.onclick=()=>$('camera').click();
  const again=document.createElement('button');again.type='button';again.className='rf-btn';again.textContent='Choose another photo';again.onclick=()=>up.click();
  r.append(cam,again);c.append(r);guide.append(c);
}
function syncStatus(){
  const t=st.textContent||'';
  const err=st.classList.contains('error');
  const ok=st.classList.contains('ok');
  const busyNow=/^(Opening the photo|Finding the code|Reading)/i.test(t)||/^Searching/i.test(t);
  if(ok){setState('ok');guide.replaceChildren();}
  else if(err||/^No verified/i.test(res.textContent)&&!busyNow&&/not|no /i.test(t)&&!/^Ready|^Opening|^Finding/i.test(t)){setState('bad');renderGuide(t);}
  else if(busyNow){setState('reading');guide.replaceChildren();card.replaceChildren();}
  else{setState(null);}
}
new MutationObserver(syncStatus).observe(st,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
/* 4. Result card: tappable link only for http(s), host shown first, honest note */
function safeUrl(text){
  const t=(text||'').trim();
  if(!t||/\s/.test(t)||t.length>2048)return null;
  try{const u=new URL(t);if(u.protocol!=='https:'&&u.protocol!=='http:')return null;return u;}catch(e){return null;}
}
function renderCard(){
  const text=res.textContent;
  if(text===lastResultText)return;lastResultText=text;card.replaceChildren();
  if(!st.classList.contains('ok'))return;
  const u=safeUrl(text);
  const c=document.createElement('div');c.className='rf-card ok';
  if(u){
    const h=document.createElement('h3');h.textContent='Link in this code';
    const host=document.createElement('div');host.className='rf-host';host.textContent=u.hostname;
    const full=document.createElement('div');full.className='rf-url';full.textContent=u.href;
    const note=document.createElement('p');note.textContent='The checksum shows the code was read correctly. It does not show the site is safe. Check the address before you open it.'+(u.protocol==='http:'?' This link is not encrypted (http).':'');
    const r=document.createElement('div');r.className='rf-row';
    const a=document.createElement('a');a.className='rf-btn pri';a.href=u.href;a.target='_blank';a.rel='noopener noreferrer nofollow';a.textContent='Open link';
    const cp=document.createElement('button');cp.type='button';cp.className='rf-btn';cp.textContent='Copy link';cp.onclick=async()=>{try{await navigator.clipboard.writeText(u.href);cp.textContent='Copied';setTimeout(()=>cp.textContent='Copy link',1600);}catch(e){cp.textContent='Press and hold to copy';}};
    r.append(a,cp);c.append(h,host,full,note,r);
  }else{
    const h=document.createElement('h3');h.textContent='Read correctly';
    const n=document.createElement('p');n.textContent='Checksum passed. The content is shown above as text.';c.append(h,n);
  }
  card.append(c);
}
new MutationObserver(renderCard).observe(res,{childList:true,characterData:true,subtree:true});
new MutationObserver(()=>{if(st.classList.contains('ok'))renderCard();}).observe(st,{attributes:true,attributeFilter:['class']});
})();
