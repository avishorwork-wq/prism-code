/* Prism Code, Copyright (c) 2026 Avi Shor. Use requires a visible credit "Prism Code by Avi Shor" linking to https://avishorwork-wq.github.io/prism-code/ . See LICENSE.md. No warranty. */
// Include on reader pages: <script src="prism-share.js"></script>
// When opened via Android Share (?shared=1), loads the shared image into the page's #upload input.
// If the input sits inside a hidden tab panel, the matching tab is selected first so the user sees the image.
(async()=>{
  if(!/[?&]shared=1/.test(location.search))return;
  try{
    const c=await caches.open('prism-share');const r=await c.match('shared-image');if(!r)return;
    const blob=await r.blob();await c.delete('shared-image');
    const f=new File([blob],r.headers.get('x-name')||'shared.png',{type:blob.type||'image/png'});
    const run=()=>{
      const i=document.getElementById('upload');if(!i)return false;
      const panel=i.closest('[role="tabpanel"][hidden]');
      if(panel){const tab=document.querySelector('[aria-controls="'+panel.id+'"]');if(tab)tab.click()}
      const dt=new DataTransfer();dt.items.add(f);i.files=dt.files;
      i.dispatchEvent(new Event('change',{bubbles:true}));return true
    };
    // The reader may build its UI after DOMContentLoaded, so retry briefly.
    let n=0;const t=setInterval(()=>{if(run()||++n>50)clearInterval(t)},100);
    history.replaceState(null,'',location.pathname);
  }catch(e){}
})();
