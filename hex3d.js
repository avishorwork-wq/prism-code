/* Prism 3D mark: tiny canvas renderer (no libraries). Hex cells as beveled prisms, Lambert + specular, painter's sort. */
(function(g){
var COL={o:'#F77F00',y:'#F5C518',g:'#2DB35A',c:'#00B8D9',b:'#2E5BFF',k:'#1B1B1B'};
var R=100,S=Math.sqrt(3)*R;
function cells(){var a=[{x:0,y:0,c:COL.k}],cols=[COL.o,COL.y,COL.g,COL.c,COL.b];
 for(var k=0;k<5;k++){var ang=(-60+60*k)*Math.PI/180;a.push({x:S*Math.cos(ang),y:-S*Math.sin(ang),c:cols[k]})}return a}
var CELLS=cells();
function hex(rr,cx,cy){var p=[];for(var i=0;i<6;i++){var a=(60*i-30)*Math.PI/180;p.push([cx+rr*Math.cos(a),cy-rr*Math.sin(a)])}return p}
function hexToRgb(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]}
function build(){
 var r=R*.93,hh=R*.34,b=R*.12,polys=[];
 CELLS.forEach(function(c){var rgb=hexToRgb(c.c);
  var outer=hex(r,c.x,c.y),inner=hex(r-b,c.x,c.y);
  var zw=hh-b;
  function add(pts,n){polys.push({p:pts,n:n,rgb:rgb,cell:c})}
  for(var i=0;i<6;i++){var j=(i+1)%6,A=outer[i],B=outer[j],A2=inner[i],B2=inner[j];
   var mx=(A[0]+B[0])/2-c.x,my=(A[1]+B[1])/2-c.y,l=Math.hypot(mx,my);mx/=l;my/=l;
   add([[A[0],A[1],-zw],[B[0],B[1],-zw],[B[0],B[1],zw],[A[0],A[1],zw]],[mx,my,0]);
   var k=.7071;
   add([[A[0],A[1],zw],[B[0],B[1],zw],[B2[0],B2[1],hh],[A2[0],A2[1],hh]],[mx*k,my*k,k]);
   add([[A[0],A[1],-zw],[B[0],B[1],-zw],[B2[0],B2[1],-hh],[A2[0],A2[1],-hh]],[mx*k,my*k,-k]);}
  add(inner.map(function(q){return [q[0],q[1],hh]}),[0,0,1]);
  add(inner.map(function(q){return [q[0],q[1],-hh]}).reverse(),[0,0,-1]);
 });return polys}
var POLYS=build();
function render(cv,o){
 o=o||{};var ry=(o.ry||0)*Math.PI/180,rx=(o.rx||0)*Math.PI/180,W=cv.width,H=cv.height,ctx=cv.getContext('2d');
 var bg=o.bg;ctx.clearRect(0,0,W,H);if(bg){ctx.fillStyle=bg;ctx.fillRect(0,0,W,H)}
 var sc=W/(o.fit||620),D=1100,cx=W/2,cy=H/2+(o.dy||0)*sc;
 var cyr=Math.cos(ry),syr=Math.sin(ry),cxr=Math.cos(rx),sxr=Math.sin(rx);
 // cluster center offset so it rotates about its visual center
 var ox=0,oy=-S*0.0;
 function T(p){var x=p[0]-ox,y=p[1]-oy,z=p[2]||0;
  var x1=x*cyr+z*syr,z1=-x*syr+z*cyr;var y2=y*cxr-z1*sxr,z2=y*sxr+z1*cxr;return [x1,y2,z2]}
 function N(n){var x1=n[0]*cyr+n[2]*syr,z1=-n[0]*syr+n[2]*cyr;return [x1,n[1]*cxr-z1*sxr,n[1]*sxr+z1*cxr]}
 var L=[-.42,.62,.66],ll=Math.hypot(L[0],L[1],L[2]);L=L.map(function(v){return v/ll});
 var Hh=[L[0],L[1],L[2]+1],hl=Math.hypot(Hh[0],Hh[1],Hh[2]);Hh=Hh.map(function(v){return v/hl});
 // floor shadow
 if(o.shadow!==false){var sg=ctx.createRadialGradient(cx,cy+280*sc,10*sc,cx,cy+280*sc,260*sc);
  sg.addColorStop(0,'rgba(0,0,0,.22)');sg.addColorStop(1,'rgba(0,0,0,0)');ctx.save();ctx.translate(0,0);ctx.scale(1,.28);
  ctx.fillStyle=sg;ctx.beginPath();ctx.arc(cx,(cy+300*sc)/.28,260*sc,0,7);ctx.fill();ctx.restore()}
 var items=[];
 POLYS.forEach(function(P){var n=N(P.n);if(n[2]<=0.01)return;
  var pts=P.p.map(T),z=0;pts.forEach(function(q){z+=q[2]});z/=pts.length;items.push({P:P,n:n,pts:pts,z:z})});
 items.sort(function(a,b){return a.z-b.z});
 items.forEach(function(it){
  var d=Math.max(0,it.n[0]*L[0]+it.n[1]*L[1]+it.n[2]*L[2]);
  var s=Math.max(0,it.n[0]*Hh[0]+it.n[1]*Hh[1]+it.n[2]*Hh[2]);s=Math.pow(s,36)*(it.P.rgb[0]+it.P.rgb[1]+it.P.rgb[2]<120?.3:.12);
  var k=.5+.42*d,rgb=it.P.rgb.map(function(v){return Math.max(0,Math.min(255,Math.round(v*k+255*s)))});
  var col='rgb('+rgb.join(',')+')';
  ctx.beginPath();it.pts.forEach(function(q,i){var f=D/(D-q[2]),x=cx+q[0]*f*sc,y=cy-q[1]*f*sc;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath();
  ctx.fillStyle=col;ctx.fill();ctx.lineWidth=1.2*sc*.6+.6;ctx.strokeStyle=col;ctx.lineJoin='round';ctx.stroke();
 });
}
g.Hex3D={render:render};
})(window);
