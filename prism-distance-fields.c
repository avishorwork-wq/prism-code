__attribute__((export_name("distance"))) void distance(float*m,int w,int h){
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){int i=y*w+x;double d=m[i],v;if(x){v=m[i-1]+1.;if(v<d)d=v;}if(y){v=m[i-w]+1.;if(v<d)d=v;}if(x&&y){v=m[i-w-1]+1.414;if(v<d)d=v;}if(x<w-1&&y){v=m[i-w+1]+1.414;if(v<d)d=v;}m[i]=(float)d;}
 for(int y=h-1;y>=0;y--)for(int x=w-1;x>=0;x--){int i=y*w+x;double d=m[i],v;if(x<w-1){v=m[i+1]+1.;if(v<d)d=v;}if(y<h-1){v=m[i+w]+1.;if(v<d)d=v;}if(x<w-1&&y<h-1){v=m[i+w+1]+1.414;if(v<d)d=v;}if(x&&y<h-1){v=m[i+w-1]+1.414;if(v<d)d=v;}m[i]=(float)d;}
}
__attribute__((export_name("fields"))) void fields(float*a,float*tmp,int w,int h){int n=w*h;for(int s=0;s<9;s++)distance(a+s*n,w,h);for(int s=0;s<9;s++){float*m=a+s*n;for(int i=0;i<n;i++)tmp[i]=m[i]==0?1000:0;distance(tmp,w,h);for(int i=0;i<n;i++){double v=1.7-tmp[i]/.6;if(v<0)v=0;m[i]=(float)(m[i]/.6+v*.7);}}}
