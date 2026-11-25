/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
/* Demos for the Home cards: use.html?demo=issuer reads the signed sample; use.html?demo=parts makes a small file's codes and reads them back. */
(function(){
  var m=/[?&]demo=([a-z]+)/.exec(location.search);if(!m)return;
  var which=m[1],$=function(id){return document.getElementById(id)};
  function wait(test,ms,cb){var t0=Date.now();(function p(){var v=test();if(v)return cb(v);if(Date.now()-t0>ms)return;setTimeout(p,150)})()}
  function tab(id){var t=$(id);if(t)t.click()}
  function setFiles(input,files){var dt=new DataTransfer();files.forEach(function(f){dt.items.add(f)});input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))}
  function note(t){var n=$('demoNote');if(!n){n=document.createElement('p');n.id='demoNote';n.style.cssText='margin:10px 16px;padding:10px 14px;border-radius:12px;background:#eef2ff;color:#1b1b1b;font:500 14px/1.5 Poppins,system-ui,sans-serif';var h=document.querySelector('main')||document.body;h.insertBefore(n,h.firstChild)}n.textContent=t}
  if(which==='issuer'){
    wait(function(){return $('upload')&&$('tab-scan')&&window.PrismIssuers},8000,function(){
      tab('tab-scan');note('Demo: reading the signed sample code from the Verified issuers page.');
      fetch('brand/sample-signed-code.png').then(function(r){return r.blob()}).then(function(b){setFiles($('upload'),[new File([b],'sample-signed-code.png',{type:'image/png'})]);setTimeout(function(){var t=document.querySelector('.prism-issuer')||$('result');if(t)t.scrollIntoView({behavior:'smooth',block:'center'})},2200)});
    });
  }else if(which==='parts'){
    wait(function(){return window.PrismParts&&$('ppFile')&&$('ppMakeBtn')&&$('ppMulti')&&$('tab-generate')},8000,function(){
      tab('tab-generate');note('Demo: a small file is cut into numbered codes, then the codes are read back and the file is rebuilt.');
      var txt='Prism Code parts demo. ';while(txt.length<2400)txt+='This file is split across several codes and put back together on your device. ';
      setFiles($('ppFile'),[new File([txt],'parts-demo.txt',{type:'text/plain'})]);
      wait(function(){return !$('ppMakeBtn').disabled},5000,function(){
        $('ppMakeBtn').click();
        wait(function(){var c=document.querySelectorAll('#ppGrid canvas');return c.length&&$('ppZip')&&!$('ppZip').disabled&&c.length},15000,function(n){
          setTimeout(function(){
            var cs=[].slice.call(document.querySelectorAll('#ppGrid canvas')),files=[],k=0;
            cs.forEach(function(c,i){var mg=60,o=document.createElement('canvas');o.width=c.width+2*mg;o.height=c.height+2*mg;var x=o.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,o.width,o.height);x.drawImage(c,mg,mg);
              o.toBlob(function(b){files[i]=new File([b],'part-'+(i+1)+'.png',{type:'image/png'});if(++k===cs.length){tab('tab-scan');setFiles($('ppMulti'),files);note('Demo: the '+cs.length+' codes were read back. The file is rebuilt and checked below.');setTimeout(function(){var t=$('ppScan');if(t)t.scrollIntoView({behavior:'smooth',block:'start'})},2500)}},'image/png')});
          },2500);
        });
      });
    });
  }
})();
