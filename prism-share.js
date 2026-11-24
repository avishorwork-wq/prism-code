// Include on reader pages: <script src="prism-share.js"></script>
// When opened via Android Share (?shared=1), loads the shared image into the reader's #upload input.
(async()=>{
  if(!/[?&]shared=1/.test(location.search))return;
  try{
    const c=await caches.open('prism-share');const r=await c.match('shared-image');if(!r)return;
    const blob=await r.blob();await c.delete('shared-image');
    const f=new File([blob],r.headers.get('x-name')||'shared.png',{type:blob.type||'image/png'});
    const run=()=>{const i=document.getElementById('upload');if(!i)return false;const dt=new DataTransfer();dt.items.add(f);i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));return true};
    if(!run())addEventListener('DOMContentLoaded',run);
    history.replaceState(null,'',location.pathname);
  }catch(e){}
})();
