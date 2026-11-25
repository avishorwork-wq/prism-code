/* Prism cards piece (Tickets and cards).
   Additive: Create-page templates (Wi-Fi, contact card, expiring ticket)
   and reader result cards (Wi-Fi join/copy, vCard add-to-contacts,
   ticket valid/expired). Hooks existing controls only; never changes
   encoder or reader logic. If anything it expects is missing, it
   quietly does nothing. */
(() => {
'use strict';

/* ---------- payload formats ---------- */

// Wi-Fi: the common WIFI: payload used by QR codes, so other readers agree.
function escWifi(s){return String(s).replace(/([\\;,:"'])/g,'\\$1');}
function wifiPayload(f){
  const t=f.sec||'WPA';
  let s='WIFI:T:'+t+';S:'+escWifi(f.ssid||'')+';';
  if(t!=='nopass')s+='P:'+escWifi(f.pass||'')+';';
  if(f.hidden)s+='H:true;';
  return s+';';
}
function parseWifi(text){
  if(!/^WIFI:/i.test(text))return null;
  const body=text.slice(5);
  const fields={};
  let i=0,key='',val='',inKey=true;
  const push=()=>{if(key)fields[key.toUpperCase()]=val;key='';val='';inKey=true;};
  while(i<body.length){
    const c=body[i];
    if(c==='\\'&&i+1<body.length){if(inKey)key+=body[i+1];else val+=body[i+1];i+=2;continue;}
    if(inKey&&c===':'){inKey=false;i++;continue;}
    if(!inKey&&c===';'){push();i++;continue;}
    if(inKey)key+=c;else val+=c;
    i++;
  }
  push();
  if(!fields.S)return null;
  return {type:'wifi',ssid:fields.S,sec:(fields.T||'WPA').toUpperCase(),pass:fields.P||'',hidden:/^true$/i.test(fields.H||'')};
}

// Contact card: standard vCard 3.0.
function escV(s){return String(s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}
function vcardPayload(f){
  const L=['BEGIN:VCARD','VERSION:3.0'];
  L.push('FN:'+escV(f.name||''));
  if(f.name)L.push('N:'+escV(f.name.trim().split(/\s+/).slice(1).join(' ')||'-')+';'+escV(f.name.trim().split(/\s+/)[0])+';;;');
  if(f.org)L.push('ORG:'+escV(f.org));
  if(f.title)L.push('TITLE:'+escV(f.title));
  if(f.phone)L.push('TEL;TYPE=CELL:'+escV(f.phone));
  if(f.email)L.push('EMAIL:'+escV(f.email));
  if(f.url)L.push('URL:'+escV(f.url));
  if(f.addr)L.push('ADR;TYPE=WORK:;;'+escV(f.addr)+';;;;');
  if(f.note)L.push('NOTE:'+escV(f.note));
  L.push('END:VCARD');
  return L.join('\r\n');
}
function parseVcard(text){
  if(!/BEGIN:VCARD/i.test(text))return null;
  const lines=text.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'').split('\n');
  const get=(k)=>{const re=new RegExp('^'+k+'(;[^:]*)?:(.*)$','i');for(const l of lines){const m=l.match(re);if(m)return m[2].replace(/\\n/gi,'\n').replace(/\\([,;\\])/g,'$1');}return '';};
  const name=get('FN');
  if(!name)return null;
  const emails=[],phones=[],urls=[];
  for(const l of lines){let m;
    if(m=l.match(/^EMAIL(;[^:]*)?:(.*)$/i))emails.push(m[2]);
    else if(m=l.match(/^TEL(;[^:]*)?:(.*)$/i))phones.push(m[2]);
    else if(m=l.match(/^URL(;[^:]*)?:(.*)$/i))urls.push(m[2]);
  }
  return {type:'vcard',name,org:get('ORG'),title:get('TITLE'),
    addr:get('ADR').replace(/^;*/,'').replace(/;+$/,''),
    note:get('NOTE'),emails,phones,urls,raw:text};
}

// Expiring ticket: Prism payload, human readable text.
//   PRISM-TICKET/1
//   EXP:<unix seconds>
//   <free text lines shown on the card>
function ticketPayload(f){
  const exp=Math.floor(f.expiryMs/1000);
  return 'PRISM-TICKET/1\nEXP:'+exp+'\n'+String(f.text||'').trim();
}
function parseTicket(text){
  const m=String(text).match(/^PRISM-TICKET\/1\nEXP:(\d+)\n([\s\S]*)$/);
  if(!m)return null;
  const expiryMs=parseInt(m[1],10)*1000;
  return {type:'ticket',expiryMs,expired:Date.now()>expiryMs,body:m[2].trim()};
}

function detect(text){
  if(!text)return null;
  return parseTicket(text)||parseWifi(text)||parseVcard(text)||null;
}

/* ---------- shared style ---------- */

const CSS=`
.pccard{border-radius:16px;padding:16px 18px;margin-top:12px;text-align:left;font:15px/1.5 system-ui,-apple-system,sans-serif;border:1px solid rgba(128,128,128,.25)}
.pccard.light{background:#F4F4F6;color:#251f21}
.pccard.dark{background:rgba(255,255,255,.08);color:#f5f5f7}
.pccard h4{margin:0 0 2px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.65;font-weight:700}
.pccard .pcbig{font-size:19px;font-weight:650;margin:4px 0 8px;word-break:break-word}
.pccard .pcrow{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid rgba(128,128,128,.18);font-size:14.5px}
.pccard .pcrow:first-of-type{border-top:0}
.pccard .pcrow b{font-weight:600;word-break:break-all;text-align:right}
.pccard .pcrow a{font-weight:600}
.pccard .pcacts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.pccard button{border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:600 13px system-ui;padding:8px 14px;cursor:pointer;min-height:36px}
.pccard button.pcpri{background:#2E5BFF;border-color:#2E5BFF;color:#fff}
.pccard .pcnote{font-size:12.5px;opacity:.7;margin:10px 0 0}
.pccard .pcpill{display:inline-block;border-radius:999px;padding:3px 12px;font-size:12.5px;font-weight:700;margin-bottom:6px}
.pcpill.ok{background:#2DB35A22;color:#1e7a3e}
.pcpill.bad{background:#D7263D22;color:#c32434}
.pccard.dark .pcpill.ok{color:#4ade80}
.pccard.dark .pcpill.bad{color:#ff6b7a}
.pcbar{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.pcbar button{border-radius:999px;border:1px solid #eae9ea;background:#fff;color:#585254;font:600 13px system-ui;padding:8px 14px;cursor:pointer;min-height:36px}
.pcbar button[aria-pressed=true]{background:#251f21;border-color:#251f21;color:#fff}
.pcform{background:#F4F4F6;border-radius:14px;padding:14px 16px;margin:0 0 14px;display:grid;gap:8px}
.pcform label{font-size:12.5px;font-weight:600;color:#585254;display:grid;gap:3px}
.pcform input,.pcform select{border:1px solid #eae9ea;border-radius:8px;padding:9px 10px;font:15px system-ui;background:#fff;min-height:40px}
.pcform .pcnote{font-size:12.5px;color:#585254;margin:2px 0 0}
.pccard button:hover{border-color:#2E5BFF}
.pccard button.pcpri:hover{background:#2250ec}
.pcbar button:hover{border-color:#251f21;color:#251f21}
.pcbar button[aria-pressed=true]:hover{background:#3a3234;color:#fff}
.pccard button:focus-visible,.pcbar button:focus-visible{outline:3px solid #9ac8bb;outline-offset:2px}
`;
let styleDone=false;
function ensureStyle(){if(styleDone)return;styleDone=true;const s=document.createElement('style');s.textContent=CSS;document.head.appendChild(s);}
function theme(){try{const bg=getComputedStyle(document.body).backgroundColor;const m=bg.match(/[\d.]+/g);if(!m)return'light';const l=(0.2126*m[0]+0.7152*m[1]+0.0722*m[2]);return l<128?'dark':'light';}catch(e){return'light';}}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}

/* ---------- reader result cards ---------- */

function fmtDate(ms){return new Date(ms).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
function fmtLeft(ms){
  let s=Math.max(0,Math.round((ms-Date.now())/1000));
  const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);
  if(d)return d+' d '+h+' h';if(h)return h+' h '+m+' min';if(m)return m+' min';return 'under a minute';
}

function renderCard(data){
  ensureStyle();
  const card=el('div','pccard '+theme());
  card.setAttribute('data-prism-card','');
  if(data.type==='wifi'){
    card.append(el('h4','','Wi-Fi network'));
    card.append(el('div','pcbig',data.ssid));
    const r1=el('div','pcrow');r1.append(el('span','','Security'),el('b','',data.sec==='NOPASS'?'Open network':data.sec));card.append(r1);
    if(data.pass){
      const r2=el('div','pcrow');const pw=el('b','','••••••••');r2.append(el('span','','Password'),pw);card.append(r2);
      const acts=el('div','pcacts');
      const show=el('button','','Show password');
      show.onclick=()=>{const on=pw.textContent==='••••••••';pw.textContent=on?data.pass:'••••••••';show.textContent=on?'Hide password':'Show password';};
      const copy=el('button','pcpri','Copy password');
      copy.onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(data.pass);copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy password',1500);};
      acts.append(copy,show);card.append(acts);
    }
    if(data.hidden)card.append(el('p','pcnote','This network is hidden: it will not appear in the Wi-Fi list, add it by name.'));
    card.append(el('p','pcnote','To join, on your phone: Settings → Wi-Fi, choose this network and paste the password.'));
  }else if(data.type==='vcard'){
    card.append(el('h4','','Contact card'));
    card.append(el('div','pcbig',data.name));
    if(data.title||data.org)card.append(el('div','',(data.title?data.title+(data.org?' · ':''):'')+(data.org||'')));
    data.phones.forEach(p=>{const r=el('div','pcrow');const a=el('b');const l=el('a');l.href='tel:'+p.replace(/[^+\d]/g,'');l.textContent=p;a.append(l);r.append(el('span','','Phone'),a);card.append(r);});
    data.emails.forEach(p=>{const r=el('div','pcrow');const a=el('b');const l=el('a');l.href='mailto:'+p;l.textContent=p;a.append(l);r.append(el('span','','Email'),a);card.append(r);});
    data.urls.forEach(p=>{const r=el('div','pcrow');const a=el('b');const l=el('a');l.href=p;l.target='_blank';l.rel='noopener noreferrer';l.textContent=p.replace(/^https?:\/\//,'');a.append(l);r.append(el('span','','Website'),a);card.append(r);});
    if(data.addr){const r=el('div','pcrow');r.append(el('span','','Address'),el('b','',data.addr));card.append(r);}
    const acts=el('div','pcacts');
    const add=el('button','pcpri','Add to contacts');
    add.onclick=()=>{
      const blob=new Blob([data.raw.replace(/\n/g,'\r\n')],{type:'text/vcard'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);
      a.download=(data.name.replace(/[^\w -]+/g,'').trim()||'contact')+'.vcf';
      document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    };
    acts.append(add);card.append(acts);
    card.append(el('p','pcnote','Downloads a .vcf contact file. On most phones it opens straight into Contacts.'));
  }else if(data.type==='ticket'){
    card.append(el('h4','','Ticket'));
    const pill=el('span','pcpill '+(data.expired?'bad':'ok'),
      data.expired?'Expired '+fmtDate(data.expiryMs):'Valid until '+fmtDate(data.expiryMs));
    card.append(pill);
    if(data.body)card.append(el('div','pcbig',data.body));
    if(!data.expired)card.append(el('p','pcnote','Valid for another '+fmtLeft(data.expiryMs)+'. The expiry time is inside the code itself; the reader checks it against your clock.'));
    else card.append(el('p','pcnote','The expiry time inside this code has passed, so the reader will not treat it as valid. The content is shown for reference only.'));
  }
  return card;
}

function hookResult(resultEl,afterEl){
  if(!resultEl||resultEl.dataset.pcHooked)return;
  resultEl.dataset.pcHooked='1';
  const host=el('div');host.style.display='contents';
  (afterEl||resultEl).after(host);
  let cardEl=null;
  const update=()=>{
    const text=resultEl.textContent||'';
    const data=detect(text);
    if(cardEl){cardEl.remove();cardEl=null;}
    if(data&&text.length<4000){cardEl=renderCard(data);host.append(cardEl);}
  };
  new MutationObserver(update).observe(resultEl,{childList:true,characterData:true,subtree:true});
  update();
}

/* ---------- create-page templates ---------- */

const TEMPLATES=[
  {id:'text',label:'Text'},
  {id:'wifi',label:'Wi-Fi'},
  {id:'vcard',label:'Contact card'},
  {id:'ticket',label:'Ticket · expires'},
];

function buildForm(id,onChange){
  const f=el('div','pcform');
  const field=(label,input)=>{const l=el('label','',label);l.append(input);return l;};
  const inp=(type,ph)=>{const i=document.createElement('input');i.type=type;if(ph)i.placeholder=ph;return i;};
  const state={};
  const fire=()=>onChange(state);
  const bind=(key,input)=>{state[key]=input.value;input.addEventListener('input',()=>{state[key]=input.value;fire();});return input;};
  if(id==='wifi'){
    state.sec='WPA';
    f.append(field('Network name (SSID)',bind('ssid',inp('text','Home Wi-Fi'))));
    f.append(field('Password',bind('pass',inp('text','Wi-Fi password'))));
    const sec=document.createElement('select');
    [['WPA','WPA/WPA2/WPA3 (most networks)'],['WEP','WEP (old)'],['nopass','Open, no password']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;sec.append(o);});
    sec.addEventListener('change',()=>{state.sec=sec.value;fire();});
    f.append(field('Security',sec));
    const hid=inp('checkbox');hid.addEventListener('change',()=>{state.hidden=hid.checked;fire();});
    const hl=el('label','','Hidden network (not shown in the list)');hl.prepend(hid);hl.style.display='flex';hl.style.gap='8px';hl.style.alignItems='center';
    f.append(hl);
    f.append(el('p','pcnote','Standard Wi-Fi payload, the same kind QR codes use.'));
  }else if(id==='vcard'){
    f.append(field('Full name',bind('name',inp('text','Ada Lovelace'))));
    f.append(field('Job title',bind('title',inp('text','Engineer'))));
    f.append(field('Company',bind('org',inp('text','Acme'))));
    f.append(field('Phone',bind('phone',inp('tel','+972 50 000 0000'))));
    f.append(field('Email',bind('email',inp('email','name@example.com'))));
    f.append(field('Website',bind('url',inp('url','https://example.com'))));
    f.append(el('p','pcnote','Standard vCard: the reader offers Add to contacts.'));
  }else if(id==='ticket'){
    const d=new Date(Date.now()+3*3600e3);d.setMinutes(0,0,0);
    const local=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
    state.when=local;
    f.append(field('What is it for',bind('text',inp('text','Entry ticket · Row B seat 14'))));
    const when=inp('datetime-local');when.value=local;
    when.addEventListener('input',()=>{state.when=when.value;fire();});
    f.append(field('Valid until',when));
    f.append(el('p','pcnote','The expiry time is written inside the code. After it passes, the reader flags the code as expired.'));
  }
  return f;
}

function compose(id,state){
  if(id==='wifi')return wifiPayload(state);
  if(id==='vcard')return vcardPayload(state);
  if(id==='ticket'){
    const ms=Date.parse(state.when||'');
    if(!isFinite(ms))return '# Pick a valid-until date and time above';
    return ticketPayload({text:state.text,expiryMs:ms});
  }
  return '';
}

function hookCreate(){
  const ta=document.querySelector('#payload');
  if(!ta||ta.dataset.pcHooked)return;
  const label=document.querySelector('label[for="payload"]');
  if(!label)return;
  ta.dataset.pcHooked='1';
  ensureStyle();
  const bar=el('div','pcbar');bar.setAttribute('role','group');bar.setAttribute('aria-label','Code template');
  let formEl=null,current='text';
  const buttons={};
  let textDraft=ta.value;
  const select=(id)=>{
    const prev=current;
    if(prev==='text'&&id!=='text')textDraft=ta.value;
    current=id;
    Object.entries(buttons).forEach(([k,b])=>b.setAttribute('aria-pressed',k===id?'true':'false'));
    if(formEl){formEl.remove();formEl=null;}
    if(id!=='text'){
      formEl=buildForm(id,(state)=>{ta.value=compose(id,state);ta.dispatchEvent(new Event('input',{bubbles:true}));});
      ta.before(formEl);
      ta.value=compose(id,{});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      const first=formEl.querySelector('input');if(first){first.focus();first.dispatchEvent(new Event('input',{bubbles:true}));}    }else if(prev!=='text'){
      ta.value=textDraft;
      ta.dispatchEvent(new Event('input',{bubbles:true}));
    }
  };
  TEMPLATES.forEach(t=>{
    const b=el('button','',t.label);b.type='button';b.setAttribute('aria-pressed','false');
    b.onclick=()=>select(t.id);
    buttons[t.id]=b;bar.append(b);
  });
  buttons.text.setAttribute('aria-pressed','true');
  label.before(bar);
  label.textContent='Your message';
}

/* ---------- boot ---------- */

function boot(){
  // Create page (use.html generate tab).
  hookCreate();
  // Reader result: use.html / fast-reader.html share #result; camera page uses #value inside #result.
  const r=document.querySelector('#result');
  if(r){
    if(document.querySelector('#value'))hookResult(document.querySelector('#value'),r);
    else hookResult(r);
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();

window.PrismCards={detect,wifiPayload,vcardPayload,ticketPayload,parseWifi,parseVcard,parseTicket};
})();
