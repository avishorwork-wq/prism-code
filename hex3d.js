/* Prism 3D mark v2: a real 3D hex-cell structure. Each Prism cell is a column of stacked hex slabs.
   render(canvas,{ry,rx,p,fit,bg,shadow}); p 0..1 builds the structure slab by slab. Tiny canvas renderer, no libraries. */
(function(g){
var COL={o:'#F77F00',y:'#F5C518',g:'#2DB35A',c:'#00B8D9',b:'#2E5BFF',k:'#1B1B1B'};
var R=100,S=Math.sqrt(3)*R,T=34,GAP=5;
var LIST=[[0,0,COL.k,6]],cols=[COL.o,COL.y,COL.g,COL.c,COL.b],hs=[4,5,3,4,2];
for(var k=0;k<5;k++){var a=(-60+60*k)*Math.PI/180;LIST.push([S*Math.cos(a),-S*Math.sin(a),cols[k],hs[k]])}
function rgb(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]}
var TOT=6*T,SLABS=[];
LIST.forEach(function(c,ci){for(var L=0;L<c[3];L++)SLABS.push({x:c[0],z:c[1],y0:L*T-TOT/2,col:rgb(c[2]),L:L,ci:ci})});
var maxO=0;SLABS.forEach(function(s){s.o=s.L*1.0+s.ci*.16;if(s.o>maxO)maxO=s.o});
SLABS.forEach(function(s){s.o/=maxO});
function ease(t){t=Math.max(0,Math.min(1,t));return 1-Math.pow(1-t,3)}
var HEX=[];for(var i=0;i<6;i++){var an=(60*i-30)*Math.PI/180;HEX.push([Math.cos(an),Math.sin(an)])}
var L0=[-.45,.72,.52],ll=Math.hypot(L0[0],L0[1],L0[2]);L0=L0.map(function(v){return v/ll});
var H0=[L0[0],L0[1],L0[2]+1],hl=Math.hypot(H0[0],H0[1],H0[2]);H0=H0.map(function(v){return v/hl});
function render(cv,o){
 o=o||{};var ry=(o.ry||0)*Math.PI/180,rx=(o.rx==null?-28:o.rx)*Math.PI/180,p=o.p==null?1:o.p;
 var W=cv.width,H=cv.height,ctx=cv.getContext('2d');ctx.clearRect(0,0,W,H);
 if(o.bg){ctx.fillStyle=o.bg;ctx.fillRect(0,0,W,H)}
 var sc=W/(o.fit||720),D=1200,cx=W/2,cy=H/2+(o.dy||0)*sc;
 var cyr=Math.cos(ry),syr=Math.sin(ry),cxr=Math.cos(rx),sxr=Math.sin(rx);
 function tr(x,y,z){var x1=x*cyr+z*syr,z1=-x*syr+z*cyr;return [x1,y*cxr-z1*sxr,y*sxr+z1*cxr]}
 var span=.34,items=[];
 SLABS.forEach(function(s){
  var t0=s.o*(1-span),e=ease((p-t0)/span);if(e<=0)return;
  var yoff=(1-e)*260,sz=.55+.45*e,y0=s.y0+yoff,y1=y0+T-GAP,r=R*.94*sz;
  var c=tr(s.x,(y0+y1)/2,s.z);
  var top=[],bot=[];HEX.forEach(function(h){top.push([s.x+h[0]*r,y1,s.z+h[1]*r]);bot.push([s.x+h[0]*r,y0,s.z+h[1]*r])});
  var faces=[{n:[0,1,0],p:top},{n:[0,-1,0],p:bot.slice().reverse()}];
  for(var i=0;i<6;i++){var j=(i+1)%6,mx=(HEX[i][0]+HEX[j][0])/2,mz=(HEX[i][1]+HEX[j][1])/2,l=Math.hypot(mx,mz);
   faces.push({n:[mx/l,0,mz/l],p:[bot[i],bot[j],top[j],top[i]]})}
  items.push({s:s,e:e,c:c,faces:faces,y:s.y0})});
 items.sort(function(a,b){return Math.abs(a.c[2]-b.c[2])<2?a.y-b.y:a.c[2]-b.c[2]});
 if(o.shadow!==false){var gy=cy+(TOT/2*Math.cos(rx)+60)*sc;
  var sg=ctx.createRadialGradient(cx,gy,5,cx,gy,230*sc);sg.addColorStop(0,'rgba(0,0,0,.20)');sg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.save();ctx.translate(0,gy);ctx.scale(1,.26);ctx.translate(0,-gy);ctx.fillStyle=sg;ctx.beginPath();ctx.arc(cx,gy,230*sc,0,7);ctx.fill();ctx.restore()}
 items.forEach(function(it){
  var s=it.s;ctx.globalAlpha=Math.min(1,it.e*1.6);
  var fl=it.faces.map(function(f){
   var n=f.n,x1=n[0]*cyr+n[2]*syr,z1=-n[0]*syr+n[2]*cyr,nn=[x1,n[1]*cxr-z1*sxr,n[1]*sxr+z1*cxr];
   if(nn[2]<=0.0)return null;
   var pts=f.p.map(function(q){return tr(q[0],q[1],q[2])}),z=0;pts.forEach(function(q){z+=q[2]});
   return {nn:nn,pts:pts,z:z/pts.length}}).filter(Boolean).sort(function(a,b){return a.z-b.z});
  fl.forEach(function(f){
   var d=Math.max(0,f.nn[0]*L0[0]+f.nn[1]*L0[1]+f.nn[2]*L0[2]);
   var sp=Math.max(0,f.nn[0]*H0[0]+f.nn[1]*H0[1]+f.nn[2]*H0[2]);sp=Math.pow(sp,30)*(s.col[0]+s.col[1]+s.col[2]<120?.28:.16);
   var k=.55+.55*d;var cc=s.col.map(function(v){return Math.max(0,Math.min(255,Math.round(v*k+255*sp)))});
   var col='rgb('+cc.join(',')+')';
   ctx.beginPath();f.pts.forEach(function(q,i){var ff=D/(D-q[2]),x=cx+q[0]*ff*sc,y=cy-q[1]*ff*sc;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath();
   ctx.fillStyle=col;ctx.fill();ctx.lineWidth=Math.max(.8,1.1*sc);ctx.strokeStyle=col;ctx.lineJoin='round';ctx.stroke()});
 });ctx.globalAlpha=1}
g.Hex3D={render:render};
})(window);
