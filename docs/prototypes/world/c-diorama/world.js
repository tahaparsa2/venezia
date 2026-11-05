/* Venezia, direction C: the diorama.
   Every mesh, texture and light in here is procedural. Budget: about 25k triangles,
   under 40 draw calls with the reflection pass, one fullscreen shader at full size.
   Colours are authored in display space on purpose; there is no tone mapping pass. */
(function () {
'use strict';
const T = window.THREE;
const qs = new URLSearchParams(location.search);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- small helpers ---------- */
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const R = rng(1498);            /* De' Barbari's first block */
const rr = (a,b)=>a+(b-a)*R();
const lerp=(a,b,t)=>a+(b-a)*t, clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const hex=(h)=>[(h>>16&255)/255,(h>>8&255)/255,(h&255)/255];

/* ---------- geometry collector: flat shaded, non-indexed ---------- */
class Geo{
  constructor(){this.p=[];this.n=[];this.c=[];this.uv=[];this.e=[];this.part=[];this.anim=[];this.curPart=0;this.curAnim=[0,0,0,0];this.emit=0;}
  vert(v,n,c,u,w){this.p.push(v[0],v[1],v[2]);this.n.push(n[0],n[1],n[2]);this.c.push(c[0],c[1],c[2]);this.uv.push(u,w);this.e.push(this.emit);this.part.push(this.curPart);this.anim.push(this.curAnim[0],this.curAnim[1],this.curAnim[2],this.curAnim[3]);}
  tri(a,b,c,col,cB,cC,uvs){
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    let n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];const l=Math.hypot(n[0],n[1],n[2])||1;n=[n[0]/l,n[1]/l,n[2]/l];
    const k=uvs?1:0;
    this.vert(a,n,col,k?uvs[0]:0,k?uvs[1]:0);this.vert(b,n,cB||col,k?uvs[2]:0,k?uvs[3]:0);this.vert(c,n,cC||col,k?uvs[4]:0,k?uvs[5]:0);
  }
  /* a b c d counter clockwise from outside. uv runs along ab and up ad, in world units. */
  quad(a,b,c,d,col,s,colTop){
    s=s||.25;const ab=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]),ad=Math.hypot(d[0]-a[0],d[1]-a[1],d[2]-a[2]);
    const o=(a[0]*.37+a[1]*.13+a[2]*.71)*s, u1=o+ab*s, v0=(a[1]+a[2]*.31)*s, v1=v0+ad*s, ct=colTop||col;
    this.tri(a,b,c,col,col,ct,[o,v0,u1,v0,u1,v1]);this.tri(a,c,d,col,ct,ct,[o,v0,u1,v1,o,v1]);
  }
  box(cx,y0,cz,w,h,d,col,o){
    o=o||{};const x0=cx-w/2,x1=cx+w/2,z0=cz-d/2,z1=cz+d/2,y1=y0+h,s=o.s,ct=o.colTop||col,top=o.top||ct;
    this.quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],col,s,ct);
    this.quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],col,s,ct);
    this.quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],col,s,ct);
    this.quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],col,s,ct);
    if(!o.noTop)this.quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],top,s);
  }
  /* a tapered four sided bar between two points: masts, spars, oars, rigging */
  bar(a,b,w,col,w2){
    w2=w2===undefined?w:w2;const d=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],l=Math.hypot(d[0],d[1],d[2])||1,t=[d[0]/l,d[1]/l,d[2]/l];
    let u=Math.abs(t[1])>.9?[1,0,0]:[0,1,0];
    let s=[t[1]*u[2]-t[2]*u[1],t[2]*u[0]-t[0]*u[2],t[0]*u[1]-t[1]*u[0]];const sl=Math.hypot(s[0],s[1],s[2]);s=s.map(v=>v/sl);
    u=[s[1]*t[2]-s[2]*t[1],s[2]*t[0]-s[0]*t[2],s[0]*t[1]-s[1]*t[0]];
    const c=(p,sa,ua,r)=>[p[0]+(s[0]*sa+u[0]*ua)*r,p[1]+(s[1]*sa+u[1]*ua)*r,p[2]+(s[2]*sa+u[2]*ua)*r];
    const ks=[[1,1],[-1,1],[-1,-1],[1,-1]];
    for(let i=0;i<4;i++){const k=ks[i],m=ks[(i+1)%4];this.quad(c(a,k[0],k[1],w),c(a,m[0],m[1],w),c(b,m[0],m[1],w2),c(b,k[0],k[1],w2),col);}
  }
  cyl(x,y,z,r0,r1,h,n,col,colTop){
    for(let i=0;i<n;i++){const a=i/n*6.283,b=(i+1)/n*6.283;
      this.quad([x+Math.sin(a)*r0,y,z+Math.cos(a)*r0],[x+Math.sin(b)*r0,y,z+Math.cos(b)*r0],[x+Math.sin(b)*r1,y+h,z+Math.cos(b)*r1],[x+Math.sin(a)*r1,y+h,z+Math.cos(a)*r1],col,.25,colTop);}
  }
  build(){
    const g=new T.BufferGeometry();
    g.setAttribute('position',new T.Float32BufferAttribute(this.p,3));
    g.setAttribute('normal',new T.Float32BufferAttribute(this.n,3));
    g.setAttribute('col',new T.Float32BufferAttribute(this.c,3));
    g.setAttribute('uv',new T.Float32BufferAttribute(this.uv,2));
    g.setAttribute('e',new T.Float32BufferAttribute(this.e,1));
    g.setAttribute('part',new T.Float32BufferAttribute(this.part,1));
    g.setAttribute('anim',new T.Float32BufferAttribute(this.anim,4));
    return g;
  }
}

/* ---------- procedural textures ---------- */
function noiseTexture(size){
  const d=new Uint8Array(size*size*4), waves=[];
  const r=rng(1104);
  for(let c=0;c<3;c++){const a=[];for(let i=0;i<22;i++){const f=1+Math.floor(r()*(2+i*.55));const fx=Math.floor(r()*2*f+1)-f,fy=Math.floor(r()*2*f+1)-f;a.push([fx,fy,r()*6.283,1/Math.hypot(fx||1,fy||1)]);}waves.push(a);}
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;
    for(let c=0;c<3;c++){let v=0;const a=waves[c];for(let k=0;k<a.length;k++){const w=a[k];v+=Math.cos(6.2832*(w[0]*x+w[1]*y)/size+w[2])*w[3];}d[i+c]=clamp(v*.16+.5)*255;}
    d[i+3]=255;}
  const t=new T.DataTexture(d,size,size,T.RGBAFormat);t.wrapS=t.wrapT=T.RepeatWrapping;t.minFilter=T.LinearMipmapLinearFilter;t.magFilter=T.LinearFilter;t.generateMipmaps=true;t.needsUpdate=true;return t;
}
function canvasTex(size,draw,aniso){
  const c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d');draw(x,size);
  const t=new T.CanvasTexture(c);t.wrapS=t.wrapT=T.RepeatWrapping;t.minFilter=T.LinearMipmapLinearFilter;t.anisotropy=aniso||4;return t;
}
function brickTexture(){return canvasTex(512,(x,S)=>{
  const r=rng(1320),rows=20,h=S/rows;
  x.fillStyle='#8d8378';x.fillRect(0,0,S,S);
  for(let j=0;j<rows;j++){const w=S/8,o=j%2?w/2:0;
    for(let i=-1;i<9;i++){const v=r();const R0=150+v*80,G=78+v*44,B=56+v*30,k=.84+r()*.3;
      x.fillStyle=`rgb(${R0*k|0},${G*k|0},${B*k|0})`;x.fillRect(i*w+o+1.5,j*h+1.5,w-3,h-3);}}
  /* patched intonaco: Venice's brick shows through fallen plaster */
  for(let i=0;i<34;i++){const px=r()*S,py=r()*S,s=20+r()*80;x.fillStyle=`rgba(${205+r()*30|0},${190+r()*30|0},${160+r()*20|0},${.1+r()*.3})`;x.beginPath();for(let a=0;a<9;a++){const q=a/9*6.283,rad=s*(.5+r()*.6);x.lineTo(px+Math.cos(q)*rad,py+Math.sin(q)*rad*.6);}x.fill();}
});}
function roofTexture(){return canvasTex(512,(x,S)=>{
  const r=rng(1473),rows=14,h=S/rows,cols=14,w=S/cols;
  x.fillStyle='#2e1a13';x.fillRect(0,0,S,S);
  for(let j=0;j<rows;j++)for(let i=-1;i<=cols;i++){const v=r(),o=j%2?w/2:0;
    x.fillStyle=`rgb(${150+v*80|0},${82+v*50|0},${60+v*32|0})`;
    x.beginPath();x.ellipse(i*w+o+w/2,j*h+h*.48,w*.46,h*.56,0,0,6.283);x.fill();
    x.fillStyle='rgba(30,12,8,.35)';x.fillRect(i*w+o,j*h+h*.86,w,h*.14);}
});}
function strataTexture(){const c=document.createElement('canvas');c.width=1024;c.height=128;const x=c.getContext('2d'),r=rng(1564);
  const g=x.createLinearGradient(0,0,0,128);g.addColorStop(0,'#6d5243');g.addColorStop(.16,'#6d5243');g.addColorStop(.18,'#3a3631');g.addColorStop(.62,'#4a3d2f');g.addColorStop(1,'#231e19');x.fillStyle=g;x.fillRect(0,0,1024,128);
  for(let i=0;i<500;i++){x.fillStyle=`rgba(${120+r()*90|0},${100+r()*70|0},${70+r()*50|0},${r()*.25})`;x.fillRect(r()*1024,20+r()*108,2+r()*10,1+r()*2);}
  for(let i=0;i<46;i++){const px=r()*1024;x.fillStyle=`rgba(70,48,30,.8)`;x.fillRect(px,30+r()*10,4,70+r()*20);}
  const t=new T.CanvasTexture(c);t.wrapS=T.RepeatWrapping;t.anisotropy=4;return t;}

/* ---------- shaders ---------- */
const WORLD_V=`
attribute vec3 col; attribute float e; attribute float part; attribute vec4 anim;
varying vec3 vW,vN,vC,vL; varying vec2 vUv; varying float vE;
uniform float uTime,uProgress,uWind,uRow;
void main(){
  vec3 p=position; vec3 n=normal;
#ifdef HULL
  if(part>uProgress+.0001){ gl_Position=vec4(0.,0.,2.,1.); return; }
  if(anim.x>.5&&anim.x<1.5){ /* oar sweep about its thole pin */
    float a=sin(uTime*1.7+anim.w*.45)*.34*uRow; float s=sin(a),c=cos(a);
    vec2 q=p.xz-anim.yz; p.xz=vec2(q.x*c-q.y*s,q.x*s+q.y*c)+anim.yz;
    p.y+=(cos(uTime*1.7+anim.w*.45))*.14*uRow*smoothstep(.2,2.,abs(q.x));
  }
  if(anim.x>1.5){ /* pennant, stands out with the wind */
    float d=anim.y; float w=sin(uTime*(4.+uWind*5.)-d*3.)*(.06+.1*uWind)*d;
    p.y+=w-(1.-uWind)*d*.4; p.x+=w*.8; 
  }
#endif
  vec4 w=modelMatrix*vec4(p,1.); vW=w.xyz; vN=mat3(modelMatrix)*n; vC=col; vE=e; vUv=uv; vL=position;
  gl_Position=projectionMatrix*viewMatrix*w;
}`;
const WORLD_F=`
precision highp float;
varying vec3 vW,vN,vC,vL; varying vec2 vUv; varying float vE;
uniform sampler2D tMap; uniform float uTexAmt,uTexGrey,uMirror,uTime,uGild,uShade,uSoak;
uniform vec3 uSky,uGnd,uKeyDir,uKeyCol,uHaze,uTint; uniform float uHazeK;
uniform vec4 uLP[4]; uniform vec3 uLC[4]; uniform vec4 uRing[3];
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
void main(){
  vec3 W=vW, N=normalize(vN);
  if(uMirror>.5){ W.y=-W.y; N.y=-N.y; if(W.y<-.02) discard; }
  vec3 tx=texture2D(tMap,vUv).rgb; tx=mix(tx,vec3(tx.r),uTexGrey);
  vec3 tex=mix(vec3(1.),tx*1.5,uTexAmt);
  vec3 a=vC*tex*uTint;
  float ao=mix(.5,1.,smoothstep(.5,2.6,W.y));
  float hemi=.5+.5*N.y;
  vec3 L=mix(uGnd,uSky,hemi)*ao+uKeyCol*max(dot(N,uKeyDir),0.)*mix(.7,1.,ao);
  vec3 c=a*L*uShade;
#ifdef HULL
  if(uGild>.002){ /* gold leaf under glass: little tiles, each set at its own tilt */
    vec3 q=floor(vL*vec3(9.,9.,5.));
    float r1=h21(q.xy+q.z*.37), r2=h21(q.zy+q.x*.71);
    vec3 Nn=normalize(N+vec3(r1-.5,r2-.5,r1*r2-.25)*.9);
    vec3 V=normalize(cameraPosition-W);
    vec3 H=normalize(normalize(vec3(sin(uTime*.5)*.6,.65,cos(uTime*.37)*.6))+V);
    float s=pow(max(dot(Nn,H),0.),22.);
    float s2=pow(max(dot(Nn,normalize(uKeyDir+V)),0.),9.);
    vec3 g=vec3(.62,.41,.11)*(L*.95+.22)+vec3(1.,.8,.38)*(s*1.5+s2*.3);
    c=mix(c,g,uGild);
  }
#endif
  for(int i=0;i<4;i++){ vec3 d=uLP[i].xyz-W; float at=1./(1.+dot(d,d)*uLP[i].w); c+=a*uLC[i]*at*at; }
  for(int i=0;i<3;i++){ if(uRing[i].w>.001){ float r=length(W.xz-uRing[i].xy)-uRing[i].z; float b=exp(-r*r*.42)*uRing[i].w; c+=(a*.8+vec3(.05,.03,.0))*vec3(1.5,1.,.35)*b; } }
  c+=vC*vE;
  float dist=length(cameraPosition-W);
  c=mix(c,uHaze,clamp((dist-uHazeK)*.0075,0.,.34));
  gl_FragColor=vec4(c,1.);
}`;
const FLAT_V=`varying vec3 vW; varying vec2 vUv; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const WATER_F=`
precision highp float; varying vec3 vW;
uniform sampler2D tRefl,tNoise; uniform vec2 uRes; uniform float uTime,uChop,uDim,uStorm;
uniform vec2 uR; uniform vec3 uDeep,uSkyA,uSkyB; uniform vec4 uRip[8]; uniform vec4 uGlow[3]; uniform vec3 uGlowC[3]; uniform vec4 uSlick;
float sdBox(vec2 p,vec2 c,vec2 h){vec2 d=abs(p-c)-h;return length(max(d,0.))+min(max(d.x,d.y),0.);}
void main(){
  vec2 p=vW.xz;
  vec3 n1=texture2D(tNoise,p*.11+vec2(uTime*.013,uTime*.021)).xyz-.5;
  vec3 n2=texture2D(tNoise,p*.31-vec2(uTime*.03,-uTime*.041)).xyz-.5;
  vec3 n3=texture2D(tNoise,p*.83+vec2(-uTime*.07,uTime*.09)).xyz-.5;
  vec2 n=(n1.xy*.3+n2.xy*.4+n3.xy*.24)*uChop;
  float crest=0.,gold=0.;
  for(int i=0;i<8;i++){ if(uRip[i].w>.0005){
    vec2 dp=p-uRip[i].xy; float d=length(dp)+.001; float q=d-uRip[i].z;
    float env=exp(-q*q*.2);
    float w=sin(q*3.1)*env*uRip[i].w;
    n+=dp/d*w*.26; crest+=max(w,0.); gold+=(exp(-q*q*5.)+exp(-(q+1.1)*(q+1.1)*9.)*.5)*abs(uRip[i].w);
  }}
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 q2=vec2(dot(p,uR),dot(p,vec2(-uR.y,uR.x)));
  float ba=texture2D(tNoise,q2*vec2(.045,.34)+vec2(uTime*.009,uTime*.04)).x-.5;
  float bb=texture2D(tNoise,q2*vec2(.1,.8)-vec2(uTime*.017,uTime*.06)).y-.5;
  vec2 o=vec2((ba+bb)*.007,(ba*.8+bb)*.06)*uChop+n*vec2(.002,.006);
  vec4 r=texture2D(tRefl,uv+o);
  vec4 r2=texture2D(tRefl,uv+o*1.7+vec2(0.,.008));
  vec4 r3=texture2D(tRefl,uv+o*2.5+vec2(0.,.022));
  vec4 rf=r*.5+r2*.3+r3*.2;
  vec3 V=normalize(cameraPosition-vW);
  float fres=.56+.42*pow(1.-max(V.y,0.),2.);
  float sk=clamp((1.-V.y)*1.6-.2+n.y*.08,0.,1.);
  vec3 sky=mix(uSkyA,uSkyB,sk);
  vec3 refl=mix(sky,rf.rgb,clamp(rf.a,0.,1.));
  vec3 base=uDeep;
  vec3 c=mix(base,refl,fres+.2);
  c+=sky*max(n.x+n.y,0.)*.07;
  for(int i=0;i<3;i++){ if(uGlow[i].w>.002){ vec2 d=(p-uGlow[i].xy)/vec2(uGlow[i].z,uGlow[i].z*1.5); c+=uGlowC[i]*uGlow[i].w*exp(-dot(d,d))*(.62+n3.x*.9+n2.y*.6); } }
  if(uSlick.w>.01){ vec2 d=(p-uSlick.xy)/vec2(1.,1.7)+n*.9; float q=length(d)/uSlick.z; float sl=smoothstep(1.,.55,q)*uSlick.w; c=mix(c,vec3(.015,.015,.02)+.055*(.5+.5*sin(vec3(0.,2.1,4.2)+q*7.+uTime*.3)),sl*.86); }
  /* quay contact: dark line, a thin lit lip */
  float e=-min(sdBox(p,vec2(0.,-8.5),vec2(3.4,17.8)),sdBox(p,vec2(0.,17.5),vec2(8.,8.8)));
  c*=mix(.46,1.,smoothstep(0.,.75,e));
  c+=vec3(.26,.31,.34)*smoothstep(.13,.03,abs(e-.06-n.x*.1))*.45;
  c+=vec3(1.,.72,.3)*crest*.07+vec3(1.,.74,.3)*gold*1.05;
  gl_FragColor=vec4(c*(1.-uDim*.35),1.);
}`;
const TABLE_F=`
precision highp float; varying vec3 vW; uniform vec2 uRes; uniform vec4 uRing[3]; uniform float uDim; uniform sampler2D tNoise;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 low=vec3(.05,.115,.14), mid=vec3(.115,.25,.31), hi=vec3(.52,.42,.46);
  vec3 c=mix(low,mid,smoothstep(.15,.72,uv.y));
  c=mix(c,hi,smoothstep(.8,1.08,uv.y));
  float grain=texture2D(tNoise,vW.xz*vec2(.012,.09)).x;
  c*=.9+grain*.2;
  for(int i=0;i<3;i++){ if(uRing[i].w>.001){ float r=length(vW.xz-uRing[i].xy)-uRing[i].z; c+=vec3(.5,.34,.1)*exp(-r*r*.5)*uRing[i].w; } }
  gl_FragColor=vec4(c*(1.-uDim*.5),1.);
}`;
const SHADOW_F=`precision highp float; varying vec2 vUv; void main(){ vec2 d=abs(vUv-.5)*2.; float a=smoothstep(1.,.62,max(d.x,d.y)); gl_FragColor=vec4(0.01,.02,.03,a*.8); }`;
const WIN_V=`
attribute vec4 iP; attribute vec3 iS; attribute vec2 iO;
varying vec2 vUv; varying vec2 vO; varying vec3 vW; varying float vSeed;
void main(){ float c=cos(iP.w),s=sin(iP.w); vec3 q=vec3(position.x*iS.x,position.y*iS.y,0.); vec3 w=vec3(q.x*c,q.y,-q.x*s)+iP.xyz;
  vec4 wp=modelMatrix*vec4(w,1.); vUv=position.xy*vec2(1.,1.)+vec2(.5,0.); vO=iO; vSeed=iS.z; vW=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`;
const WIN_F=`
precision highp float; varying vec2 vUv; varying vec2 vO; varying float vSeed; varying vec3 vW; uniform float uTime,uMirror;
void main(){
  float open=vO.x; float hot=vO.y;
  float leaf=abs(vUv.x-.5)*2.;
  float a=step(leaf,open+.001);
  float fl=.9+.1*sin(uTime*(1.3+vSeed*2.)+vSeed*40.)*sin(uTime*.7+vSeed*17.);
  vec3 warm=mix(vec3(1.,.66,.26),vec3(1.,.86,.52),smoothstep(.1,.72,vUv.y*.6+.35-hot*.2));
  float mull=step(.075,abs(fract(vUv.x*3.)-.5)*2.)*step(.09,abs(fract(vUv.y*4.2)-.5)*2.);
  vec3 lit=warm*(.68+.42*mull)*fl*(.86+.3*hot);
  vec3 shut=vec3(.1,.07,.055)+vec3(.34,.2,.07)*step(.82,fract(vUv.x*6.))*(.6+.4*vUv.y);
  gl_FragColor=vec4(mix(shut,lit,a),1.);
}`;
const SPR_V=`
attribute vec3 iP; attribute vec2 iS; attribute vec4 iC; varying vec2 vUv; varying vec4 vC; varying vec2 vS;
void main(){ vS=iP.xz*.09; vec4 mv=viewMatrix*vec4(iP,1.); mv.xy+=vec2(position.x*iS.x,position.y*iS.x*iS.y); vUv=uv; vC=iC; gl_Position=projectionMatrix*mv; }`;
const ADD_F=`precision highp float; varying vec2 vUv; varying vec4 vC; void main(){ float d=length(vUv-.5)*2.; float a=1.-d; a=a*a*(1.+a); gl_FragColor=vec4(vC.rgb*a*vC.a,1.); }`;
const SOFT_F=`precision highp float; varying vec2 vUv; varying vec4 vC; varying vec2 vS; uniform sampler2D tNoise; uniform float uTime;
void main(){ float d=length(vUv-.5)*2.; float n=texture2D(tNoise,vUv*.3+vS+uTime*.006).z; float a=smoothstep(1.,.15,d)*smoothstep(.28,.7,n+.22*(1.-d)); gl_FragColor=vec4(vC.rgb,a*vC.a); }`;
const FS_V=`varying vec2 vUv; void main(){ vUv=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.); }`;
const DOWN_F=`precision mediump float; varying vec2 vUv; uniform sampler2D t; uniform vec2 px;
void main(){ vec3 c=(texture2D(t,vUv+px*vec2(-1.,-1.)).rgb+texture2D(t,vUv+px*vec2(1.,-1.)).rgb+texture2D(t,vUv+px*vec2(-1.,1.)).rgb+texture2D(t,vUv+px*vec2(1.,1.)).rgb)*.25;
 float l=max(c.r,max(c.g*1.1,c.b*.8)); gl_FragColor=vec4(c,smoothstep(.74,1.,l)); }`;
const KAWASE_F=`precision mediump float; varying vec2 vUv; uniform sampler2D t; uniform vec2 px; uniform float o;
void main(){ gl_FragColor=(texture2D(t,vUv+px*vec2(-o,-o))+texture2D(t,vUv+px*vec2(o,-o))+texture2D(t,vUv+px*vec2(-o,o))+texture2D(t,vUv+px*vec2(o,o)))*.25; }`;
const COMP_F=`
precision highp float; varying vec2 vUv; uniform sampler2D tMain,tA,tB; uniform float uFocus,uBand,uDim,uTime,uFlash,uHal;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec3 s=texture2D(tMain,vUv).rgb;
  vec4 a=texture2D(tA,vUv), b=texture2D(tB,vUv);
  float dy=abs(vUv.y-uFocus); float coc=smoothstep(uBand,uBand+.34,dy);
  vec3 c=mix(s,a.rgb,smoothstep(0.,.45,coc)); c=mix(c,b.rgb,smoothstep(.4,1.,coc));
  vec3 halo=vec3(1.,.6,.26);
  c+=halo*(a.a*.55+b.a*1.05)*uHal;
  /* gentle grade: cool shadows, warm top end */
  float l=dot(c,vec3(.3,.59,.11));
  c=mix(c,c*vec3(.92,1.02,1.1),1.-smoothstep(.0,.45,l));
  c=pow(max(c,0.),vec3(.97));
  vec2 q=(vUv-.5)*vec2(1.,1.15); float v=smoothstep(1.05,.3,length(q)); c*=mix(.72,1.,v);
  c*=1.-uDim*(1.-smoothstep(.0,.5,l))*.75;
  c+=vec3(1.,.8,.4)*uFlash;
  c+=(h(gl_FragCoord.xy+fract(uTime*7.)*91.)-.5)*.022;
  gl_FragColor=vec4(c,1.);
}`;

/* ---------- world state ---------- */
const STATIONS=[
  {id:'bocca',fiction:'Bocca',plain:'Intake',z:-21.5},
  {id:'disegno',fiction:'Disegno',plain:'Contract',z:-14},
  {id:'cantiere',fiction:'Cantiere',plain:'Build',z:-5},
  {id:'collaudo',fiction:'Collaudo',plain:'Prove',z:4.5},
  {id:'varo',fiction:'Varo',plain:'Launch',z:13.5},
  {id:'portolano',fiction:'Portolano',plain:'Learn',z:22},
];
const U={ /* shared uniform objects; every material holds these same references */
  uTime:{value:0},uMirror:{value:0},uWind:{value:.5},
  uSky:{value:new T.Color(.5,.64,.98)},uGnd:{value:new T.Color(.16,.17,.3)},
  uKeyDir:{value:new T.Vector3(.62,.42,-.66).normalize()},uKeyCol:{value:new T.Color(.95,.56,.46)},
  uHaze:{value:new T.Color(.13,.21,.29)},uHazeK:{value:90},
  uLP:{value:[new T.Vector4(0,5,0,.1),new T.Vector4(0,5,0,.1),new T.Vector4(0,5,0,.1),new T.Vector4(0,5,0,.1)]},
  uLC:{value:[new T.Color(0,0,0),new T.Color(0,0,0),new T.Color(0,0,0),new T.Color(0,0,0)]},
  uRing:{value:[new T.Vector4(),new T.Vector4(),new T.Vector4()]},
};
let renderer,scene,root,top,camera,water,table;
let tex={};
const size={w:390,h:844,dpr:1,insets:{l:0,t:0,r:0,b:0}};
const cam={yaw:.2,elev:.72,dist:150,tx:0,ty:0,tz:0,dragYaw:0,dragElev:0,zoom:1,fit:150};
const camDes={yaw:.2,elev:.72,tx:0,ty:0,tz:0,zoom:1};
let rt={};
let post={};
let hulls=[];
let selected=null;
let weather={used:.63,wind:.5,storm:0,chop:1};
let cer={state:'idle',hold:0,t:0,ringY:18,dim:0,flash:0,after:0};
const ripples=[];           /* {x,z,r,amp,speed,life} */
let voiceAmp=0, voiceAcc=0;
let winData=null, stationWins=[[],[],[],[],[],[]], halos, parts, soft, flights=[], winGeo;
let stationLabels=[];
let fpsAvg=16;
const API={};

/* ---------- the model ---------- */
const HW=10.2,Z0=-26,Z1=26,QY=.55;
const C={
  brick:hex(0xb9836c),brickB:hex(0xa56f5c),plaster:hex(0xc8b394),stone:hex(0xd8d0c0),stoneD:hex(0x8b867c),paving:hex(0x6d6a66),
  roof:hex(0xb37a66),timber:hex(0x4c3324),tar:hex(0x241a15),pine:hex(0xb48c5c),verd:hex(0x4ea190),gold:hex(0xd9a93a),verm:hex(0xc8391f),vellum:hex(0xefe4cb),iron:hex(0x26282a),
};
function addWindow(list,x,y,z,ang,w,h,open,hot){list.push({x,y,z,ang,w,h,open:open===undefined?1:open,hot:hot||0,seed:R()});return list.length-1;}

function buildArsenale(){
  const walls=new Geo(),roofs=new Geo(),solid=new Geo();const wins=[];const lamps=[];

  /* ground: quays both sides of the street and round the basin */
  const G=(x0,x1,z0,z1)=>{walls.box((x0+x1)/2,-1.6,(z0+z1)/2,x1-x0,1.6+QY,z1-z0,C.paving,{colTop:C.paving,top:[.42,.41,.42],s:.5});};
  G(-HW,-3.4,Z0,9);G(3.4,HW,Z0,9);G(-HW,-8,9,Z1);G(8,HW,9,Z1);
  /* Istrian stone coping along every water edge */
  const cope=(cx,cz,w,d)=>solid.box(cx,QY-.02,cz,w,.09,d,C.stone,{top:hex(0xe8e0d0)});
  cope(-3.5,-8.5,.28,35);cope(3.5,-8.5,.28,35);cope(-5.7,9,4.6,.28);cope(5.7,9,4.6,.28);cope(-8.1,17.5,.28,17);cope(8.1,17.5,.28,17);

  /* the slab's cut edge, like a museum section */
  const sideM=new Geo();
  const edge=hex(0xffffff);
  sideM.quad([-HW,-3,Z1],[HW,-3,Z1],[HW,.6,Z1],[-HW,.6,Z1],edge,.1);
  sideM.quad([HW,-3,Z1],[HW,-3,Z0],[HW,.6,Z0],[HW,.6,Z1],edge,.1);
  sideM.quad([-HW,-3,Z0],[-HW,-3,Z1],[-HW,.6,Z1],[-HW,.6,Z0],edge,.1);
  sideM.quad([HW,-3,Z0],[-HW,-3,Z0],[-HW,.6,Z0],[HW,.6,Z0],edge,.1);

  /* plinth: oiled walnut under a brass line */
  solid.box(0,-3.3,0,HW*2+.7,.45,Z1-Z0+.7,hex(0x2a1d15),{top:hex(0x3a2a1e)});
  solid.box(0,-2.88,0,HW*2+.24,.12,Z1-Z0+.24,hex(0x8c6a2f),{top:hex(0xbb933f)});

  /* tezoni: gabled sheds shoulder to shoulder, gable ends to the water */
  const shed=(s,z,w,eave,hot)=>{
    const xw=s*3.95, xo=s*9.5, z0=z, z1=z+w, ridge=eave+w*.46, zm=z+w/2;
    const col=R()<.34?C.brickB:C.brick; const tint=.86+R()*.28; const c=col.map(v=>v*tint);
    const low=c.map(v=>v*.66), plast=R()<.2;
    const wc=plast?C.plaster.map(v=>v*tint):c, wl=plast?C.plaster.map(v=>v*.6):low;
    /* water face, lit side faces +x on the left row */
    const a=s<0?[xw,0,z1]:[xw,0,z0], b=s<0?[xw,0,z0]:[xw,0,z1];
    const fa=[a[0],QY,a[2]],fb=[b[0],QY,b[2]];
    const ta=[a[0],eave,a[2]],tb=[b[0],eave,b[2]],pk=[xw,ridge,zm];
    walls.quad(fa,fb,tb,ta,wl,.25,wc);
    walls.tri(ta,tb,pk,wc,wc,wc,[ta[2]*.25,eave*.25,tb[2]*.25,eave*.25,pk[2]*.25,ridge*.25]);
    /* outer face */
    const oa=s<0?[xo,0,z0]:[xo,0,z1], ob=s<0?[xo,0,z1]:[xo,0,z0];
    const ofa=[oa[0],QY,oa[2]],ofb=[ob[0],QY,ob[2]],ota=[oa[0],eave,oa[2]],otb=[ob[0],eave,ob[2]],opk=[xo,ridge,zm];
    walls.quad(ofa,ofb,otb,ota,wl,.25,wc);walls.tri(ota,otb,opk,wc);
    /* long side walls where they show */
    walls.quad([s<0?xo:xw,QY,z0],[s<0?xw:xo,QY,z0],[s<0?xw:xo,eave,z0],[s<0?xo:xw,eave,z0],wl,.25,wc);
    walls.quad([s<0?xw:xo,QY,z1],[s<0?xo:xw,QY,z1],[s<0?xo:xw,eave,z1],[s<0?xw:xo,eave,z1],wl,.25,wc);
    /* roof, tiled, slightly overhung */
    const ov=.14,ex=s*.18, X0=xw-ex, X1=xo+ex;
    const rc=C.roof.map(v=>v*(.8+R()*.32));
    const r0=[X0,eave-.06,z0-ov],r1=[X1,eave-.06,z0-ov],r2=[X1,ridge,zm],r3=[X0,ridge,zm];
    const r4=[X0,eave-.06,z1+ov],r5=[X1,eave-.06,z1+ov];
    if(s<0){roofs.quad(r3,r2,r1,r0,rc,.3);roofs.quad(r4,r5,r2,r3,rc,.3);}else{roofs.quad(r1,r0,r3,r2,rc,.3);roofs.quad(r5,r4,r3,r2,rc,.3);}
    solid.bar([X0,ridge+.02,zm],[X1,ridge+.02,zm],.05,C.stoneD);
    /* stone quoins and a raking cornice on the gable */
    solid.bar(ta,pk,.045,C.stone);solid.bar(pk,tb,.045,C.stone);
    /* arch and oculus */
    const ang=s<0?Math.PI/2:-Math.PI/2, f=xw+s*-.02;
    const fx=xw-s*(-.02)*-1; 
    addWindow(wins,xw-s*.02,QY+.06,zm,ang,w*.56,eave*.74,1,hot);
    addWindow(wins,xw-s*.02,eave+w*.1,zm,ang,w*.15,w*.17,R()<.75?1:0,0);
    solid.bar([xw-s*.03,QY,zm-w*.3],[xw-s*.03,eave*.62,zm-w*.3],.05,C.stone);
    solid.bar([xw-s*.03,QY,zm+w*.3],[xw-s*.03,eave*.62,zm+w*.3],.05,C.stone);
    /* outer windows, smaller */
    if(s>0)for(let i=0;i<2;i++)addWindow(wins,xo+.02,QY+.9,z+w*(.3+i*.4),Math.PI/2,w*.14,1.2,R()<.8?1:0,0);
  };
  const row=(s)=>{let z=-19.8;while(z<8.4){const w=rr(2.9,3.8);const inC=z>-9.5&&z<.5;let eave=rr(2.4,3.3)+(inC?.8:0);if(s>0)eave=rr(1.5,1.9);const wEnd=Math.min(w,8.8-z);if(wEnd<1.6)break;shed(s,z,wEnd,eave,inC?1:0);z+=wEnd+.1;}};
  row(-1);row(1);
  /* basin buildings on the strips, low */
  const low=(x,z,w,d,h,col)=>{walls.box(x,QY,z,w,h,d,col,{noTop:true,colTop:col});
    const rd=d*.4;const c=C.roof.map(v=>v*(.76+R()*.24));
    roofs.quad([x+w/2+.1,QY+h,z+d/2+.1],[x+w/2+.1,QY+h,z-d/2-.1],[x,QY+h+rd,z-d/2-.1],[x,QY+h+rd,z+d/2+.1],c,.3);
    roofs.quad([x-w/2-.1,QY+h,z-d/2-.1],[x-w/2-.1,QY+h,z+d/2+.1],[x,QY+h+rd,z+d/2+.1],[x,QY+h+rd,z-d/2-.1],c,.3);
    walls.tri([x-w/2,QY+h,z+d/2],[x+w/2,QY+h,z+d/2],[x,QY+h+rd,z+d/2],col);};
  low(-9.1,13,1.9,4.2,1.7,C.brick);addWindow(wins,-8.13,QY+.1,13,Math.PI/2,1.0,1.3,1,0);
  low(-9.1,18.5,1.9,4.6,2.1,C.plaster);addWindow(wins,-8.13,QY+.1,18,Math.PI/2,.9,1.5,1,0);addWindow(wins,-8.13,QY+.1,19.6,Math.PI/2,.5,1.1,1,0);
  low(9.1,12.5,1.9,5,1.3,C.brickB);

  /* Bocca: twin water gate towers with the lion's mouth lit between them */
  const tower=(x,z,h)=>{
    walls.box(x,QY,z,2.5,h,2.5,C.brick,{noTop:true,colTop:C.brickB});
    solid.box(x,QY+h-.02,z,2.86,.18,2.86,C.stone,{top:hex(0xcfc7b6)});
    const rimH=.46;
    for(let i=0;i<4;i++){const q=[[-1,0],[1,0],[0,-1],[0,1]][i];walls.box(x+q[0]*1.26,QY+h+.16,z+q[1]*1.26,q[1]?2.6:.26,rimH,q[0]?2.6:.26,C.brickB);}
    addWindow(wins,x+(x>0?-1.27:1.27),QY+h*.56,z+.1,x>0?-Math.PI/2:Math.PI/2,.55,1.5,1,0);
    addWindow(wins,x,QY+h*.56,z+1.27,0,.55,1.5,1,0);
  };
  tower(-5.15,-21.5,6.2);tower(5.15,-21.5,6.2);
  walls.box(-7.6,QY,-21.5,2.6,2.4,2.1,C.brickB);walls.box(7.6,QY,-21.5,2.6,2.4,2.1,C.brickB);
  solid.box(0,4.25,-21.5,7.2,.36,.5,C.stone,{top:hex(0xdad2c2)});
  solid.box(0,4.6,-21.5,1.5,1.05,.4,C.stoneD,{top:C.stone});
  solid.emit=1.25;solid.box(0,4.76,-21.28,.8,.17,.03,hex(0xffb350));solid.emit=0;
  /* Cantiere crane: timber sheerlegs on the left quay */
  const cx=-3.0,cz=-6;
  solid.bar([-4.7,QY,cz-1.2],[cx-.2,8.2,cz],.08,C.timber,.05);solid.bar([-4.7,QY,cz+1.2],[cx-.2,8.2,cz],.08,C.timber,.05);
  solid.bar([cx-.2,8.2,cz],[.4,7.2,cz+.2],.05,C.timber,.03);solid.bar([.4,7.2,cz+.2],[.4,2.8,cz+.2],.015,C.iron);
  solid.box(.4,2.4,cz+.2,.5,.42,.5,C.timber);
  /* scaffold on the right quay at Cantiere */
  for(let i=0;i<5;i++){const z=-9.2+i*1.6;solid.bar([3.52,QY,z],[3.52,3.4,z],.035,C.timber);}
  for(let j=0;j<2;j++){const y=1.5+j*1.2;solid.bar([3.5,y,-9.4],[3.5,y,-2.8],.03,C.timber);solid.box(3.2,y,-6.1,.5,.04,6.6,hex(0x8b6a48));}
  /* Collaudo: the closed window, stone posts and a lifting bar across the street */
  const postH=3.4;solid.box(-3.75,QY,8.6,.56,postH,.56,C.stone,{top:hex(0xe2dacb)});solid.box(3.75,QY,8.6,.56,postH,.56,C.stone,{top:hex(0xe2dacb)});
  /* Portolano: the chart house and a beacon on the mole */
  const px=9.05,pz=20.4;
  walls.box(px,QY,pz,2,2.4,3,C.plaster,{noTop:true,colTop:C.plaster.map(v=>v*1.05)});
  roofs.quad([px+1.1,QY+2.4,pz+1.6],[px+1.1,QY+2.4,pz-1.6],[px,QY+3.5,pz-1.6],[px,QY+3.5,pz+1.6],C.roof,.3);
  roofs.quad([px-1.1,QY+2.4,pz-1.6],[px-1.1,QY+2.4,pz+1.6],[px,QY+3.5,pz+1.6],[px,QY+3.5,pz-1.6],C.roof,.3);
  addWindow(wins,px-1.03,QY+.1,pz,-Math.PI/2,1.1,1.7,1,0);addWindow(wins,px,QY+.6,pz+1.52,0,.6,1.1,1,0);
  solid.cyl(9.1,QY,24.6,.66,.46,5.2,12,hex(0xa39e92));
  solid.emit=1.5;solid.cyl(9.1,QY+5.2,24.6,.34,.34,.5,8,hex(0xffc76a));solid.emit=0;
  solid.cyl(9.1,QY+5.7,24.6,.46,.02,.6,8,C.verd);
  lamps.push([9.1,QY+5.45,24.6,3.6]);

  /* the campanile: brick shaft, open belfry, verdigris spire, gold at the tip */
  const bx=-8,bz=-5.4,sh=10.6,bw=2.5;
  walls.box(bx,QY,bz,bw,sh,bw,C.brick.map(v=>v*1.04),{noTop:true,colTop:C.brick});
  for(let i=0;i<5;i++){const o=-bw/2+.12+i*(bw-.24)/4;solid.bar([bx+o,QY,bz+bw/2+.03],[bx+o,QY+sh,bz+bw/2+.03],.05,C.brickB);solid.bar([bx+bw/2+.03,QY,bz+o],[bx+bw/2+.03,QY+sh,bz+o],.05,C.brickB);}
  const by=QY+sh;
  solid.box(bx,by,bz,bw+.4,.16,bw+.4,C.stone,{top:hex(0xe0d8c8)});
  solid.box(bx,by+.16,bz,bw-.3,1.9,bw-.3,hex(0x1e1712));
  for(let a=0;a<4;a++){const cs=[[1,1],[1,-1],[-1,1],[-1,-1]][a];solid.box(bx+cs[0]*(bw/2-.28),by+.16,bz+cs[1]*(bw/2-.28),.26,1.9,.26,C.stone);}
  addWindow(wins,bx,by+.18,bz+bw/2-.15,0,bw*.62,1.76,1,1);addWindow(wins,bx+bw/2-.15,by+.18,bz,Math.PI/2,bw*.62,1.76,1,1);
  solid.box(bx,by+2.06,bz,bw+.36,.18,bw+.36,C.stone,{top:hex(0xe0d8c8)});
  walls.box(bx,by+2.24,bz,bw-.2,1.1,bw-.2,C.brickB,{noTop:true});
  const sp=by+3.34,q=(bw-.2)/2,tip=[bx,sp+3.2,bz],vc=C.verd.map(v=>v*1.1);
  roofs.tri([bx-q,sp,bz+q],[bx+q,sp,bz+q],tip,vc);roofs.tri([bx+q,sp,bz+q],[bx+q,sp,bz-q],tip,vc);roofs.tri([bx+q,sp,bz-q],[bx-q,sp,bz-q],tip,vc);roofs.tri([bx-q,sp,bz-q],[bx-q,sp,bz+q],tip,vc);
  solid.emit=.5;solid.bar([bx,sp+3.1,bz],[bx,sp+3.8,bz],.09,C.gold,.02);solid.emit=0;

  /* quay lanterns: small warm points that write long streaks on the water */
  const post=(x,z)=>{solid.bar([x,QY,z],[x,QY+.9,z],.03,C.iron);solid.emit=2;solid.box(x,QY+.9,z,.17,.2,.17,hex(0xffbd63));solid.emit=0;lamps.push([x,QY+1,z,1.5]);};
  for(let z=-19;z<8.5;z+=3.6){post(-3.62,z+rr(-.3,.3));post(3.62,z+1.6+rr(-.3,.3));}
  for(let z=10.5;z<26;z+=4){post(-8.25,z);post(8.25,z+1.2);}
  /* mooring poles in threes */
  const bric=(x,z)=>{for(let i=0;i<3;i++){const a=i*2.1,dx=Math.cos(a)*.17,dz=Math.sin(a)*.17;solid.bar([x+dx*1.5,-.2,z+dz*1.5],[x+dx*.2,2.1+i*.08,z+dz*.2],.05,hex(0x4b3a2b),.035);}};
  bric(-6.2,11);bric(6.5,11.4);bric(-6.6,24.2);bric(2.2,24.6);bric(-1.8,22.4);

  /* windows go in the instanced list; lamps become halos */
  winData=wins;
  /* each station owns the nearest closed windows */
  const pick=(st,n)=>{const zs=STATIONS[st].z;const list=wins.map((w,i)=>({w,i,d:Math.abs(w.z-zs)})).filter(o=>o.w.x<0&&o.w.x>-5&&Math.abs(o.w.y-QY)<.2&&o.w.w>.9).sort((a,b)=>a.d-b.d).slice(0,n);list.forEach(o=>{o.w.open=0;stationWins[st].push(o.i);});};
  pick(1,2);pick(2,4);pick(3,2);

  const mWall=worldMat(tex.brick,.92);const mRoof=worldMat(tex.roof,.95);const mSolid=worldMat(tex.noise,.34);
  const add=(g,m)=>{const me=new T.Mesh(g.build(),m);me.frustumCulled=false;root.add(me);return me;};
  add(walls,mWall);add(roofs,mRoof);add(solid,mSolid);
  const sideMat=new T.ShaderMaterial({uniforms:{tMap:{value:tex.strata},uDim:{value:0},uMirror:U.uMirror},vertexShader:`varying vec2 vUv;varying float vY;void main(){vUv=vec2(uv.x*1.,position.y);vY=position.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`precision highp float;varying vec2 vUv;varying float vY;uniform sampler2D tMap;uniform float uMirror;void main(){if(uMirror>.5)discard;float v=clamp((.6-vY)/3.6,0.,1.);vec3 c=texture2D(tMap,vec2(vUv.x*.5,1.-v)).rgb*.8;gl_FragColor=vec4(c,1.);}`});
  const edgeMesh=new T.Mesh(sideM.build(),sideMat);edgeMesh.frustumCulled=false;top.add(edgeMesh);

  /* resin water cut, near edge of the basin */
  const resin=new T.Mesh(new T.PlaneGeometry(16,3.0),new T.ShaderMaterial({transparent:true,vertexShader:FLAT_V,
    fragmentShader:`precision highp float;varying vec2 vUv;void main(){float y=vUv.y;vec3 c=mix(vec3(.02,.08,.09),vec3(.14,.42,.42),pow(y,2.2));c+=vec3(.5,.62,.55)*smoothstep(.975,1.,y);gl_FragColor=vec4(c,.94);}`}));
  resin.position.set(0,-1.49,Z1+.02);top.add(resin);

  /* lifting bar */
  const barG=new Geo();barG.box(0,0,0,7.1,.2,.2,C.verm);barG.emit=1.6;barG.box(0,.2,0,.3,.2,.2,hex(0xff5a3a));barG.emit=0;
  const bar=new T.Mesh(barG.build(),worldMat(tex.noise,.2));bar.position.set(0,3.5,8.6);bar.frustumCulled=false;root.add(bar);API._bar=bar;

  /* instanced windows */
  const arch=[];const seg=8;
  const push=(a,b,c)=>arch.push(a[0],a[1],0,b[0],b[1],0,c[0],c[1],0);
  const sq=[-.5,.5];push([-.5,0],[.5,0],[.5,.68]);push([-.5,0],[.5,.68],[-.5,.68]);
  for(let i=0;i<seg;i++){const a0=Math.PI*i/seg,a1=Math.PI*(i+1)/seg;push([0,.68],[Math.cos(a0)*.5,.68+Math.sin(a0)*.32],[Math.cos(a1)*.5,.68+Math.sin(a1)*.32]);}
  winGeo=new T.InstancedBufferGeometry();winGeo.setAttribute('position',new T.Float32BufferAttribute(arch,3));
  const n=wins.length;const iP=new Float32Array(n*4),iS=new Float32Array(n*3),iO=new Float32Array(n*2);
  wins.forEach((w,i)=>{iP.set([w.x,w.y,w.z,w.ang],i*4);iS.set([w.w,w.h,w.seed],i*3);iO.set([w.open,w.hot],i*2);});
  winGeo.setAttribute('iP',new T.InstancedBufferAttribute(iP,4));winGeo.setAttribute('iS',new T.InstancedBufferAttribute(iS,3));
  const oa=new T.InstancedBufferAttribute(iO,2);oa.setUsage(T.DynamicDrawUsage);winGeo.setAttribute('iO',oa);winGeo.instanceCount=n;
  const wm=new T.ShaderMaterial({uniforms:{uTime:U.uTime,uMirror:U.uMirror},vertexShader:WIN_V,fragmentShader:WIN_F,side:T.DoubleSide});
  const wmesh=new T.Mesh(winGeo,wm);wmesh.frustumCulled=false;root.add(wmesh);

  /* halos */
  lamps.forEach(l=>halos.add(l[0],l[1],l[2],l[3],1,1,.68,.32,.42));
  wins.forEach(w=>{const dx=Math.sin(w.ang)*.5,dz=Math.cos(w.ang)*.5;w.halo=halos.add(w.x+dx,w.y+w.h*.45,w.z+dz,Math.max(w.w,w.h)*2.,1,1,.6,.26,w.open*.2);});
  halos.flush();

  /* workers, walking the quays; they are what makes the scale read */
  const wg=new T.InstancedBufferGeometry();const bb=new Geo();bb.box(0,0,0,.14,.3,.14,hex(0x262024));bb.box(0,.3,0,.09,.09,.09,hex(0xcfa98a));
  wg.setAttribute('position',bb.build().getAttribute('position'));wg.setAttribute('normal',bb.build().getAttribute('normal'));wg.setAttribute('col',bb.build().getAttribute('col'));
  const N=46,ia=new Float32Array(N*4);for(let i=0;i<N;i++){const s=R()<.5?-1:1;ia.set([s*(3.72+R()*.15),rr(-19,8),(R()<.5?-1:1)*rr(.25,.7),R()],i*4);}
  wg.setAttribute('iA',new T.InstancedBufferAttribute(ia,4));wg.instanceCount=N;
  const wv=new T.ShaderMaterial({uniforms:{uTime:U.uTime,uMirror:U.uMirror},side:T.DoubleSide,vertexShader:`attribute vec3 col;attribute vec4 iA;uniform float uTime;varying vec3 vC;void main(){float z=-19.+mod(iA.y+19.+iA.z*uTime,27.);vec3 p=position+vec3(iA.x,${QY.toFixed(2)},z);p.y+=abs(sin(uTime*7.*abs(iA.z)+iA.w*9.))*.03;vec4 w=modelMatrix*vec4(p,1.);vC=col;gl_Position=projectionMatrix*viewMatrix*w;}`,fragmentShader:`precision mediump float;varying vec3 vC;void main(){gl_FragColor=vec4(vC*.9+vec3(.02,.03,.05),1.);}`});
  const wk=new T.Mesh(wg,wv);wk.frustumCulled=false;root.add(wk);
}

function worldMat(map,texAmt,hull){
  const u={tMap:{value:map},uTexAmt:{value:texAmt},uTexGrey:{value:map===tex.noise?1:0},uGild:{value:0},uProgress:{value:1},uRow:{value:0},uShade:{value:1},uSoak:{value:0},uTint:{value:new T.Color(1,1,1)}};
  for(const k of ['uTime','uMirror','uWind','uSky','uGnd','uKeyDir','uKeyCol','uHaze','uHazeK','uLP','uLC','uRing'])u[k]=U[k];
  return new T.ShaderMaterial({uniforms:u,vertexShader:WORLD_V,fragmentShader:WORLD_F,defines:hull?{HULL:1}:{}});
}

/* ---------- hull builders; +z is the bow ---------- */
function buildGalley(o){
  o=o||{};const L=o.L||8.2,B=o.B||.88,g=new Geo(),N=14,rings=[];
  const tar=o.tar||hex(0x6a4a33),wale=o.wale||hex(0xb2402b),dk=o.deck||hex(0xd8b582),beam=(t)=>{let b=B*Math.min(1,.58+t*3.2);b*=1-Math.pow(Math.max(0,(t-.5)/.5),2.3)*.965;return b;},sheer=(t)=>.54+1.15*Math.pow(1-t,7)+.42*Math.pow(t,6);
  for(let i=0;i<=N;i++){const t=i/N,z=(t-.5)*L,b=beam(t),s=sheer(t);rings.push({z,b,s,p:[[0,-.2],[b*.76,-.03],[b,s*.5],[b*.98,s]]});}
  g.curPart=0;
  for(let i=0;i<N;i++){const a=rings[i],b=rings[i+1];
    for(let k=0;k<3;k++){const col=k==2?wale:(k==1?tar.map(v=>v*1.2):tar.map(v=>v*.7));
      const P=(r,j,sg)=>[r.p[j][0]*sg,r.p[j][1],r.z];
      g.quad(P(a,k,1),P(b,k,1),P(b,k+1,1),P(a,k+1,1),col);
      g.quad(P(b,k,-1),P(a,k,-1),P(a,k+1,-1),P(b,k+1,-1),col);}
  }
  const r0=rings[0];g.quad([r0.b,-.03,r0.z],[-r0.b,-.03,r0.z],[-r0.b,r0.s,r0.z],[r0.b,r0.s,r0.z],hex(0x5f2a1b));
  const bw=rings[N];g.bar([0,bw.s,bw.z],[0,bw.s+.1,bw.z+1.5],.09,tar,.012);   /* the spur */
  g.curPart=.05;
  for(let i=0;i<N;i++){const a=rings[i],b=rings[i+1];const y0=a.s-.1,y1=b.s-.1;const c=(i%2?dk:dk.map(v=>v*.9));g.quad([a.b*.97,y0,a.z],[a.b*.97-a.b*1.94,y0,a.z],[-b.b*.97,y1,b.z],[b.b*.97,y1,b.z],c);}
  g.curPart=.16;g.bar([0,.62,-L*.34],[0,.62,L*.34],.09,hex(0x8d6b47));
  for(let i=0;i<12;i++){g.curPart=.2+.15*i/12;const t=.2+.56*i/12,z=(t-.5)*L,b=beam(t);g.bar([-b,sheer(t),z],[b,sheer(t),z],.024,hex(0x6d5238));}
  const mast=(zm,h,part,yL)=>{const s=.62;g.curPart=part;g.bar([0,s,zm],[0,s+h,zm],.08,hex(0x5c4530),.04);
    g.curPart=part+.1;const y0=s+h*.36,y1=s+h*1.1;g.bar([0,y0,zm-yL*.55],[0,y1,zm+yL*.45],.045,hex(0x6a4f36),.02);
    g.curPart=part+.14;g.bar([.0,y0+.15,zm-yL*.45],[.0,y1-.2,zm+yL*.38],.12,o.sail||[1.1,1.04,.9],.05);
    g.curPart=part+.17;g.bar([0,s+h,zm],[B*.96,s,zm-1],.008,hex(0x2a2520));g.bar([0,s+h,zm],[-B*.96,s,zm-1],.008,hex(0x2a2520));g.bar([0,s+h,zm],[0,.6,L*.46],.008,hex(0x2a2520));g.bar([0,s+h,zm],[B*.96,s,zm+.8],.008,hex(0x2a2520));g.bar([0,s+h,zm],[-B*.96,s,zm+.8],.008,hex(0x2a2520));};
  mast(L*.1,4.6,.4,5.6);
  if(!o.oneMast)mast(-L*.17,3.1,.5,3.8);
  for(let i=0;i<14;i++)for(const sg of[1,-1]){const t=.22+.54*i/13,z=(t-.5)*L,b=beam(t),s=sheer(t);
    g.curPart=.66+.22*((i*2+(sg>0?0:1))/27);g.curAnim=[1,sg*b,z,i];g.bar([sg*b*.55,s+.14,z],[sg*(b+1.5),-.02,z-.34],.014,o.oar||hex(0x6d5c47),.03);g.curAnim=[0,0,0,0];}
  /* stern awning: vermilion over gilt ribs */
  g.curPart=.9;const zs=-L*.5+.2,ze=-L*.26;
  const arc=(z,b,h)=>{const a=[];for(let i=0;i<=6;i++){const q=Math.PI*i/6;a.push([Math.cos(q)*b,1.0+Math.sin(q)*h,z]);}return a;};
  const A0=arc(zs,.5,.5),A1=arc(ze,.56,.46),vm=o.awn||C.verm;
  for(let i=0;i<6;i++)g.quad(A0[i+1],A1[i+1],A1[i],A0[i],i%2?vm:vm.map(v=>v*.82));
  g.quad(A0[0],A0[1],A0[5],A0[6],vm.map(v=>v*.66));
  g.curPart=.96;g.emit=2.2;
  for(let i=-1;i<=1;i++)g.box(i*.26,1.76+(i==0?.2:0),-L*.5+.03,.13,.2,.13,hex(0xffc768));
  g.emit=0;g.curPart=.97;g.bar([0,1.2,-L*.5+.03],[0,2.1,-L*.5+.03],.022,C.gold);
  /* pennant at the truck of the main mast */
  g.curPart=.98;const top=[0,.62+4.6,L*.1];for(let i=0;i<6;i++){const d0=i*.34,d1=(i+1)*.34,w0=.17*(1-i/6),w1=.17*(1-(i+1)/6);const fc=o.flag||C.verm;
    const a=[0,top[1]+w0,top[2]-d0],b=[0,top[1]-w0,top[2]-d0],c=[0,top[1]-w1,top[2]-d1],dd=[0,top[1]+w1,top[2]-d1];
    const n=g.p.length;g.curAnim=[2,d0,0,0];g.quad(a,b,c,dd,fc);for(let v=n/3;v<g.p.length/3;v++){g.anim[v*4+1]=Math.abs(g.p[v*3+2]-top[2]);}g.curAnim=[0,0,0,0];
    const n2=g.p.length;g.curAnim=[2,d0,0,0];g.quad(b,a,dd,c,fc);for(let v=n2/3;v<g.p.length/3;v++){g.anim[v*4+1]=Math.abs(g.p[v*3+2]-top[2]);}g.curAnim=[0,0,0,0];}
  g.curPart=0;return g.build();
}
function buildGondola(){
  const g=new Geo(),N=10,L=4.2,lac=hex(0x141417);const rings=[];
  for(let i=0;i<=N;i++){const t=i/N,b=.3*Math.sin(Math.PI*Math.pow(t,.85))+.012,s=.26+.75*Math.pow(Math.abs(t-.5)*2,3.2);rings.push({z:(t-.5)*L,b,s});}
  for(let i=0;i<N;i++){const a=rings[i],b=rings[i+1];
    g.quad([a.b,.0,a.z],[b.b,.0,b.z],[b.b,b.s,b.z],[a.b,a.s,a.z],lac);g.quad([-b.b,0,b.z],[-a.b,0,a.z],[-a.b,a.s,a.z],[-b.b,b.s,b.z],lac);
    g.quad([a.b,a.s*.8,a.z],[-a.b,a.s*.8,a.z],[-b.b,b.s*.8,b.z],[b.b,b.s*.8,b.z],hex(0x5a2a22));}
  g.bar([0,.95,L/2],[0,1.26,L/2+.12],.04,C.stone,.02);
  g.bar([.08,.5,-.2],[.08,1.25,-1.05],.02,C.pine);g.box(.04,.42,-1.1,.2,.48,.2,hex(0x262024));g.box(.04,.9,-1.1,.12,.13,.12,hex(0xcfa98a));
  g.emit=2;g.box(0,.72,.92,.12,.15,.12,hex(0xffc768));g.emit=0;
  return g.build();
}
function buildTow(){
  const g=new Geo();const b=hex(0x352519);
  g.quad([.34,-.05,-1],[.34,-.05,.6],[.34,.26,.6],[.34,.26,-1],b);g.quad([-.34,-.05,.6],[-.34,-.05,-1],[-.34,.26,-1],[-.34,.26,.6],b);
  g.tri([.34,-.05,.6],[0,-.05,1.3],[0,.3,1.3],b,b,b);g.tri([.34,-.05,.6],[0,.3,1.3],[.34,.26,.6],b);g.tri([0,-.05,1.3],[-.34,-.05,.6],[-.34,.26,.6],b);g.tri([0,-.05,1.3],[-.34,.26,.6],[0,.3,1.3],b);
  g.quad([.34,.18,-1],[-.34,.18,-1],[-.34,.18,.6],[.34,.18,.6],C.pine);g.quad([-.34,-.05,-1],[.34,-.05,-1],[.34,.26,-1],[-.34,.26,-1],b);
  for(let i=0;i<3;i++){g.box(0,.2,-.6+i*.5,.4,.26,.14,hex(0x2a2428));g.box(0,.46,-.6+i*.5,.09,.1,.09,hex(0xcfa98a));}
  for(const s of[1,-1])for(let i=0;i<2;i++)g.bar([s*.32,.26,-.3+i*.5],[s*1.5,-.02,.05+i*.5],.012,C.stone,.02);
  g.emit=2;g.box(0,.5,.95,.12,.16,.12,hex(0xffc768));g.emit=0;
  return g.build();
}
function buildBucintoro(){
  const g=new Geo();const G=C.gold.map(v=>v*1.1),L=10;const N=12;const beam=(t)=>.95*Math.pow(Math.sin(Math.PI*(t*.86+.1)),.5),sheer=(t)=>.8+.95*Math.pow(1-t,5)+.5*Math.pow(t,5);
  for(let i=0;i<N;i++){const t0=i/N,t1=(i+1)/N,z0=(t0-.5)*L,z1=(t1-.5)*L,b0=beam(t0),b1=beam(t1),s0=sheer(t0),s1=sheer(t1);
    g.quad([b0,-.1,z0],[b1,-.1,z1],[b1,s1,z1],[b0,s0,z0],G);g.quad([-b1,-.1,z1],[-b0,-.1,z0],[-b0,s0,z0],[-b1,s1,z1],G);
    g.quad([b0,s0,z0],[-b0,s0,z0],[-b1,s1,z1],[b1,s1,z1],hex(0x7a1f12));
    if(i>1&&i<10){g.quad([b0*.9,s0+1.15,z0],[-b0*.9,s0+1.15,z0],[-b1*.9,s1+1.15,z1],[b1*.9,s1+1.15,z1],i%2?C.verm:C.verm.map(v=>v*.8));g.bar([b0*.9,s0,z0],[b0*.9,s0+1.15,z0],.05,G);g.bar([-b0*.9,s0,z0],[-b0*.9,s0+1.15,z0],.05,G);}
  }
  for(let i=0;i<14;i++)for(const s of[1,-1]){const z=-3.6+i*.56;g.bar([s*.9,.7,z],[s*3,-.03,z+.3],.02,hex(0xe5d3a8),.04);}
  g.emit=2.4;g.box(0,2.5,-L/2+.3,.26,.34,.26,hex(0xffc768));g.emit=0;
  return g.build();
}

class Sprites{
  constructor(max,frag,blend,uniforms,flat){
    const q=new T.PlaneGeometry(1,1),g=new T.InstancedBufferGeometry();g.index=q.index;g.setAttribute('position',q.getAttribute('position'));g.setAttribute('uv',q.getAttribute('uv'));
    this.iP=new T.InstancedBufferAttribute(new Float32Array(max*3),3);this.iS=new T.InstancedBufferAttribute(new Float32Array(max*2),2);this.iC=new T.InstancedBufferAttribute(new Float32Array(max*4),4);
    [this.iP,this.iS,this.iC].forEach(a=>a.setUsage(T.DynamicDrawUsage));g.setAttribute('iP',this.iP);g.setAttribute('iS',this.iS);g.setAttribute('iC',this.iC);
    g.instanceCount=0;this.g=g;this.n=0;this.max=max;
    const m=new T.ShaderMaterial({vertexShader:SPR_V,fragmentShader:frag,transparent:true,depthWrite:false,blending:blend,uniforms:uniforms||{}});
    this.mesh=new T.Mesh(g,m);this.mesh.frustumCulled=false;
  }
  reset(){this.n=0;}
  add(x,y,z,s,st,r,g,b,a){if(this.n>=this.max)return -1;const i=this.n++;this.iP.array.set([x,y,z],i*3);this.iS.array.set([s,st],i*2);this.iC.array.set([r,g,b,a],i*4);return i;}
  alpha(i,a){this.iC.array[i*4+3]=a;this.dirty=1;}
  flush(){this.g.instanceCount=this.n;this.iP.needsUpdate=this.iS.needsUpdate=this.iC.needsUpdate=true;this.dirty=0;}
}

/* ---------- hull objects ---------- */
let geos={};
function makeHull(d){
  const h=Object.assign({fog:0,leak:0,gild:0,z:0,x:0,tz:d.z,progressShown:d.progress,row:0,phase:R()*6},d);
  const geo=d.kind==='gondola'?geos.gondola:(d.kind==='galleass'?geos.galleass:geos.galley);
  const m=worldMat(tex.noise,.3,true);m.uniforms.uProgress.value=d.kind==='gondola'?1:d.progress;
  h.mat=m;h.group=new T.Group();h.mesh=new T.Mesh(geo,m);h.mesh.frustumCulled=false;h.group.add(h.mesh);if(d.kind!=='gondola')h.group.scale.setScalar(.96);
  h.z=d.z;h.x=d.x||0;root.add(h.group);
  if(d.tow){h.tow=new T.Mesh(geos.tow,worldMat(tex.noise,.2));h.tow.frustumCulled=false;h.tow.position.set(0,0,(d.kind==='galley'?4.1:3)+3.1);h.group.add(h.tow);
    const lineG=new Geo();lineG.bar([0,.5,0],[0,.3,1],.012,hex(0x3a3024));h.line=new T.Mesh(lineG.build(),worldMat(tex.noise,0));h.line.frustumCulled=false;h.line.position.set(0,0,4.5);h.line.scale.z=1.75;h.group.add(h.line);}
  return h;
}

function setSize(){
  const w=innerWidth,h=innerHeight;size.w=w;size.h=h;
  const lock=parseFloat(qs.get('dpr'));
  const dpr=lock||Math.min(devicePixelRatio||1,size.maxDpr||2);size.dpr=dpr;
  renderer.setPixelRatio(1);renderer.setSize(Math.round(w*dpr),Math.round(h*dpr),false);
  const W=Math.round(w*dpr),H=Math.round(h*dpr);
  rt.main.setSize(W,H);
  const rs=size.reflScale||.5;rt.refl.setSize(Math.max(2,W*rs|0),Math.max(2,H*rs|0));
  const a=[Math.ceil(W/4),Math.ceil(H/4)],b=[Math.ceil(W/8),Math.ceil(H/8)],c=[Math.ceil(W/16),Math.ceil(H/16)];
  rt.a.setSize(a[0],a[1]);rt.b.setSize(b[0],b[1]);rt.c.setSize(c[0],c[1]);rt.d.setSize(b[0],b[1]);
  water.material.uniforms.uRes.value.set(W,H);table.material.uniforms.uRes.value.set(W,H);
  camera.aspect=w/h;
  applyView();fitCamera();
}
function applyView(){
  const w=size.w,h=size.h,i=size.iCur||size.insets;const cx=(i.l+w-i.r)/2,cy=(i.t+h-i.b)/2;
  camera.setViewOffset(w,h,w/2-cx,h/2-cy,w,h);camera.updateProjectionMatrix();
}
function poseCamera(yaw,elev,dist,tx,ty,tz){
  const c=Math.cos(elev);camera.position.set(tx+Math.sin(yaw)*c*dist,ty+Math.sin(elev)*dist,tz+Math.cos(yaw)*c*dist);camera.up.set(0,1,0);camera.lookAt(tx,ty,tz);camera.updateMatrixWorld(true);
}
function fitCamera(){
  /* pick a pose for the room we have, then a distance so the whole model sits inside it */
  const w=size.w,h=size.h,i=size.insets,availW=w-i.l-i.r,availH=h-i.t-i.b,asp=availW/availH;
  const wide=asp>1.25;
  size.wide=wide;
  camDes.yaw=wide?.92:.5;camDes.elev=wide?.54:.6;
  if(!cam.init){cam.yaw=camDes.yaw;cam.elev=camDes.elev;}
  const tgt=wide?[0,0,1]:[0,0,.5];
  camera.clearViewOffset();camera.updateProjectionMatrix();
  let dist=150;
  for(let it=0;it<6;it++){
    poseCamera(camDes.yaw,camDes.elev,dist,tgt[0],tgt[1],tgt[2]);
    let maxX=0,minY=1e9,maxY=-1e9;const v=new T.Vector3();
    for(const cn of[[-HW,0,Z0],[HW,0,Z0],[HW,0,Z1],[-HW,0,Z1],[-HW,-3,Z1],[HW,-3,Z1],[5,7,-22]]){v.set(cn[0],cn[1],cn[2]).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      const sx=(v.x*.5)*w, sy=(v.y*.5)*h;maxX=Math.max(maxX,Math.abs(sx));minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);}
    const sc=Math.max(maxX/(availW/2),Math.max(Math.abs(minY),Math.abs(maxY))/(availH/2));dist*=sc*(wide?1.0:1.0);
  }
  applyView();
  cam.fit=dist;camDes.tx=tgt[0];camDes.ty=tgt[1];camDes.tz=tgt[2];cam.base=tgt;
  if(!cam.init){cam.tx=tgt[0];cam.ty=tgt[1];cam.tz=tgt[2];cam.dist=dist;cam.init=1;}
}

const _v=new T.Vector3();
API.project=(x,y,z)=>{_v.set(x,y,z).project(camera);return{x:(_v.x*.5+.5)*size.w,y:(-_v.y*.5+.5)*size.h,behind:_v.z>1};};

API.setInsets=(i)=>{size.insets=i;if(!size.iCur)size.iCur=Object.assign({},i);if(renderer){applyView();fitCamera();}};
API.setWeather=(used)=>{weather.used=used;};
API.select=(id)=>{selected=hulls.find(h=>h.id===id)||null;};
API.voice=(a)=>{voiceAmp=a;};
API.hull=(id)=>hulls.find(h=>h.id===id);
API.addRipple=(x,z,amp,speed,max)=>{ripples.push({x,z,r:0,amp,speed:speed||6,max:max||16,gold:0});};
API.stations=STATIONS;
API.handover=(st,hid)=>{
  /* a closed window opens and hands one crate across the quay to the hull */
  const list=stationWins[st];const h=hulls.find(q=>q.id===hid);if(!list.length||!h)return;
  const shut=list.map(i=>winData[i]).filter(w=>w.target===undefined||w.target<.5);
  const w=shut.length?shut.reduce((a,b)=>Math.abs(a.z-h.z)<Math.abs(b.z-h.z)?a:b):winData[list[Math.floor(R()*list.length)]];
  w.target=1;w.tOpen=U.uTime.value;
  flights.push({x0:w.x,y0:w.y+.5,z0:w.z,h,t:0,dur:1.25});
};
API.closeWindows=(st)=>{stationWins[st].forEach(i=>winData[i].target=0);};
API.ring=(state,p)=>{
  if(state==='hold'){if(cer.state!=='holding'&&cer.state!=='armed'){cer.state='holding';cer.ringY=19;}cer.hold=p;if(p>=1)cer.state='armed';}
  if(state==='cancel'){cer.state='cancel';}
  if(state==='drop'){cer.state='drop';cer.t=0;cer.vy=0;cer.hit=0;}
  if(state==='reset'){cer.state='idle';cer.hold=0;cer.after=0;cer.hit=0;cer.ringY=18;cer.dim=0;API._ring.visible=false;API._buc.visible=false;winData.forEach(w=>{if(w.cer){w.target=w.orig;w.cer=0;}});}
};
API.fps=()=>1000/fpsAvg;
API.info=()=>({dpr:size.dpr,refl:size.reflScale||.5,calls:renderer.info.render.calls,tris:renderer.info.render.triangles,hullsZ:hulls.map(h=>+h.z.toFixed(1))});

function step(dt,t){
  U.uTime.value=t;U.uHazeK.value=cam.dist+6;
  /* weather is the rate limit: clear under 50, wind to 75, storm above 90 */
  const tw=smooth(.5,.72,weather.used),ts=smooth(.78,.92,weather.used);
  weather.wind+= (tw-weather.wind)*Math.min(1,dt*1.2);weather.storm+=(ts-weather.storm)*Math.min(1,dt*1.2);
  const wind=weather.wind,storm=weather.storm;
  U.uWind.value=clamp(wind+storm*.5);
  water.material.uniforms.uChop.value=(REDUCED?.5:.55)+wind*.5+storm*1.5;
  const wk=1.14-.3*wind;U.uKeyCol.value.setRGB(lerp(.62,.22,storm)*wk,lerp(.36,.24,storm)*wk,lerp(.4,.36,storm)*wk);
  U.uSky.value.setRGB(lerp(.5,.3,storm),lerp(.64,.38,storm),lerp(.98,.6,storm));

  /* ceremony */
  const hullA=hulls.find(h=>h.id==='aurora');
  const dimTarget=(cer.state==='holding'||cer.state==='armed')?.2+.5*cer.hold:(cer.state==='drop'?.5*(1-smooth(0,1.6,cer.t)):0);
  cer.dim+=(dimTarget-cer.dim)*Math.min(1,dt*3);
  if(cer.state==='holding'||cer.state==='armed'){
    /* windows open in a wave from the Bocca down the street as the ring comes down */
    const lim=-22+cer.hold*46;winData.forEach(w=>{if(w.z<lim&&!w.cer){w.orig=w.target===undefined?w.open:w.target;w.target=1;w.cer=1;}});
    const yT=lerp(19,7.2,1-Math.pow(1-cer.hold,2));cer.ringY+=(yT-cer.ringY)*Math.min(1,dt*6);
    API._ring.visible=true;API._ring.position.set(hullA.x,cer.ringY,hullA.z);API._ring.rotation.set(Math.PI/2+Math.sin(t*.8)*.1,Math.cos(t*.6)*.1,0);
    const k=lerp(.8,1.15,cer.hold);API._ring.scale.setScalar(k);
    API._ring.material.uniforms.uTint.value.setRGB(1,1,1);
  } else if(cer.state==='cancel'){
    cer.ringY+=dt*22;API._ring.position.y=cer.ringY;cer.hold=Math.max(0,cer.hold-dt*2);
    winData.forEach(w=>{if(w.cer){w.target=w.orig;w.cer=0;}});
    if(cer.ringY>22){API._ring.visible=false;cer.state='idle';}
  } else if(cer.state==='drop'){
    cer.t+=dt;
    if(cer.ringY>0&&!cer.hit){cer.vy+=dt*44;cer.ringY-=cer.vy*dt;API._ring.position.y=Math.max(cer.ringY,.1);API._ring.rotation.x=Math.PI/2+Math.sin(t*12)*.03;
      if(cer.ringY<=0){cer.hit=1;cer.hitT=cer.t;cer.flash=.28;
        for(let i=0;i<4;i++)setTimeout(()=>ripples.push({x:hullA.x,z:hullA.z,r:0,amp:1.2-i*.2,speed:11-i*1.1,max:64,gold:1}),i*(REDUCED?500:430));
        spawnSplash(hullA.x,hullA.z);API._onSplash&&API._onSplash();
        winData.forEach(w=>{if(!w.cer){w.orig=w.target===undefined?w.open:w.target;w.cer=1;}w.target=1;});
        U.uRing.value.forEach(v=>v.w=0);
        cer.ringAt=t;API._buc.visible=true;API._buc.position.set(-4.6,0,21.6);API._buc.scale.setScalar(.62);API._buc.userData.t=0;
      }
    } else if(cer.hit){
      API._ring.position.y-=dt*1.1;if(cer.t-cer.hitT>1.6)API._ring.visible=false;
      cer.after=Math.min(1,cer.after+dt/1.4);
      if(cer.t-cer.hitT>4.5)cer.state='after';   /* the camera lets go, the model is yours again */
    }
  }
  cer.flash=Math.max(0,cer.flash-dt*1.6);
  post.comp.uniforms.uFlash.value=cer.flash;
  post.comp.uniforms.uDim.value=cer.dim;
  water.material.uniforms.uDim.value=cer.dim;table.material.uniforms.uDim.value=cer.dim;
  if(API._buc.visible){API._buc.userData.t+=dt;const q=API._buc.userData.t;API._buc.position.z=21.6-smooth(0,8,q)*5.5;API._buc.position.y=Math.sin(t*1.1)*.03;}

  /* gold sweep in world and on the table */
  const gold=ripples.filter(r=>r.gold);
  for(let i=0;i<3;i++){const g=gold[i],v=U.uRing.value[i];if(g){v.set(g.x,g.z,g.r,Math.max(0,1-g.r/g.max));}else v.w=0;}

  /* ripples */
  voiceAcc+=dt;
  if(voiceAmp>.04&&voiceAcc>.16){voiceAcc=0;const h=selected||hullA;ripples.push({x:h.x,z:h.z,r:0,amp:.2+voiceAmp*.7,speed:6,max:17});}
  for(let i=ripples.length-1;i>=0;i--){const r=ripples[i];r.r+=r.speed*dt;if(r.r>r.max)ripples.splice(i,1);}
  const rip=water.material.uniforms.uRip.value;
  for(let i=0;i<8;i++){const r=ripples[Math.max(0,ripples.length-1-i)];const has=i<ripples.length;
    if(has){const f=1-r.r/r.max;rip[i].set(r.x,r.z,r.r,r.amp*(r.gold?Math.sqrt(f):f*f));}else rip[i].w=0;}

  /* windows */
  let dirty=false;const io=winGeo.getAttribute('iO');
  winData.forEach((w,i)=>{if(w.target!==undefined&&Math.abs(w.open-w.target)>.002){w.open+=(w.target-w.open)*Math.min(1,dt*4.5);io.array[i*2]=w.open;if(w.halo>=0)halos.alpha(w.halo,w.open*.2);dirty=true;}});
  if(dirty){io.needsUpdate=true;halos.flush();}
  if(API._bar){const bt=API.barUp?7.0:3.5;API._bar.position.y+=(bt-API._bar.position.y)*Math.min(1,dt*2);}

  /* hulls */
  hulls.forEach(h=>{
    const dz=h.tz-h.z;h.z+=dz*Math.min(1,dt*.55);const moving=Math.abs(dz)>.03;
    h.row+=((moving?1:.0)-h.row)*Math.min(1,dt);
    const bob=Math.sin(t*.9+h.phase)*(.035+.03*wind+.09*storm);
    const list=h.leak*(.1+.03*Math.sin(t*.7))+Math.sin(t*.7+h.phase)*(.012+.02*wind+.05*storm);
    h.group.position.set(h.x,bob-h.leak*.14,h.z);
    h.group.rotation.set(Math.sin(t*.6+h.phase*2)*.012,h.yaw||0,list);
    h.mat.uniforms.uRow.value=h.row;
    h.gild+=((h.state==='gilded'?1:0)-h.gild)*Math.min(1,dt*1.5);h.mat.uniforms.uGild.value=h.gild;
    h.fog+=((h.state==='fog'?1:0)-h.fog)*Math.min(1,dt*.9);
    h.leak+=((h.state==='leak'?1:0)-h.leak)*Math.min(1,dt*.9);
    if(h.kind!=='gondola'){h.progressShown+=(h.progress-h.progressShown)*Math.min(1,dt*2);h.mat.uniforms.uProgress.value=h.progressShown;}
  });

  /* lights: 0 selected hull, 1 gilded glow, 2 leak, 3 ceremony */
  const LP=U.uLP.value,LC=U.uLC.value;
  if(selected){LP[0].set(selected.x+1,4.2,selected.z+1,.07);LC[0].setRGB(.42,.42,.4);}else LC[0].setRGB(0,0,0);
  const au=hullA;LP[1].set(au.x,2.2,au.z,.16);LC[1].setRGB(.8*au.gild,.54*au.gild,.18*au.gild);
  const lk=hulls.find(h=>h.state==='leak');
  if(lk){const pu=.75+.25*Math.sin(t*5);LP[2].set(lk.x+1.1,1.1,lk.z+.6,.5);LC[2].setRGB(2.1*pu*lk.leak,.75*pu*lk.leak,.2*pu*lk.leak);}else LC[2].setRGB(0,0,0);
  const cg=cer.state==='holding'||cer.state==='armed'?cer.hold:(cer.state==='drop'&&!cer.hit?1:0);
  LP[3].set(hullA.x,cer.ringY,hullA.z,.012);LC[3].setRGB(1.1*cg,.72*cg,.26*cg);

  const wu=water.material.uniforms,gl=wu.uGlow.value;
  const cyaw=cam.yaw+cam.dragYaw;wu.uR.value.set(Math.cos(cyaw),-Math.sin(cyaw));
  gl[0].set(au.x,au.z,2.7,au.gild*.42);
  if(lk){const pu=.65+.35*Math.sin(t*5);gl[1].set(lk.x+.3,lk.z,3.2,lk.leak*.62*pu);wu.uSlick.value.set(lk.x-.2,lk.z-.4,4,lk.leak);}else{gl[1].w=0;wu.uSlick.value.w=0;}
  if(selected&&selected!==au)gl[2].set(selected.x,selected.z,3,.16);else gl[2].w=0;

  /* particles */
  soft.reset();parts.reset();
  hulls.forEach(h=>{
    if(h.fog>.01){for(let i=0;i<9;i++){const a=i*2.4+t*.05*(i%2?1:-1),rad=1.2+((i*7)%5)*.45;
      soft.add(h.x+Math.cos(a)*rad,.85+((i*3)%4)*.5+Math.sin(t*.3+i)*.15,h.z+Math.sin(a)*rad*1.9,5+((i*5)%3)*1.3,1,.74,.82,.9,.3*h.fog);}}
    if(h.leak>.01){
      for(let i=0;i<12;i++){const q=(t*.1+i/12)%1;const sway=Math.sin(q*6+i)*.45+q*q*6*U.uWind.value;
        soft.add(h.x+.5+sway,1.2+q*9.5,h.z+.2+q*1.5,1.6+q*4.6,1,.6-.26*q,.44-.14*q,.4-.08*q,1.5*(1-q)*h.leak);}
      for(let i=0;i<7;i++){const q=(t*.5+i*.37)%1;parts.add(h.x+1.2+Math.sin(i*5)*.3*q,.7+q*1.7,h.z+.8,.28,1,1,.46,.13,(1-q)*1.2*h.leak);}
      parts.add(h.x+1.2,.6,h.z+.8,2.4+Math.sin(t*9)*.2,1,1,.33,.08,.8*h.leak);
      /* water coming out of the seam */
      for(let i=0;i<5;i++){const q=(t*1.1+i*.2)%1;parts.add(h.x-.7-q*.8,.46-q*q*.5,h.z-1+i*.6,.13,1,.7,.85,.95,.8*(1-q)*h.leak);}
    }
    if(h.state==='gilded'&&cer.state!=='drop'){for(let i=0;i<14;i++){const q=(t*.07+i/14)%1;const a=i*2.1+t*.2;parts.add(h.x+Math.cos(a)*.9,.5+q*5.5,h.z+Math.sin(a)*3.3,.32,1,1,.76,.32,.95*Math.sin(q*3.14));}}
    if(h.state==='build'){const b=Math.sin(t*2.1)>.2;if(b)for(let i=0;i<7;i++){const q=(t*1.4+i*.14)%1;parts.add(.4+Math.sin(i*2)*q*.8,3.1-q*q*2.4,-5.8+Math.cos(i*3)*q*.8,.2,1,1,.7,.3,1.5*(1-q));}parts.add(.4,2.8,-5.8,1.9,1,1,.6,.2,.65);}
  });
  /* crates in flight */
  for(let i=flights.length-1;i>=0;i--){const f=flights[i];f.t+=dt/f.dur;const k=Math.min(1,f.t),e=k*k*(3-2*k);const x=lerp(f.x0,f.h.x,e),z=lerp(f.z0,f.h.z,e),y=lerp(f.y0,1.1,e)+Math.sin(k*3.14)*1.9;
    parts.add(x,y,z,1.2,1,1,.74,.28,1);parts.add(x,y,z,.32,1,1,.95,.8,1);if(f.t>=1){flights.splice(i,1);ripples.push({x:f.h.x,z:f.h.z,r:0,amp:.28,speed:4,max:9});}}
  /* weather you can read: wind streaks over the street, rain in a storm */
  if(wind>.02){for(let i=0;i<26;i++){const k=(t*(.12+((i*13)%7)*.012)+i/26)%1;const x=lerp(-16,16,k);const z=((i*37)%60)-30,y=1.5+(i*11%6);parts.add(x,y,z,.1,16+(i%5)*3,.7,.82,.95,(.42+.3*storm)*wind*Math.sin(k*3.14));}}
  if(storm>.02){for(let i=0;i<110;i++){const k=(t*1.25+i*.137)%1;const x=((i*29)%48)-24+k*3,z=((i*53)%74)-37;parts.add(x,18-k*18,z,.07,26,.7,.8,.92,.95*storm);}}
  if(API._ring.visible&&!cer.hit){parts.add(API._ring.position.x,API._ring.position.y,API._ring.position.z,9,1,1,.72,.28,.42*Math.max(.3,cer.hold));}
  splash(dt);
  soft.flush();parts.flush();

  /* the view slides up when a slip rises out of the deck */
  if(size.iCur){const c=size.iCur,g=size.insets,k=Math.min(1,dt*3.2);for(const q of['l','t','r','b'])c[q]+=(g[q]-c[q])*k;applyView();}

  /* gentle hold-in-the-hand sway */
  const swY=REDUCED?0:Math.sin(t*.13)*.022,swE=REDUCED?0:Math.sin(t*.17+1)*.008;

  /* camera: eases towards the selected hull, closes in for the ceremony */
  const cf=(cer.state==='holding'||cer.state==='armed'||cer.state==='drop')?.92:.0;
  const sf=selected?(API.follow===undefined?.42:API.follow):0;
  const f=Math.max(sf,cf),tgtH=(cf>sf?hullA:selected)||hullA;
  const base=cam.base||[0,0,0];
  const zm=1-(f*.36)-(cer.state==='holding'||cer.state==='armed'?.05*cer.hold:0);
  const kk=Math.min(1,dt*(REDUCED?20:1.5));
  cam.tx+=(lerp(base[0],tgtH.x,f)-cam.tx)*kk;cam.tz+=(lerp(base[2],tgtH.z,f)-cam.tz)*kk;cam.ty+=(f*.8-cam.ty)*kk;
  cam.dist+=(cam.fit*zm-cam.dist)*kk;cam.yaw+=(camDes.yaw-cam.yaw)*kk;cam.elev+=(camDes.elev-cam.elev)*kk;
  if(!cam.dragging){cam.dragYaw*=1-Math.min(1,dt*.6);cam.dragElev*=1-Math.min(1,dt*.6);}
  poseCamera(cam.yaw+cam.dragYaw+swY+(cam.tilt?cam.tilt.y:0),clamp(cam.elev+cam.dragElev+swE+(cam.tilt?cam.tilt.x:0),.26,1.25),cam.dist,cam.tx,cam.ty,cam.tz);

  /* tilt shift: focus band sits on the subject */
  const fh=(f>.05?tgtH:null);const fy=fh?API.project(fh.x,1,fh.z).y:(size.insets.t+size.h-size.insets.b)/2;
  const fuv=1-fy/size.h;post.comp.uniforms.uFocus.value+=(fuv-post.comp.uniforms.uFocus.value)*Math.min(1,dt*2.5);
}
let splashes=[];
function spawnSplash(x,z){for(let i=0;i<(REDUCED?20:70);i++){const a=R()*6.283,s=rr(2,9);splashes.push({x,z,y:.2,vx:Math.cos(a)*s*.6,vz:Math.sin(a)*s*.6,vy:rr(5,17),l:1});}}
function splash(dt){for(let i=splashes.length-1;i>=0;i--){const p=splashes[i];p.vy-=dt*22;p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;p.l-=dt*.55;if(p.y<0||p.l<=0){splashes.splice(i,1);continue;}parts.add(p.x,p.y,p.z,.32,1,1,.84,.42,p.l*1.4);}}

function render(){
  renderer.info.reset();
  /* 1. reflections: mirror the world across y=0 and draw it small */
  U.uMirror.value=1;root.scale.y=-1;root.updateMatrixWorld(true);top.visible=false;
  renderer.setRenderTarget(rt.refl);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(scene,camera);
  U.uMirror.value=0;root.scale.y=1;root.updateMatrixWorld(true);top.visible=true;
  /* 2. the model */
  renderer.setRenderTarget(rt.main);renderer.clear();renderer.render(scene,camera);
  /* 3. one small blur chain feeds both the tilt shift and the halation */
  const pass=(m,src,dst,o)=>{post.q.material=m;m.uniforms.t.value=src.texture;if(m.uniforms.px)m.uniforms.px.value.set(1/src.width,1/src.height);if(o!==undefined)m.uniforms.o.value=o;renderer.setRenderTarget(dst);renderer.render(post.s,post.c);};
  pass(post.down,rt.main,rt.a);
  pass(post.kaw,rt.a,rt.b,1);pass(post.kaw,rt.b,rt.c,1.5);pass(post.kaw,rt.c,rt.d,1.5);
  post.q.material=post.comp;post.comp.uniforms.tMain.value=rt.main.texture;post.comp.uniforms.tA.value=rt.a.texture;post.comp.uniforms.tB.value=rt.d.texture;
  renderer.setRenderTarget(null);renderer.render(post.s,post.c);
}

/* adaptive quality: hold frame time by trading resolution, not by dropping animation */
let adT=0,adN=0,adAcc=0;
function adapt(ms){
  fpsAvg+=(ms-fpsAvg)*.05;
  if(qs.get('dpr'))return;
  adAcc+=ms;adN++;if(adN<45&&adAcc<1200)return;const av=adAcc/adN;adN=0;adAcc=0;
  if(av>21&&(size.maxDpr||2)>1){size.maxDpr=Math.max(1,(size.maxDpr||Math.min(devicePixelRatio,2))-(av>40?.5:.25));size.reflScale=Math.max(.25,(size.reflScale||.5)-.05);setSize();}
}

let last=0,start=0;
function frame(now){
  requestAnimationFrame(frame);
  if(!last){last=now;start=now;}
  const ms=now-last;last=now;
  const dt=Math.min(.05,ms/1000);
  const t=(now-start)/1000*(REDUCED?.35:1)+40;
  step(dt,t);render();
  API.onFrame&&API.onFrame(dt,t);
  adapt(ms);
}

API.init=(canvas,defs)=>{
  try{
    renderer=new T.WebGLRenderer({canvas,antialias:false,alpha:false,powerPreference:'high-performance',stencil:false,depth:false});
  }catch(e){return false;}
  if(!renderer.capabilities.isWebGL2)return false;
  renderer.outputColorSpace=T.LinearSRGBColorSpace;renderer.autoClear=false;renderer.info.autoReset=false;
  if(matchMedia('(pointer:coarse)').matches)size.maxDpr=1.75;
  tex.noise=noiseTexture(256);tex.brick=brickTexture();tex.roof=roofTexture();tex.strata=strataTexture();
  scene=new T.Scene();root=new T.Group();top=new T.Group();scene.add(root,top);
  camera=new T.PerspectiveCamera(22,1,4,900);
  const opt={depthBuffer:true,stencilBuffer:false};
  rt.main=new T.WebGLRenderTarget(4,4,Object.assign({},opt,{samples:4}));
  rt.refl=new T.WebGLRenderTarget(4,4,opt);
  rt.a=new T.WebGLRenderTarget(4,4,{depthBuffer:false});rt.b=new T.WebGLRenderTarget(4,4,{depthBuffer:false});rt.c=new T.WebGLRenderTarget(4,4,{depthBuffer:false});rt.d=new T.WebGLRenderTarget(4,4,{depthBuffer:false});

  /* table */
  const tgeo=new T.PlaneGeometry(1400,1400);tgeo.rotateX(-Math.PI/2);
  table=new T.Mesh(tgeo,new T.ShaderMaterial({uniforms:{uRes:{value:new T.Vector2()},uRing:U.uRing,uDim:{value:0},tNoise:{value:tex.noise}},vertexShader:FLAT_V,fragmentShader:TABLE_F}));
  table.position.y=-3.5;table.frustumCulled=false;top.add(table);
  const sg=new T.PlaneGeometry(HW*2+22,Z1-Z0+24);sg.rotateX(-Math.PI/2);
  const sh=new T.Mesh(sg,new T.ShaderMaterial({transparent:true,depthWrite:false,vertexShader:FLAT_V,fragmentShader:SHADOW_F}));sh.position.set(0,-3.48,0);top.add(sh);

  /* water */
  const wg=new T.PlaneGeometry(HW*2,Z1-Z0);wg.rotateX(-Math.PI/2);
  const rip=[];for(let i=0;i<8;i++)rip.push(new T.Vector4());
  water=new T.Mesh(wg,new T.ShaderMaterial({vertexShader:FLAT_V,fragmentShader:WATER_F,uniforms:{tRefl:{value:rt.refl.texture},tNoise:{value:tex.noise},uRes:{value:new T.Vector2()},uTime:U.uTime,uChop:{value:1},uDim:{value:0},uStorm:{value:0},
    uDeep:{value:new T.Color(.035,.115,.16)},uSkyA:{value:new T.Color(.1,.22,.34)},uSkyB:{value:new T.Color(.44,.42,.54)},uRip:{value:rip},uR:{value:new T.Vector2(1,0)},uGlow:{value:[new T.Vector4(),new T.Vector4(),new T.Vector4()]},uGlowC:{value:[new T.Color(1,.68,.24),new T.Color(1,.26,.08),new T.Color(.9,.8,.62)]},uSlick:{value:new T.Vector4()}}}));
  top.add(water);

  /* particles */
  halos=new Sprites(320,ADD_F,T.CustomBlending);
  [halos].forEach(s=>{s.mesh.material.blending=T.AdditiveBlending;s.mesh.material.depthTest=true;});
  parts=new Sprites(320,ADD_F,T.AdditiveBlending);
  soft=new Sprites(90,SOFT_F,T.NormalBlending,{tNoise:{value:tex.noise},uTime:U.uTime});
  top.add(halos.mesh,soft.mesh,parts.mesh);
  soft.mesh.renderOrder=4;parts.mesh.renderOrder=5;halos.mesh.renderOrder=3;

  buildArsenale();

  geos.galley=buildGalley();geos.galleass=buildGalley({L:9.6,B:.9});geos.gondola=buildGondola();geos.tow=buildTow();
  hulls=defs.map(makeHull);

  /* ceremonial ring and the state barge (never seen before release) */
  const tor=new T.TorusGeometry(1.7,.15,8,44);const cnt=tor.getAttribute('position').count;
  tor.setAttribute('col',new T.BufferAttribute(new Float32Array(cnt*3).map((_, i)=>[.92,.66,.2][i%3]),3));
  tor.setAttribute('e',new T.BufferAttribute(new Float32Array(cnt).fill(.16),1));
  tor.setAttribute('part',new T.BufferAttribute(new Float32Array(cnt),1));tor.setAttribute('anim',new T.BufferAttribute(new Float32Array(cnt*4),4));
  API._ring=new T.Mesh(tor,worldMat(tex.noise,.1));API._ring.visible=false;API._ring.frustumCulled=false;root.add(API._ring);
  API._buc=new T.Mesh(buildBucintoro(),worldMat(tex.noise,.2));API._buc.visible=false;API._buc.frustumCulled=false;root.add(API._buc);

  /* post */
  const quad=new T.BufferGeometry();quad.setAttribute('position',new T.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  post.down=new T.ShaderMaterial({vertexShader:FS_V,fragmentShader:DOWN_F,uniforms:{t:{value:null},px:{value:new T.Vector2()}},depthTest:false,depthWrite:false});
  post.kaw=new T.ShaderMaterial({vertexShader:FS_V,fragmentShader:KAWASE_F,uniforms:{t:{value:null},px:{value:new T.Vector2()},o:{value:1}},depthTest:false,depthWrite:false});
  post.comp=new T.ShaderMaterial({vertexShader:FS_V,fragmentShader:COMP_F,uniforms:{tMain:{value:null},tA:{value:null},tB:{value:null},uFocus:{value:.5},uBand:{value:.16},uDim:{value:0},uTime:U.uTime,uFlash:{value:0},uHal:{value:.85}},depthTest:false,depthWrite:false});
  post.q=new T.Mesh(quad,post.comp);post.q.frustumCulled=false;post.s=new T.Scene();post.s.add(post.q);post.c=new T.Camera();

  /* pointer: the model is in your hand, so dragging turns it */
  let pd=null;
  canvas.addEventListener('pointerdown',e=>{pd={x:e.clientX,y:e.clientY,y0:cam.dragYaw,e0:cam.dragElev,moved:0};cam.dragging=true;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!pd)return;const dx=e.clientX-pd.x,dy=e.clientY-pd.y;pd.moved=Math.max(pd.moved,Math.abs(dx)+Math.abs(dy));cam.dragYaw=clamp(pd.y0-dx*.005,-.7,.7);cam.dragElev=clamp(pd.e0+dy*.003,-.3,.3);});
  const up=(e)=>{if(!pd)return;cam.dragging=false;if(pd.moved<8&&API.onTap){let best=null,bd=1e9;hulls.forEach(h=>{const p=API.project(h.x,.8,h.z),d=Math.hypot(p.x-e.clientX,p.y-e.clientY);if(d<bd){bd=d;best=h;}});API.onTap(bd<46?best.id:null);}pd=null;};
  canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
  addEventListener('resize',setSize);
  addEventListener('deviceorientation',e=>{if(e.gamma===null)return;cam.tilt=cam.tilt||{x:0,y:0};if(REDUCED)return;cam.tilt.y=clamp(-e.gamma/90,-.3,.3)*.6;cam.tilt.x=clamp((e.beta-45)/90,-.3,.3)*.3;});
  setSize();
  requestAnimationFrame(frame);
  return true;
};
window.VZWorld=API;
})();
