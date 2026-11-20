#include <wasm_simd128.h>
// Scalar double-precision geometry kernel. No decoder or payload acceptance logic.
__attribute__((import_module("env"), import_name("sin"))) double js_sin(double);
__attribute__((import_module("env"), import_name("cos"))) double js_cos(double);
static double max(double a,double b){return a>b?a:b;}
__attribute__((export_name("analytic"))) void analytic(double*p,double*pts,float*im0,float*im1,float*im2,int w,int h,int axis,int n,double*r,double*jac){
 double a=p[8],ca=js_cos(a),sa=js_sin(a); int len=n*3;
 float*ims[3]={im0,im1,im2};
 for(int i=0;i<n;i++){
  double*c=pts+i*5,u=2*c[0]-1,v=2*c[1]-1,t=axis?v:u,cat=js_cos(a*t),sat=js_sin(a*t),z=cat-ca,dz=-t*sat+sa,S=sat/sa,dS=(t*cat*sa-sat*ca)/(sa*sa),raw=1+p[10]*z,den=max(.3,raw),dd=raw>.3?p[10]*dz:0,dd10=raw>.3?z:0,aa=(S+p[9]*z)/den,bb=((axis?u:v)+p[11]*z)/den,X=(1+(axis?bb:aa))/2,Y=(1+(axis?aa:bb))/2,d=p[6]*X+p[7]*Y+1,nx=(p[0]*X+p[1]*Y+p[2])/d,ny=(p[3]*X+p[4]*Y+p[5])/d,x=nx*w,y=ny*h;
  if(x>=0&&y>=0&&x<w-1&&y<h-1){
   int ix=(int)x,iy=(int)y,k=iy*w+ix;double fx=x-ix,fy=y-iy,dx[12]={0},dy[12]={0};
   dx[0]=w*X/d;dx[1]=w*Y/d;dx[2]=(double)w/d;dy[3]=h*X/d;dy[4]=h*Y/d;dy[5]=(double)h/d;dx[6]=-w*nx*X/d;dx[7]=-w*nx*Y/d;dy[6]=-h*ny*X/d;dy[7]=-h*ny*Y/d;
   double ax=(p[0]-nx*p[6])*w/d,bx=(p[1]-nx*p[7])*w/d,ay=(p[3]-ny*p[6])*h/d,by=(p[4]-ny*p[7])*h/d;
   for(int j=8;j<12;j++){
    double da=j==8?((dS+p[9]*dz)-aa*dd)/den:j==9?z/den:j==10?-aa*dd10/den:0,db=j==8?(p[11]*dz-bb*dd)/den:j==10?-bb*dd10/den:j==11?z/den:0,dX=.5*(axis?db:da),dY=.5*(axis?da:db);
    dx[j]=ax*dX+bx*dY;dy[j]=ay*dX+by*dY;
   }
   for(int ch=0;ch<3;ch++){
    float*im=ims[ch];double v00=im[k],v10=im[k+1],v01=im[k+w],v11=im[k+w+1],gx=(v10-v00)*(1-fy)+(v11-v01)*fy,gy=(v01-v00)*(1-fx)+(v11-v10)*fx;int at=i*3+ch;
    r[at]=(v00*(1-fx)+v10*fx)*(1-fy)+(v01*(1-fx)+v11*fx)*fy-c[ch+2];
    for(int j=0;j<12;j++)jac[j*len+at]=gx*dx[j]+gy*dy[j];
   }
  }else for(int ch=0;ch<3;ch++){int at=i*3+ch;r[at]=1-c[ch+2];for(int j=0;j<12;j++)jac[j*len+at]=0;}
 }
}
__attribute__((export_name("residual"))) void residual(double*p,double*pts,float*im0,float*im1,float*im2,int w,int h,int axis,int n,double*r){
 float*ims[3]={im0,im1,im2};double a=p[8],ca=js_cos(a),sa=js_sin(a);
 for(int i=0;i<n;i++){
  double*c=pts+i*5,u=2*c[0]-1,v=2*c[1]-1,t=axis?v:u,z=js_cos(a*t)-ca,den=max(.3,1+p[10]*z),aa=(js_sin(a*t)/sa+p[9]*z)/den,bb=((axis?u:v)+p[11]*z)/den,X=(1+(axis?bb:aa))/2,Y=(1+(axis?aa:bb))/2,d=p[6]*X+p[7]*Y+1,qx=(p[0]*X+p[1]*Y+p[2])/d,qy=(p[3]*X+p[4]*Y+p[5])/d,x=qx*w,y=qy*h;
  for(int ch=0;ch<3;ch++){
   double value=1;if(x>=0&&y>=0&&x<w-1&&y<h-1){int ix=(int)x,iy=(int)y,k=iy*w+ix;double u=x-ix,t=y-iy;float*im=ims[ch];value=(im[k]*(1-u)+im[k+1]*u)*(1-t)+(im[k+w]*(1-u)+im[k+w+1]*u)*t;}r[i*3+ch]=value-c[ch+2];
  }
 }
}
__attribute__((export_name("normal"))) void normal(double*jac,double*r,int n,double*out){
 for(int j=0;j<12;j++){double*x=jac+j*n,s=0;for(int i=0;i<n;i++)s-=x[i]*r[i];out[144+j]=s;for(int k=0;k<=j;k++){double*y=jac+k*n,sum=0;for(int i=0;i<n;i++)sum+=x[i]*y[i];out[j*12+k]=out[k*12+j]=sum;}}
}
__attribute__((export_name("blur"))) void blur(float*restrict a,float*restrict tmp,float*restrict out,double*restrict k,int w,int h,int r){
 int count=2*r+1;
 for(int y=0;y<h;y++){int x=0;for(;x<w;x++){if(x>=r&&x+1<w-r){v128_t v=wasm_f64x2_splat(0);int at=y*w+x-r;for(int j=0;j<count;j++)v=wasm_f64x2_add(v,wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(a+at+j)),wasm_f64x2_splat(k[j])));wasm_v128_store64_lane(tmp+y*w+x,wasm_f32x4_demote_f64x2_zero(v),0);x++;}else{double v=0;for(int d=-r;d<=r;d++){int xx=x+d;if(xx<0)xx=0;if(xx>=w)xx=w-1;v+=(double)a[y*w+xx]*k[d+r];}tmp[y*w+x]=(float)v;}}}
 for(int y=0;y<h;y++){int x=0;for(;x+1<w;x+=2){v128_t v=wasm_f64x2_splat(0);for(int d=-r;d<=r;d++){int yy=y+d;if(yy<0)yy=0;if(yy>=h)yy=h-1;v=wasm_f64x2_add(v,wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(tmp+yy*w+x)),wasm_f64x2_splat(k[d+r])));}wasm_v128_store64_lane(out+y*w+x,wasm_f32x4_demote_f64x2_zero(v),0);}if(x<w){double v=0;for(int d=-r;d<=r;d++){int yy=y+d;if(yy<0)yy=0;if(yy>=h)yy=h-1;v+=(double)tmp[yy*w+x]*k[d+r];}out[y*w+x]=(float)v;}}
}
static double absd(double x){return x<0?-x:x;}
static double loss_value(double*r,int n){double s=0;for(int i=0;i<n;i++)s+=r[i]*r[i];return s/n;}
static int solve12(double*A,double*b,double*out){double m[12][13];for(int i=0;i<12;i++){for(int j=0;j<12;j++)m[i][j]=A[i*12+j];m[i][12]=b[i];}for(int j=0;j<12;j++){int p=j;for(int k=j+1;k<12;k++)if(absd(m[k][j])>absd(m[p][j]))p=k;if(absd(m[p][j])<1e-18)return 0;if(p!=j)for(int k=0;k<13;k++){double v=m[j][k];m[j][k]=m[p][k];m[p][k]=v;}double v=m[j][j];for(int k=j;k<=12;k++)m[j][k]/=v;for(int i=0;i<12;i++)if(i!=j){v=m[i][j];for(int k=j;k<=12;k++)m[i][k]-=v*m[j][k];}}for(int i=0;i<12;i++)out[i]=m[i][12];return 1;}
__attribute__((export_name("optimize"))) void optimize(double*p,double*pts,float*im0,float*im1,float*im2,int w,int h,int axis,int n,int maxiter,double*r,double*jac,double*out){
 residual(p,pts,im0,im1,im2,w,h,axis,n,r);double cost=loss_value(r,n*3),lambda=.01;int reject=0;out[1]=-1;
 for(int iter=0;iter<maxiter;iter++){double A[156];analytic(p,pts,im0,im1,im2,w,h,axis,n,r,jac);normal(jac,r,n*3,A);int accepted=0;
  for(int attempt=0;attempt<8;attempt++){double AA[144],step[12],pp[12];for(int i=0;i<12;i++)for(int j=0;j<12;j++)AA[i*12+j]=A[i*12+j]+(i==j?lambda*max(1e-6,A[i*12+i]):0);if(!solve12(AA,A+144,step))break;for(int i=0;i<12;i++)pp[i]=p[i]+step[i];if(pp[8]==pp[8])pp[8]=max(.02,pp[8]<1.4?pp[8]:1.4);for(int j=9;j<12;j++)if(pp[j]==pp[j])pp[j]=max(-2,pp[j]<2?pp[j]:2);residual(pp,pts,im0,im1,im2,w,h,axis,n,r);double cc=loss_value(r,n*3);if(cc<cost){double gain=cost-cc;for(int i=0;i<12;i++)p[i]=pp[i];cost=cc;lambda=max(1e-7,lambda*.4);accepted=1;if(gain<1e-10){out[0]=cost;out[1]=iter;return;}break;}lambda=lambda*5<1e8?lambda*5:1e8;}
  if(!accepted){if(++reject>2)break;}else reject=0;
 }out[0]=cost;
}
