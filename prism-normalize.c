__attribute__((export_name("distance"))) void distance(float*m,int w,int h){
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){int i=y*w+x;double d=m[i],v;if(x){v=m[i-1]+1.;if(v<d)d=v;}if(y){v=m[i-w]+1.;if(v<d)d=v;}if(x&&y){v=m[i-w-1]+1.414;if(v<d)d=v;}if(x<w-1&&y){v=m[i-w+1]+1.414;if(v<d)d=v;}m[i]=(float)d;}
 for(int y=h-1;y>=0;y--)for(int x=w-1;x>=0;x--){int i=y*w+x;double d=m[i],v;if(x<w-1){v=m[i+1]+1.;if(v<d)d=v;}if(y<h-1){v=m[i+w]+1.;if(v<d)d=v;}if(x<w-1&&y<h-1){v=m[i+w+1]+1.414;if(v<d)d=v;}if(x&&y<h-1){v=m[i+w-1]+1.414;if(v<d)d=v;}m[i]=(float)d;}
}
__attribute__((export_name("fields"))) void fields(float*a,float*tmp,int w,int h){int n=w*h;for(int s=0;s<9;s++)distance(a+s*n,w,h);for(int s=0;s<9;s++){float*m=a+s*n;for(int i=0;i<n;i++)tmp[i]=m[i]==0?1000:0;distance(tmp,w,h);for(int i=0;i<n;i++){double v=1.7-tmp[i]/.6;if(v<0)v=0;m[i]=(float)(m[i]/.6+v*.7);}}}
__attribute__((export_name("morph"))) void morph(unsigned char*a,unsigned char*tmp,unsigned char*out,int w,int h,int r,int ismax){
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){int v=ismax?0:1;for(int d=-r;d<=r;d++){int xx=x+d;if(xx<0)xx=0;if(xx>=w)xx=w-1;if(ismax)v|=a[y*w+xx];else v&=a[y*w+xx];}tmp[y*w+x]=v;}
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){int v=ismax?0:1;for(int d=-r;d<=r;d++){int yy=y+d;if(yy<0)yy=0;if(yy>=h)yy=h-1;if(ismax)v|=tmp[yy*w+x];else v&=tmp[yy*w+x];}out[y*w+x]=v;}
}
__attribute__((export_name("smooth"))) void smooth(float*a,float*tmp,float*out,int*positions,float*values,int w,int h,int r,int ismax){
 for(int y=0;y<h;y++){int head=0,tail=0;double sum=0;for(int x=-r;x<w+r;x++){int xx=x;if(xx<0)xx=0;if(xx>=w)xx=w-1;float v=a[y*w+xx];if(ismax){while(tail>head&&values[tail-1]<=v)tail--;positions[tail]=x;values[tail++]=v;while(positions[head]<x-2*r)head++;}else{sum+=v;if(x>r){xx=x-2*r-1;if(xx<0)xx=0;if(xx>=w)xx=w-1;sum-=a[y*w+xx];}}if(x>=r)tmp[y*w+x-r]=ismax?values[head]:(float)(sum/(2*r+1));}}
 for(int x=0;x<w;x++){int head=0,tail=0;double sum=0;for(int y=-r;y<h+r;y++){int yy=y;if(yy<0)yy=0;if(yy>=h)yy=h-1;float v=tmp[yy*w+x];if(ismax){while(tail>head&&values[tail-1]<=v)tail--;positions[tail]=y;values[tail++]=v;while(positions[head]<y-2*r)head++;}else{sum+=v;if(y>r){yy=y-2*r-1;if(yy<0)yy=0;if(yy>=h)yy=h-1;sum-=tmp[yy*w+x];}}if(y>=r)out[(y-r)*w+x]=ismax?values[head]:(float)(sum/(2*r+1));}}
}
__attribute__((export_name("normalize"))) void normalize(unsigned char*rgba,unsigned char*out,float*a,float*tmp,float*mx,int*pos,float*values,int w,int h,int r){
 int n=w*h;for(int k=0;k<3;k++){
 int hist[256]={0};for(int i=0;i<n;i++){int v=rgba[i*4+k];hist[v]++;a[i]=v;}
 int bottom=0,sum=0;for(int i=0;i<256;i++){sum+=hist[i];if(sum>n*.02){bottom=i;break;}}
 smooth(a,tmp,mx,pos,values,w,h,r,1);
 for(int i=0;i<n;i++){double den=mx[i]-bottom;if(den<30)den=30;double v=((double)a[i]-bottom)*255/den;if(v<0)v=0;if(v>255)v=255;out[i*4+k]=(unsigned char)__builtin_nearbyint(v);}
 }for(int i=0;i<n;i++)out[i*4+3]=255;
}
