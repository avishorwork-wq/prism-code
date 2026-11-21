typedef unsigned char u8;
static u8 ex[512],lg[256];static int ready;
static u8 mul(u8 a,u8 b){return a&&b?ex[lg[a]+lg[b]]:0;}
static u8 dv(u8 a,u8 b){return a?ex[(lg[a]+255-lg[b])%255]:0;}
static u8 val(u8*p,int n,u8 x){u8 y=0;for(int i=n-1;i>=0;i--)y=mul(y,x)^p[i];return y;}
static void product(u8*a,int na,u8*b,int nb,u8*out){for(int i=0;i<na+nb-1;i++)out[i]=0;for(int i=0;i<na;i++)for(int j=0;j<nb;j++)out[i+j]^=mul(a[i],b[j]);}
static void syndrome(u8*r,int n,int ns,u8*s){for(int j=0;j<ns;j++){u8 y=0;for(int i=0;i<n;i++)y=mul(y,ex[j])^r[i];s[j]=y;}}
__attribute__((export_name("decode"))) int decode(u8*input,int n,int ns,int*erasures,int ne,u8*out,u8*cached){
 if(!ready){int z=1;for(int i=0;i<255;i++){ex[i]=z;lg[z]=i;z<<=1;if(z&256)z^=0x11d;}for(int i=255;i<512;i++)ex[i]=ex[i-255];ready=1;}
 if(n<1||n>255||ns<0||ns>254||ns>n||ne<0||ne>ns)return -1;
 u8 r[256],s[256],G[512]={1},T[256],tmp[1024],c[512]={1},b[512]={1},old[512],loc[1024],omega[1024],der[1024]={0};int ng=1,nt=ns;
 for(int i=0;i<n;i++)r[i]=input[i];if(cached){for(int i=0;i<ns;i++)s[i]=cached[i];}else syndrome(r,n,ns,s);int nonzero=0;for(int i=0;i<ns;i++)nonzero|=s[i];if(!nonzero){for(int i=0;i<n;i++)out[i]=r[i];return 0;}
 for(int i=0;i<ns;i++)T[i]=s[i];for(int j=0;j<ne;j++){int p=erasures[j];if(p<0||p>=n)return -1;u8 X=ex[n-1-p],pair[2]={1,X};product(G,ng,pair,2,tmp);ng++;for(int i=0;i<ng;i++)G[i]=tmp[i];for(int i=0;i<nt-1;i++)T[i]=mul(T[i],X)^T[i+1];nt--;}
 int L=0,m=1;u8 bb=1;for(int j=0;j<nt;j++){u8 d=T[j];for(int i=1;i<=L;i++)d^=mul(c[i],T[j-i]);if(!d){m++;continue;}for(int i=0;i<=nt;i++)old[i]=c[i];u8 v=dv(d,bb);for(int i=0;i+m<=nt;i++)c[i+m]^=mul(v,b[i]);if(2*L<=j){L=j+1-L;for(int i=0;i<=nt;i++)b[i]=old[i];bb=d;m=1;}else m++;}
 if(2*L+ne>ns)return -1;int nl=ng+L;product(G,ng,c,L+1,loc);int pos[256],np=0;for(int p=0;p<n;p++){int e=n-1-p;if(val(loc,nl,ex[(255-e)%255])==0)pos[np++]=p;}if(np!=nl-1)return -1;product(s,ns,loc,nl,omega);int nd=nl-1;if(nd<1)nd=1;for(int i=1;i<nl;i+=2)der[i-1]=loc[i];for(int i=0;i<np;i++){int p=pos[i],e=n-1-p;u8 X=ex[e],xi=ex[(255-e)%255],den=val(der,nd,xi);if(!den)return -1;r[p]^=dv(mul(X,val(omega,ns,xi)),den);}syndrome(r,n,ns,s);for(int i=0;i<ns;i++)if(s[i])return -1;for(int i=0;i<n;i++)out[i]=r[i];return np;
}
