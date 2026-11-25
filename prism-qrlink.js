/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit. See LICENSE.md. No warranty. */
/* Tiny QR encoder (byte mode, level L, versions 1-5, mask 0). Used only to draw a link QR so a phone's normal camera can open the Prism scanner. Not part of the Prism format. */
(function(g){
var EXP=new Array(512),LOG=new Array(256),x=1;for(var i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d}for(i=255;i<512;i++)EXP[i]=EXP[i-255];
function mul(a,b){return a&&b?EXP[LOG[a]+LOG[b]]:0}
function ecc(data,n){var gen=[1];for(var i=0;i<n;i++){var ng=new Array(gen.length+1).fill(0);for(var j=0;j<gen.length;j++){ng[j]^=gen[j];ng[j+1]^=mul(gen[j],EXP[i])}gen=ng}
var res=new Array(n).fill(0);data.forEach(function(d){var f=d^res[0];res.shift();res.push(0);for(var j=0;j<n;j++)res[j]^=mul(gen[j+1],f)});return res}
var CAP=[[19,7],[34,10],[55,15],[80,20],[108,26]];
function make(text){var b=Array.from(new TextEncoder().encode(text)),v=0;while(v<5&&b.length>CAP[v][0]-2)v++;if(v>=5)return null;v++;
var dc=CAP[v-1][0],ec=CAP[v-1][1],bits=[];function put(val,n){for(var i=n-1;i>=0;i--)bits.push((val>>i)&1)}
put(4,4);put(b.length,8);b.forEach(function(c){put(c,8)});put(0,Math.min(4,dc*8-bits.length));while(bits.length%8)bits.push(0);
var data=[];for(var i=0;i<bits.length;i+=8){var o=0;for(var j=0;j<8;j++)o=o<<1|bits[i+j];data.push(o)}for(var p=0;data.length<dc;p++)data.push(p%2?17:236);
var all=data.concat(ecc(data,ec)),n=17+4*v,m=[],fn=[];for(i=0;i<n;i++){m.push(new Array(n).fill(0));fn.push(new Array(n).fill(false))}
function set(r,c,val){if(r>=0&&c>=0&&r<n&&c<n){m[r][c]=val?1:0;fn[r][c]=true}}
function finder(r,c){for(var y=-1;y<=7;y++)for(var xx=-1;xx<=7;xx++){var on=y>=0&&y<=6&&xx>=0&&xx<=6&&(y==0||y==6||xx==0||xx==6||(y>=2&&y<=4&&xx>=2&&xx<=4));set(r+y,c+xx,on)}}
finder(0,0);finder(0,n-7);finder(n-7,0);
for(i=8;i<n-8;i++){set(6,i,i%2==0);set(i,6,i%2==0)}
if(v>1){var a=4*v+10;for(var y=-2;y<=2;y++)for(var xx=-2;xx<=2;xx++)set(a+y,a+xx,Math.max(Math.abs(y),Math.abs(xx))!=1)}
set(n-8,8,true);
var fmt=(1<<3|0)<<10,rem=fmt;for(i=14;i>=10;i--)if((rem>>i)&1)rem^=0x537<<(i-10);var fb=((1<<3|0)<<10|rem)^0x5412;
function fbit(i){return (fb>>i)&1}
for(i=0;i<=5;i++)set(i,8,fbit(i));set(7,8,fbit(6));set(8,8,fbit(7));set(8,7,fbit(8));for(i=9;i<15;i++)set(8,14-i,fbit(i));
for(i=0;i<8;i++)set(8,n-1-i,fbit(i));for(i=8;i<15;i++)set(n-15+i,8,fbit(i));set(n-8,8,true);
var bi=0,up=true,tb=[];all.forEach(function(c){for(var j=7;j>=0;j--)tb.push((c>>j)&1)});
for(var col=n-1;col>0;col-=2){if(col==6)col--;for(var k=0;k<n;k++){var r=up?n-1-k:k;for(var d=0;d<2;d++){var cc=col-d;if(!fn[r][cc]){var bit=bi<tb.length?tb[bi]:0;bi++;if((r+cc)%2==0)bit^=1;m[r][cc]=bit}}}up=!up}
return m}
g.PrismQR={make:make,draw:function(canvas,text,px){var m=make(text);if(!m)return false;var q=4,n=m.length;canvas.width=canvas.height=(n+2*q)*px;var c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#000';for(var y=0;y<n;y++)for(var x=0;x<n;x++)if(m[y][x])c.fillRect((x+q)*px,(y+q)*px,px,px);return true}}
})(window);
