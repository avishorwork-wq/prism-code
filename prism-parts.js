/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
/* Prism big files in parts. Additive: splits a file across several Prism codes and puts it back together.
   Part layout (bytes): "PPT1" | file id (4) | part number (2, from 1) | total parts (2) | whole length (4) | whole CRC-32 (4)
   | name length (1) | name (UTF-8) | chunk | part CRC-32 (4, over every byte before it).
   Uses only the page's own Prism.encode, Prism.render, Prism.crc32 and UI.readFile. Nothing leaves the device. */
(()=>{
'use strict';
const HAVE=typeof Prism!=='undefined'&&typeof UI!=='undefined';
const MAGIC=[0x50,0x50,0x54,0x31],TE=new TextEncoder(),TD=new TextDecoder();
let T=null;const crc=b=>{if(!T){T=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c>>>0;}}let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=T[(c^b[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
const SIZES={ '2':'Easy to scan · 41 × 47 cells','3':'Balanced · 57 × 66 cells','4':'Dense · 81 × 94 cells','5':'Densest · 113 × 130 cells'};
const ECC=2,MODE=0;
const u16=(a,i)=>(a[i]<<8)|a[i+1],u32=(a,i)=>((a[i]<<24)|(a[i+1]<<16)|(a[i+2]<<8)|a[i+3])>>>0;
function put32(a,i,v){a[i]=v>>>24&255;a[i+1]=v>>>16&255;a[i+2]=v>>>8&255;a[i+3]=v&255;}
function cleanName(n){return (n||'file').replace(/[\\\/\u0000-\u001f]/g,'_').slice(0,200);}
function nameBytes(n){let b=TE.encode(cleanName(n));while(b.length>40)b=b.slice(0,-1);
  return TE.encode(TD.decode(b).replace(/\uFFFD+$/,''));}
function partCapacity(size){return Prism.capacity(size,ECC,MODE).payload;}
function overhead(nb){return 4+4+2+2+4+4+1+nb.length+4;}
function plan(len,name,size){const nb=nameBytes(name),room=partCapacity(size)-overhead(nb);
  if(room<64)throw Error('Part size too small');return {room,total:Math.max(1,Math.ceil(len/room)),nb};}
function split(bytes,name,size){bytes=Uint8Array.from(bytes);const {room,total,nb}=plan(bytes.length,name,size);
  if(total>65535)throw Error('File is too big for this part size');
  const id=crypto.getRandomValues(new Uint8Array(4)),whole=crc(bytes),parts=[];
  for(let n=0;n<total;n++){const chunk=bytes.subarray(n*room,(n+1)*room),out=new Uint8Array(overhead(nb)+chunk.length);let o=0;
    out.set(MAGIC,o);o+=4;out.set(id,o);o+=4;out[o++]=(n+1)>>8;out[o++]=(n+1)&255;out[o++]=total>>8;out[o++]=total&255;
    put32(out,o,bytes.length);o+=4;put32(out,o,whole);o+=4;out[o++]=nb.length;out.set(nb,o);o+=nb.length;out.set(chunk,o);o+=chunk.length;
    put32(out,o,crc(out.subarray(0,o)));parts.push(out);}
  return parts;}
function parse(b){if(!b||b.length<25)return null;for(let i=0;i<4;i++)if(b[i]!==MAGIC[i])return null;
  if(crc(b.subarray(0,b.length-4))!==u32(b,b.length-4))return {bad:'This part failed its own check. Scan it again.'};
  const id=Array.from(b.subarray(4,8),x=>x.toString(16).padStart(2,'0')).join(''),n=u16(b,8),total=u16(b,10),len=u32(b,12),whole=u32(b,16),nl=b[20];
  if(21+nl+4>b.length||!n||n>total)return {bad:'This part has a broken header.'};
  return {id,n,total,len,whole,name:TD.decode(b.subarray(21,21+nl)),chunk:b.slice(21+nl,b.length-4)};}
class Assembler{
  constructor(){this.reset();}
  reset(){this.id=null;this.total=0;this.len=0;this.whole=0;this.name='';this.parts=new Map();this.result=null;}
  get have(){return this.parts.size;}
  missing(){const m=[];for(let i=1;i<=this.total;i++)if(!this.parts.has(i))m.push(i);return m;}
  add(bytes){const p=parse(bytes);if(!p)return {status:'notpart'};if(p.bad)return {status:'bad',message:p.bad};
    if(this.id===null){this.id=p.id;this.total=p.total;this.len=p.len;this.whole=p.whole;this.name=p.name;}
    else if(p.id!==this.id)return {status:'other',name:p.name,message:'That part belongs to a different file ('+(p.name||'unnamed')+'). Start over to switch.'};
    else if(p.total!==this.total||p.len!==this.len||p.whole!==this.whole)return {status:'bad',message:'This part does not match the others.'};
    if(this.parts.has(p.n))return {status:'duplicate',n:p.n};
    this.parts.set(p.n,p.chunk);
    if(this.have===this.total)return {status:'complete',n:p.n,...this.finish()};
    return {status:'new',n:p.n};}
  finish(){const out=new Uint8Array(this.len);let o=0;
    for(let i=1;i<=this.total;i++){const c=this.parts.get(i);if(o+c.length>this.len)return {ok:false,reason:'The parts add up to more than the file size.'};out.set(c,o);o+=c.length;}
    if(o!==this.len)return {ok:false,reason:'The parts add up to '+o+' bytes, not '+this.len+'.'};
    if(crc(out)!==this.whole)return {ok:false,reason:'The whole-file check failed. Start over and scan the parts again.'};
    this.result={bytes:out,name:this.name||'prism-file.bin'};return {ok:true};}
}
function zip(files){const parts=[],cen=[];let off=0;const dt=new Date(),time=(dt.getHours()<<11)|(dt.getMinutes()<<5)|(dt.getSeconds()>>1),date=((dt.getFullYear()-1980)<<9)|((dt.getMonth()+1)<<5)|dt.getDate();
  for(const f of files){const nm=TE.encode(f.name),c=crc(f.bytes),h=new DataView(new ArrayBuffer(30));
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(8,0,true);h.setUint16(10,time,true);h.setUint16(12,date,true);h.setUint32(14,c,true);h.setUint32(18,f.bytes.length,true);h.setUint32(22,f.bytes.length,true);h.setUint16(26,nm.length,true);h.setUint16(28,0,true);
    parts.push(new Uint8Array(h.buffer),nm,f.bytes);
    const g=new DataView(new ArrayBuffer(46));g.setUint32(0,0x02014b50,true);g.setUint16(4,20,true);g.setUint16(6,20,true);g.setUint16(8,0x0800,true);g.setUint16(12,time,true);g.setUint16(14,date,true);g.setUint32(16,c,true);g.setUint32(20,f.bytes.length,true);g.setUint32(24,f.bytes.length,true);g.setUint16(28,nm.length,true);g.setUint32(42,off,true);
    cen.push(new Uint8Array(g.buffer),nm);off+=30+nm.length+f.bytes.length;}
  let cs=0;for(const c of cen)cs+=c.length;const e=new DataView(new ArrayBuffer(22));e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,cs,true);e.setUint32(16,off,true);
  return new Blob([...parts,...cen,new Uint8Array(e.buffer)],{type:'application/zip'});}
window.PrismParts={split,parse,Assembler,zip,partCapacity,plan,MAGIC};

const $=id=>document.getElementById(id);
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;};
const fmt=n=>n<1024?n+' bytes':n<1048576?(n/1024).toFixed(n<10240?1:0)+' KB':(n/1048576).toFixed(1)+' MB';
function dl(blob,name){const a=document.createElement('a'),u=URL.createObjectURL(blob);a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),20000);}

const gen=HAVE?$('generate'):null;
if(gen){
  const card=el('section','pp-card');card.id='ppMake';
  card.innerHTML='<h3>Big file? Split it across codes</h3><p class="pp-sub">One code holds up to about 3.5 KB. Pick a file and Prism makes as many codes as it needs, numbered so they can be scanned in any order.</p>'+
   '<label for="ppFile">Choose a file</label><input id="ppFile" type="file"><label for="ppSize">Code size per part</label><select id="ppSize"></select><div class="pp-info" id="ppInfo" role="status"></div>'+
   '<div class="actions"><button class="primary" id="ppMakeBtn" disabled>Make the codes</button><button id="ppZip" disabled>Save all (ZIP)</button></div><div class="pp-grid" id="ppGrid"></div>';
  (gen.querySelector('.columns>div')||gen).append(card);
  const size=$('ppSize');for(const k of Object.keys(SIZES)){const o=el('option',null,SIZES[k]);o.value=k;size.append(o);}size.value='3';
  let file=null,fileBytes=null,made=[];
  const info=$('ppInfo');
  function refresh(){if(!file){info.textContent='';$('ppMakeBtn').disabled=true;return;}
    try{const p=plan(file.size,file.name,+size.value);info.textContent=file.name+' · '+fmt(file.size)+' → '+p.total+(p.total===1?' code':' codes')+' of up to '+fmt(p.room)+' each.';info.className='pp-info';$('ppMakeBtn').disabled=false;}
    catch(e){info.textContent=e.message;info.className='pp-info pp-err';$('ppMakeBtn').disabled=true;}}
  $('ppFile').onchange=async()=>{file=$('ppFile').files[0]||null;fileBytes=null;made=[];$('ppGrid').replaceChildren();$('ppZip').disabled=true;if(file){if(file.size>20*1024*1024){file=null;info.textContent='That file is over 20 MB. Choose a smaller one.';info.className='pp-info pp-err';return;}fileBytes=new Uint8Array(await file.arrayBuffer());}refresh();};
  size.onchange=()=>{made=[];$('ppGrid').replaceChildren();$('ppZip').disabled=true;refresh();};
  $('ppMakeBtn').onclick=async()=>{if(!fileBytes)return;const grid=$('ppGrid');grid.replaceChildren();made=[];
    try{const parts=split(fileBytes,file.name,+size.value);
      for(let i=0;i<parts.length;i++){const code=Prism.encode(parts[i],{size:+size.value,ecc:ECC,mode:MODE,type:1}),cv=Prism.render(code,6);
        const cell=el('figure','pp-cell');cv.className='pp-code';cv.setAttribute('aria-label','Part '+(i+1)+' of '+parts.length);
        const cap=el('figcaption',null,'Part '+(i+1)+' of '+parts.length);const b=el('button',null,'Save PNG');
        const nm='prism-part-'+String(i+1).padStart(String(parts.length).length,'0')+'-of-'+parts.length+'.png';
        const full=()=>new Promise(r=>Prism.render(code,12).toBlob(r,'image/png'));b.onclick=async()=>dl(await full(),nm);cell.append(cv,cap,b);grid.append(cell);made.push({full,nm});
        if(i%4===3)await new Promise(r=>setTimeout(r));}
      info.textContent=parts.length+(parts.length===1?' code':' codes')+' ready for '+file.name+'. Scan them in any order on the Scan tab.';info.className='pp-info pp-ok';$('ppZip').disabled=false;
    }catch(e){info.textContent=e.message;info.className='pp-info pp-err';}};
  $('ppZip').onclick=async()=>{const files=[];for(const m of made){const bl=await m.full();files.push({name:m.nm,bytes:new Uint8Array(await bl.arrayBuffer())});}
    dl(zip(files),'prism-parts-'+cleanName(file.name).replace(/\.[^.]*$/,'').slice(0,40)+'.zip');};
}

const sc=HAVE?$('scan'):null,camVal=$('value'),camRes=$('result');
const camPage=!sc&&camVal&&camRes&&$('start');
if(sc||camPage){
  const asm=new Assembler(),tally={};
  const card=el('section','pp-card'+(camPage?' pp-dark':''));card.id='ppScan';
  card.innerHTML='<h3>Scanning a file in parts?</h3><p class="pp-sub">Scan any part first, in any order. Parts are recognised automatically and counted here.</p>'+
   '<div class="pp-prog" id="ppProg" hidden><div class="pp-count" id="ppCount"></div><div class="pp-bar"><i id="ppFill"></i></div><div class="pp-chips" id="ppChips"></div><div class="pp-msg" id="ppMsg" role="status" aria-live="polite"></div></div>'+
   (sc?'<label for="ppMulti">Or choose several part photos at once</label><input id="ppMulti" type="file" accept="image/*" multiple>':'')+
   '<div class="actions"><button class="primary" id="ppSave" hidden>Save the file</button><button id="ppReset" hidden>Start over</button></div>';
  if(sc)(sc.querySelector('.columns')||sc).append(card);else $('stage').before(card);
  const msg=(t,cls)=>{$('ppMsg').textContent=t;$('ppMsg').className='pp-msg'+(cls?' '+cls:'');};
  function listMissing(){const m=asm.missing();return m.length>12?m.slice(0,12).join(', ')+' and '+(m.length-12)+' more':m.join(', ');}
  function draw(){const on=asm.id!==null;$('ppProg').hidden=!on;$('ppReset').hidden=!on;if(!on)return;
    $('ppCount').textContent=asm.have+' of '+asm.total+' parts'+(asm.name?' · '+asm.name:'');$('ppFill').style.width=(100*asm.have/asm.total)+'%';
    const ch=$('ppChips');ch.replaceChildren();for(let i=1;i<=asm.total&&i<=400;i++){const c=el('span','pp-chip'+(asm.parts.has(i)?' on':''),String(i));c.title=asm.parts.has(i)?'Part '+i+' scanned':'Part '+i+' still needed';ch.append(c);}
    $('ppSave').hidden=!asm.result;if(camPage)document.body.classList.toggle('pp-has-parts',on);}
  function handle(bytes){const r=asm.add(bytes);if(r.status==='notpart')return r;tally[r.status]=(tally[r.status]||0)+1;
    if(r.status==='new')msg('Got part '+r.n+'. '+(asm.total-asm.have)+' to go. Still needed: '+listMissing()+'.','ok');
    else if(r.status==='duplicate'){if(!asm.result&&asm.missing().length)msg('Already have part '+r.n+'. Scan a different one. Still needed: '+listMissing()+'.','warn');}
    else if(r.status==='complete'){msg(r.ok?'All '+asm.total+' parts scanned. File rebuilt and verified ('+fmt(asm.len)+', checksum matches).':r.reason,r.ok?'ok':'err');}
    else msg(r.message,'err');
    draw();return r;}
  if(camPage){let lastT='';/* the camera page shows non-text reads as hex; every verified frame refreshes #value */
    new MutationObserver(()=>{const t=camVal.textContent.trim();if(t===lastT||t.slice(0,12)!=='50 50 54 31 ')return;lastT=t;
      const bytes=Uint8Array.from(t.split(' '),h=>parseInt(h,16));handle(bytes);}).observe(camVal,{childList:true,characterData:true,subtree:true});
    $('ppReset').addEventListener('click',()=>{lastT='';});}
  document.addEventListener('prism:read',e=>{const res=e.detail;if(!res||!res.bytes)return;const fromCam=!$('stopCamera').disabled;
    const r=handle(res.bytes);if(r.status==='notpart')return;
    $('result').textContent='Part of a bigger file. See the progress below.';$('copyResult').disabled=true;$('saveResult').disabled=true;
    if(fromCam&&!asm.result)setTimeout(()=>{if($('camera').disabled||asm.result)return;$('camera').click();},1400);});
  if(sc)$('ppMulti').onchange=async()=>{const fs=[...$('ppMulti').files];$('ppMulti').value='';let fail=0;for(const k in tally)delete tally[k];
    for(let i=0;i<fs.length;i++){msg('Reading photo '+(i+1)+' of '+fs.length+'…');const res=await UI.readFile(fs[i]);if(!(res&&res.bytes&&parse(res.bytes)))fail++;}
    const tail=(tally.duplicate?' '+tally.duplicate+' duplicate'+(tally.duplicate>1?'s':'')+' ignored.':'')+(tally.other?' '+tally.other+' from a different file ignored.':'')+(fail?' '+fail+' photo'+(fail>1?'s':'')+' could not be read as a part.':'');
    if(asm.result)msg('All '+asm.total+' parts scanned. File rebuilt and verified ('+fmt(asm.len)+', checksum matches).'+tail,'ok');
    else if(asm.id!==null)msg(asm.have+' of '+asm.total+' parts. Still needed: '+listMissing()+'.'+tail,fail?'warn':'ok');
    else msg('No part found in those photos.'+tail,'warn');};
  $('ppSave').onclick=()=>{if(asm.result)dl(new Blob([asm.result.bytes],{type:'application/octet-stream'}),cleanName(asm.result.name));};
  $('ppReset').onclick=()=>{asm.reset();msg('');draw();};
  window.PrismPartsState=asm;
}
})();
