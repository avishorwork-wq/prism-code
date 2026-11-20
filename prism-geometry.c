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
 float*ims[3]={im0,im1,im2};
 for(int i=0;i<n;i++){
  double*c=pts+i*5,u=2*c[0]-1,v=2*c[1]-1,t=axis?v:u,a=p[8],z=js_cos(a*t)-js_cos(a),den=max(.3,1+p[10]*z),aa=(js_sin(a*t)/js_sin(a)+p[9]*z)/den,bb=((axis?u:v)+p[11]*z)/den,X=(1+(axis?bb:aa))/2,Y=(1+(axis?aa:bb))/2,d=p[6]*X+p[7]*Y+1,qx=(p[0]*X+p[1]*Y+p[2])/d,qy=(p[3]*X+p[4]*Y+p[5])/d,x=qx*w,y=qy*h;
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
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){double v=0;if(x>=r&&x<w-r){int at=y*w+x-r;for(int j=0;j<count;j++)v+=(double)a[at+j]*k[j];}else for(int d=-r;d<=r;d++){int xx=x+d;if(xx<0)xx=0;if(xx>=w)xx=w-1;v+=(double)a[y*w+xx]*k[d+r];}tmp[y*w+x]=(float)v;}
 for(int y=0;y<h;y++)for(int x=0;x<w;x++){double v=0;if(y>=r&&y<h-r){int at=(y-r)*w+x;for(int j=0;j<count;j++,at+=w)v+=(double)tmp[at]*k[j];}else for(int d=-r;d<=r;d++){int yy=y+d;if(yy<0)yy=0;if(yy>=h)yy=h-1;v+=(double)tmp[yy*w+x]*k[d+r];}out[y*w+x]=(float)v;}
}
