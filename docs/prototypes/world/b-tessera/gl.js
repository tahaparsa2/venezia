/* The Mosaic renderer.
   Nothing here draws a line. Three low-cost steps per frame:
     1. Scene pass: a small offscreen picture (half CSS res) holding what each tile
        should currently be. Colour in rgb, gold in alpha.
     2. FX pass: a smaller field of tilt, lift and flip, driven by rings and voice.
     3. Tile pass: one instanced draw of every tessera. The vertex shader looks up the
        tile's colour once at its centre, so a tile is always one piece of glass.
   Thick glass (keys, slabs) is a separate small instanced draw. */
(function () {
  const VZ = (window.VZ = window.VZ || {});

  const NOISE = `
  float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
  `;

  const FS_VS = `#version 300 es
  out vec2 vUv;
  void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUv=vec2(p.x,p.y);gl_Position=vec4(p*2.-1.,0,1);}`;

  /* ---------- Scene base: sky, water, static art ---------- */
  const SCENE_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D uStatic,uData;
  uniform vec2 uRes; uniform float uT,uWx,uFlash,uDim,uCalm,uWB;
  uniform vec4 uRing[8]; uniform vec4 uRing2[8]; uniform int uNR;
  uniform vec4 uLP[10]; uniform vec3 uLC[10]; uniform int uNL;
  ${NOISE}
  void main(){
    vec2 p=vUv*uRes;
    vec3 c=texture(uStatic,vUv).rgb;
    vec4 d=texture(uData,vUv);
    float W=uWx, wind=smoothstep(.0,.62,W), storm=smoothstep(.72,1.,W);
    if(d.a>.5){
      /* sky: weather is the rate limit */
      c=mix(c,c*vec3(.40,.44,.52),storm);
      vec2 q=p; q.x-=uT*(5.+64.*W);
      float cl=noise(q*vec2(.011,.05))*.62+noise(q*vec2(.034,.13)+7.)*.38;
      float cover=mix(.74,.42,W);
      float k=smoothstep(cover,cover+.07,cl);
      vec3 cloud=mix(vec3(.50,.64,.62),vec3(.17,.22,.25),storm);
      c=mix(c,cloud,k*.8);
      float s=noise(vec2((p.x-uT*(70.+190.*W))*.012,p.y*.30));
      c+=smoothstep(.76,.80,s)*wind*vec3(.50,.72,.66)*.62;
      c+=uFlash*vec3(.7,.75,.8);
    }
    if(d.r>.5){
      /* water: flows along the street */
      float s=d.g,t=d.b,sp=uT*(9.+34.*W);
      float n=noise(vec2((s-sp)*.040,t*.16))*.6+noise(vec2((s-sp*1.7)*.11+9.,t*.42+3.))*.4;
      vec3 deep=vec3(.040,.190,.215),mid=vec3(.100,.400,.385),hi=vec3(.245,.590,.515);
      vec3 w=mix(deep,mid,smoothstep(.26,.62,n));
      w=mix(w,hi,smoothstep(.60,.76,n));
      float cr=smoothstep(mix(.80,.70,W),mix(.85,.76,W),n);
      w=mix(w,vec3(.74,.88,.80),cr*.85);
      c=w;
    }
    if(storm>.01&&p.y<uWB){
      /* rain crosses the whole picture when the window is nearly spent */
      c*=1.-.26*storm;
      float r=noise(vec2((p.x+p.y*.42)*.20,(p.y-uT*420.)*.022));
      c=mix(c,vec3(.62,.72,.76),smoothstep(.70,.76,r)*storm*.8);
      c+=uFlash*vec3(.34,.38,.42);
    }
    /* key and window light falling on neighbouring tiles */
    for(int i=0;i<uNL;i++){vec2 e=p-uLP[i].xy;float f=dot(e,e)/(uLP[i].z*uLP[i].z);
      c+=uLC[i]*uLP[i].w*exp(-f*2.4);}
    /* ring crests read as paler water */
    if(d.r>.5){
      for(int i=0;i<uNR;i++){float dd=length(p-uRing[i].xy),r=uRing[i].z;
        float a=uRing2[i].x*exp(-pow((dd-r)/uRing2[i].y,2.));
        c=mix(c,vec3(.90,.96,.88),clamp(a,0.,1.)*.62);}
    }
    c*=uDim;
    o=vec4(c,0.);
  }`;

  /* ---------- FX field: tilt, lift, flip ---------- */
  const FX_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform vec2 uRes; uniform float uHead,uVoice,uT; uniform vec2 uVP;
  uniform sampler2D uHist;
  uniform vec4 uRing[8]; uniform vec4 uRing2[8]; uniform vec4 uRing3[8]; uniform int uNR;
  void main(){
    vec2 p=vUv*uRes; vec2 t=vec2(0); float lift=0.,flip=0.;
    for(int i=0;i<uNR;i++){
      vec2 e=p-uRing[i].xy; float dd=length(e)+.001; float r=uRing[i].z;
      if(dd>uRing3[i].z+uRing2[i].y*2.) continue;
      float x=(dd-r)/uRing2[i].y;
      float a=uRing2[i].x*exp(-x*x);
      t+=e/dd*a*uRing3[i].x*(-2.*x)*.6;
      lift+=a*.8;
      flip+=exp(-x*x*.9)*uRing3[i].y;
    }
    if(uVoice>.001){
      vec2 e=p-uVP; float dd=length(e)+.001;
      float a=texture(uHist,vec2(uHead-dd/1100.,.5)).r*exp(-dd*.0011);
      float w=sin(dd*.052-uT*11.);
      t+=e/dd*a*w*1.1; lift+=a*(.5+.5*w)*smoothstep(.0,.2,w+.3)*1.05;
    }
    o=vec4(clamp(t*.5+.5,0.,1.),clamp(lift,0.,1.),clamp(flip,0.,1.));
  }`;

  /* ---------- Sprites inside the scene: hulls, fog, smoke, arches ---------- */
  const SPR_VS = `#version 300 es
  layout(location=0) in vec2 aC;
  layout(location=1) in vec4 iP;  // cx,cy,hw,hh
  layout(location=2) in vec4 iA;  // atlas u,v,du,dv
  layout(location=3) in vec4 iCol;
  layout(location=4) in vec4 iPar; // kind,p1,p2,p3
  layout(location=5) in vec2 iRot; // angle, scaleX
  uniform vec2 uRes;
  out vec2 vUv; out vec2 vW; out vec2 vL;
  flat out vec4 vA,vCol,vPar;
  void main(){
    vec2 c=aC; c.x*=iRot.y;
    float s=sin(iRot.x),k=cos(iRot.x);
    vec2 l=c*iP.zw; vec2 r=vec2(l.x*k-l.y*s,l.x*s+l.y*k);
    vec2 w=iP.xy+r; vW=w; vL=aC;
    vUv=aC*.5+.5; vA=iA; vCol=iCol; vPar=iPar;
    vec2 n=w/uRes; gl_Position=vec4(n*2.-1.,0,1);
  }`;

  const SPR_FS = `#version 300 es
  precision highp float;
  in vec2 vUv,vW,vL; flat in vec4 vA,vCol,vPar; out vec4 o;
  uniform sampler2D uAtlas,uData; uniform vec2 uRes; uniform float uT,uDim;
  ${NOISE}
  void main(){
    int k=int(vPar.x+.5);
    vec3 c=vCol.rgb; float gold=0.;
    if(k==0||k==7){ /* hull */
      vec2 uv=vA.xy+vUv*vA.zw;
      vec4 s=texture(uAtlas,uv);
      if(s.a<.5){
        /* oars: a comb that sweeps together */
        if(vCol.a>.5&&vUv.y>.67&&vUv.y<.92&&vUv.x>.27&&vUv.x<.72){
          float x=(vUv.x-.27)/.45*7.+ (vUv.y-.67)*(1.2+.9*sin(uT*2.6));
          if(abs(fract(x)-.5)<.17){o=vec4(vec3(.62,.52,.36),0.);return;}
        }
        discard;
      }
      c=s.rgb;
      vec4 m=texture(uAtlas,uv+vec2(0.,vA.w));
      if(m.r>.5&&m.a>.5){
        if(k==7) gold=1.;
        else if(vPar.y>0.&&length(vW-vPar.zw*vec2(1.))<vPar.y) gold=1.;
      }
      if(k==7&&vPar.y>0.&&length(vW-vPar.zw)>vPar.y) discard;
      if(gold>.5) c=vec3(.85,.66,.23);
    } else if(k==1){ /* reflection: stippled, water only */
      if(texture(uData,vW/uRes).r<.5) discard;
      vec2 uv=vA.xy+vec2(vUv.x,vUv.y)*vA.zw;
      vec4 s=texture(uAtlas,uv);
      if(s.a<.5) discard;
      float f=1.-abs(vL.y);
      if(hash(floor(vW/2.))>.72) discard;
      c=mix(vec3(.04,.15,.17),s.rgb*.55,.55);
    } else if(k==2){ /* fog: open questions */
      float r=length(vL*vec2(1.,1.2));
      vec2 q=vL*vec2(2.6,2.3)+vec2(uT*.11,uT*.05)+vCol.a;
      float n=noise(q)*.6+noise(q*2.3+4.)*.4;
      float a=(n+.40-r*.62);
      a+=(hash(floor(vW/3.))-.5)*.12;
      if(a<.56) discard;
      c=mix(vec3(.60,.70,.70),vec3(.86,.90,.86),smoothstep(.56,.86,a));
    } else if(k==3){ /* pitch smoke: gate failed */
      float y=vUv.y; /* 1 at base, 0 at top */
      float wob=sin(y*6.+uT*1.3)*.18*(1.-y)+vPar.y*(1.-y)*.7;
      float x=(vL.x-wob)/(.20+.75*(1.-y));
      vec2 q=vec2(vL.x*2.2,vL.y*2.5+uT*.75);
      float n=noise(q)*.65+noise(q*2.7)*.35;
      float a=n+.52-abs(x)*.9-(1.-y)*.42;
      if(a<.52) discard;
      c=mix(vec3(.13,.12,.12),vec3(.50,.46,.42),smoothstep(.5,.78,n));
      if(y>.55&&n>.72) c=vec3(.86,.26,.10);
    } else if(k==4){ /* flat tile fill */
    } else if(k==5){ /* arched window fill */
      vec2 q=vL;
      float inside=q.y>-.38?step(abs(q.x),1.):step(length(vec2(q.x,(q.y+.38)/.62)),1.);
      if(inside<.5) discard;
      /* a deep window: light gathers low, at the sill where things are handed out */
      float g=.72+.28*noise(vec2(vW.x*.3,vW.y*.3+uT*1.6));
      float low=smoothstep(.15,.95,q.y)*(1.-.35*abs(q.x));
      if(low+hash(floor(vW/2.))*.14<.34) c=vec3(.055,.085,.09)+c*.05;
      else c*=g*(.42+.72*low);
    } else if(k==6){ /* leak: bilge staining the water */
      if(texture(uData,vW/uRes).r<.5) discard;
      float r=length(vL);
      float n=noise(vL*5.+vec2(uT*.2,0.));
      if(n+.3-r<.25+hash(floor(vW/2.))*.1) discard;
      if(vCol.a>.5) c=mix(vec3(.82,.20,.09),vec3(.42,.09,.06),n)*(.82+.18*sin(uT*5.));
      else c=mix(c,vec3(.05,.2,.22),.45);
    } else if(k==8){ /* window bars */
      if(fract(vUv.x*vPar.y)>.52&&fract(vUv.y*2.)>.14) discard;
    } else if(k==9){ /* sparks of work */
      vec2 g=floor(vW/3.);
      float h=hash(g+floor(uT*7.));
      if(h<.955-.03*vCol.a) discard;
      if(length(vL)>1.) discard;
      c=mix(c,vec3(.95,.98,1.),hash(g));
    }
    o=vec4(c*uDim,gold);
    if((k==0||k==7)&&vCol.r>.5) o=vec4(c,gold); /* hero hull is not dimmed */
  }`;

  /* ---------- Tessera ---------- */
  const TILE_VS = (dyn) => `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aC;
  layout(location=1) in vec4 iA;
  layout(location=2) in vec2 iB;
  ${dyn ? `layout(location=3) in vec4 iCol; layout(location=4) in vec4 iG; layout(location=5) in vec4 iInk; layout(location=6) in vec4 iFx;` : ''}
  uniform vec2 uRes; uniform sampler2D uScene,uFx; uniform float uCalm,uMotion,uT,uVT;
  out vec2 vL,vW,vGuv;
  flat out vec2 vH,vTilt,vShear,vRot;
  flat out vec3 vCol; flat out vec3 vInk;
  flat out float vGold,vLift,vSeed,vInkA;
  float h1(float s){return fract(sin(s*91.17)*43758.5453);}
  void main(){
    float seed=iB.y;
    vec2 size=iA.zw;
    ${dyn ? `
      vec4 c=iCol; vec4 fx=vec4(iFx.zw*.5+.5,iFx.x,iFx.y);
      vGuv=iG.xy+(aC*.5+.5)*iG.zw; vInk=iInk.rgb; vInkA=iG.z>0.?iInk.a:0.;
    ` : `
      vec2 uv=iA.xy/uRes;
      vec4 c=textureLod(uScene,uv,0.); vec4 fx=textureLod(uFx,uv,0.);
      vGuv=vec2(0); vInk=vec3(0); vInkA=0.;
    `}
    float a1=h1(seed),a2=h1(seed+1.7),a3=h1(seed+3.1),a4=h1(seed+5.3);
    vec3 col=c.rgb;
    ${dyn ? '' : `
      col*=.91+.18*a1;
      col+=(vec3(a2,a3,a4)-.5)*.09*col;
      col=floor(col*16.+a4)/16.;
    `}
    col+=vec3(.06,.42,.31)*fx.b*min(uVT,1.);
    vCol=col; vGold=c.a; vSeed=seed;
    float flip=fx.a, ph=flip*3.14159;
    float fs=abs(cos(ph));
    vec2 base=(vec2(a2,a3)-.5)*mix(.30,.03,uCalm);
    if(uMotion<.5) base*=.8;
    vec2 ang=fx.rg*2.-1.;
    vTilt=base+ang*1.0+vec2(0.,sin(ph)*.7);
    vLift=fx.b;
    float lift=1.+fx.b*.12;
    vH=size*.5*vec2(1.,max(fs,.42))*lift;
    vShear=(vec2(a1,a4)-.5)*.17;
    float sn=sin(iB.x),cs=cos(iB.x);
    vRot=vec2(cs,sn);
    vec2 pad=vH+1.;
    vec2 l=aC*pad; vL=l;
    vec2 w=iA.xy+vec2(l.x*cs-l.y*sn,l.x*sn+l.y*cs);
    vW=w;
    vec2 n=w/uRes*2.-1.;
    gl_Position=vec4(n.x,-n.y,0,1);
  }`;

  const TILE_FS = `#version 300 es
  precision highp float;
  in vec2 vL,vW,vGuv;
  flat in vec2 vH,vTilt,vShear,vRot; flat in vec3 vCol,vInk; flat in float vGold,vLift,vSeed,vInkA;
  uniform vec3 uLight; uniform vec3 uEye; uniform float uPx,uFlash,uSheen; uniform sampler2D uGlyph;
  out vec4 o;
  const vec3 GROUT=vec3(.031,.043,.042);
  void main(){
    vec2 q=vL+vec2(vShear.x*vL.y,vShear.y*vL.x);
    float r=min(vH.x,vH.y)*.30;
    vec2 b=abs(q)-(vH-r);
    float d=length(max(b,0.))+min(max(b.x,b.y),0.)-r;
    float cov=smoothstep(uPx*.8,-uPx*.8,d);
    if(cov<.01) discard;
    /* bevel normal, local then world */
    vec2 g=(b.x>b.y?vec2(sign(q.x),0.):vec2(0.,sign(q.y)));
    if(max(b.x,b.y)>0.) g=normalize(max(b,0.))*sign(q);
    float e=smoothstep(-min(1.5,min(vH.x,vH.y)*.55),0.,d);
    vec2 ln=g*e*.62;
    /* hand-poured glass is never flat */
    float w=sin(q.x*1.7+vSeed*40.)*sin(q.y*1.9+vSeed*17.);
    ln+=vec2(w,-w)*.045;
    vec2 wn=vec2(ln.x*vRot.x-ln.y*vRot.y,ln.x*vRot.y+ln.y*vRot.x);
    vec3 N=normalize(vec3(vTilt+wn,1.));
    vec3 Lv=normalize(uLight-vec3(vW,0.));
    vec3 V=normalize(uEye-vec3(vW,0.));
    vec3 H=normalize(Lv+V);
    float nh=max(dot(N,H),0.),nl=max(dot(N,Lv),0.);
    vec3 c;
    if(vGold>.5){
      /* gold leaf under a thin glass foil */
      float a=pow(nh,14.);
      c=mix(vec3(.60,.42,.12),vec3(.90,.70,.25),smoothstep(.05,.62,a+vCol.g*.25));
      c=mix(c,vec3(1.,.87,.50),smoothstep(.55,1.,pow(nh,70.)));
      c+=vec3(1.,.95,.8)*pow(nh,520.)*1.2;
    } else {
      float lum=dot(vCol,vec3(.3,.55,.15));
      float sp=(pow(nh,240.)*.72+pow(nh,30.)*.07)*(.22+.78*smoothstep(.03,.3,lum));
      c=vCol*(.76+.40*nl);
      c+=vec3(.92,.96,.92)*sp;
      /* light gathered inside the glass, opposite the highlight */
      c+=vCol*.20*smoothstep(.6,-.6,dot(q/vH,normalize(Lv.xy+.001)*vec2(vRot.x,-vRot.y)));
      c+=vec3(.75,.80,.76)*uSheen*pow(nh,10.);
    }
    if(vInkA>.0){
      float m=texture(uGlyph,vGuv).r;
      c=mix(c,vInk,smoothstep(.34,.66,m)*vInkA);
    }
    c+=c*vLift*.7;
    c*=mix(.62,1.,smoothstep(0.,-1.1,d));
    o=vec4(c,cov);
  }`;

  /* ---------- Thick glass: keys, lamps, dial, slabs ---------- */
  const THICK_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aC;
  layout(location=1) in vec4 iA; // cx,cy,hw,hh
  layout(location=2) in vec4 iB; // radius,depth,press,kind
  layout(location=3) in vec4 iC; // body rgb, seed
  layout(location=4) in vec4 iD; // glow rgb, intensity
  layout(location=5) in vec4 iE; // aux
  uniform vec2 uRes;
  out vec2 vP,vW;
  flat out vec4 vA,vB,vC,vD,vE;
  void main(){
    vec2 pad=iA.zw+vec2(34.,38.)+vec2(0.,iB.y);
    vec2 l=aC*pad; vP=l;
    vec2 w=iA.xy+l; vW=w;
    vA=iA;vB=iB;vC=iC;vD=iD;vE=iE;
    vec2 n=w/uRes*2.-1.;
    gl_Position=vec4(n.x,-n.y,0,1);
  }`;

  const THICK_FS = `#version 300 es
  precision highp float;
  in vec2 vP,vW; flat in vec4 vA,vB,vC,vD,vE;
  uniform sampler2D uScene; uniform vec2 uRes; uniform vec3 uLight; uniform float uT,uPx;
  out vec4 o;
  ${NOISE}
  float rb(vec2 p,vec2 h,float r){vec2 q=abs(p)-(h-r);return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
  void main(){
    vec2 hs=vA.zw; float rad=vB.x,dep=vB.y,press=vB.z; int kind=int(vB.w+.5);
    float h=dep*(1.-press*.78);
    vec2 P=vP;
    float dTop=rb(P-vec2(0.,-h),hs,rad);
    float dBody=rb(P-vec2(0.,-h*.5),hs+vec2(0.,h*.5),rad);
    float dSh=rb(P-vec2(2.,4.+h*.6),hs+1.,rad+1.);
    float sh=smoothstep(mix(26.,10.,press),-8.,dSh)*.62;
    if(kind==3){ /* falling ring only */
      float R=length(P)/hs.x;
      float band=smoothstep(.09,.055,abs(R-.86));
      float th=atan(P.y,P.x);
      vec3 g=mix(vec3(.55,.36,.10),vec3(1.,.86,.5),.5+.5*sin(th*3.+uT*5.));
      o=vec4(g*band,band);return;
    }
    vec3 acc=vec3(0.); float al=sh;
    /* wall */
    float wallA=smoothstep(uPx,-uPx,dBody);
    if(wallA>0.){
      float v=clamp((P.y-(hs.y-h))/(h+.01),0.,1.);
      vec3 w=vC.rgb*.42+vD.rgb*vD.a*(.32+.34*(1.-v));
      w*=mix(1.,.38,v*v);
      float sx=abs(P.x)/hs.x; w*=1.-.24*smoothstep(.72,1.,sx);
      acc=mix(acc,w,wallA); al=max(al,wallA);
    }
    float topA=smoothstep(uPx,-uPx,dTop);
    if(topA>0.){
      vec2 T=P-vec2(0.,-h);
      float e=clamp(-dTop/max(5.,min(hs.x,hs.y)*.2),0.,1.);
      float eb=1.-e; eb=eb*eb;
      /* gradient of the box field */
      vec2 q=abs(T)-(hs-rad);
      vec2 g=(q.x>q.y?vec2(sign(T.x),0.):vec2(0.,sign(T.y)));
      if(max(q.x,q.y)>0.) g=normalize(max(q,0.))*sign(T);
      vec3 N=normalize(vec3(g*eb*1.5,1.));
      vec3 Lv=normalize(uLight-vec3(vW,0.));
      vec3 V=normalize(vec3(uRes.x*.5,uRes.y*.46,760.)-vec3(vW,0.));
      vec3 H=normalize(Lv+V);
      float nh=max(dot(N,H),0.);
      float rn=length(T/hs);
      vec3 c;
      if(kind==2){
        /* slab of vellum-coloured Istrian stone */
        float n=noise(T*vec2(.03,.08)+vC.a*9.)*.6+noise(T*vec2(.12,.2)+3.)*.4;
        c=vC.rgb*(.972+.05*n);
        float vein=smoothstep(.015,.0,abs(noise(T*.022+vC.a)-.5))*.05;
        c-=vein;
        c*=1.-.10*smoothstep(.0,1.,eb);
        c+=vec3(1.)*pow(nh,1800.)*.06;
        c=mix(c,c*.86+vD.rgb*.3,vD.a*0.);
      } else {
        vec2 uv=(vW+g*eb*30.+vec2(0.,8.))/uRes;
        vec3 scn=texture(uScene,uv).rgb;
        float fr=noise(T*.9+vC.a*30.)*.5+noise(T*2.2)*.5;
        c=mix(vC.rgb,scn*1.1,.16);
        /* inner light sits under the glass */
        float core=exp(-rn*rn*1.5);
        float edge=smoothstep(.55,0.,e*1.);
        vec3 glow=vD.rgb*vD.a;
        c+=glow*(.78*core+.34*edge)*(.86+.3*fr);
        c+=vC.rgb*.08*(fr-.5);
        if(vE.w>.0){ /* crawl of light around the rim */
          float th=atan(T.y/hs.y,T.x/hs.x);
          float cr=pow(.5+.5*sin(th*2.-uT*5.),5.);
          c+=vD.rgb*edge*cr*vE.w*.9;
        }
        /* broad reflection across the top */
        float st=dot(T/hs,normalize(vec2(.55,-.84)));
        c+=vec3(.82,.90,.88)*smoothstep(.34,.92,st+.10)*.055;
        c+=vec3(1.)*pow(nh,44.)*.40*eb;
        c+=vec3(1.)*pow(nh,2400.)*.16;
      }
      if(kind==1){
        /* dial: knurled rim, gold ring only when a gate has passed */
        float R=length(T)/hs.x; float th=atan(T.x,-T.y);
        float kn=smoothstep(.82,.86,R)*(.5+.5*sin(th*52.+vE.x));
        c*=1.-.32*kn;
        c+=vec3(.5)*kn*.09;
        float dim=smoothstep(.70,.74,R)*(1.-smoothstep(.98,1.,R));
        float rv=vE.y;
        if(rv>.0){
          float ring=smoothstep(.70,.74,R)*(1.-smoothstep(.97,1.,R));
          float tw=(th<0.?th+6.2832:th)/6.2832;
          float seg=fract(tw*24.);
          float gap=smoothstep(.0,.06,seg)*(1.-smoothstep(.94,1.,seg));
          float f=step(tw,vE.z);
          float tor=1.-abs((R-.85)/.15); float nz=sqrt(clamp(tor,0.,1.));
          float sw=.5+.5*sin(th*2.-uT*2.2);
          vec3 dull=mix(vec3(.34,.22,.07),vec3(.70,.50,.16),nz*sw);
          vec3 lit=mix(vec3(.85,.62,.20),vec3(1.,.90,.58),pow(sw,3.)*nz+.25);
          vec3 g2=mix(dull,lit,f)*gap;
          c=mix(c,g2,ring*rv);
        }
      }
      acc=mix(acc,c,topA); al=max(al,topA);
      /* lit upper rim */
      float rim=smoothstep(uPx*2.,0.,abs(dTop+.8))*smoothstep(.2,-.9,T.y/hs.y);
      acc+=vec3(.9,.95,.9)*rim*.16;
    }
    o=vec4(acc,al);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').slice(0, 4).join('\n'));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const a = gl.getActiveUniform(p, i);
      const nm = a.name.replace(/\[0\]$/, '');
      u[nm] = gl.getUniformLocation(p, a.name);
    }
    return { p, u };
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('webgl2');
      this.gl = gl;
      this.pScene = program(gl, FS_VS, SCENE_FS);
      this.pFx = program(gl, FS_VS, FX_FS);
      this.pSpr = program(gl, SPR_VS, SPR_FS);
      this.pTile = program(gl, TILE_VS(false), TILE_FS);
      this.pDyn = program(gl, TILE_VS(true), TILE_FS);
      this.pThick = program(gl, THICK_VS, THICK_FS);
      this.emptyVao = gl.createVertexArray();

      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.quad = quad;

      const mkVao = (stride, attrs, usage) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        attrs.forEach(([loc, n, off]) => {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride * 4, off * 4);
          gl.vertexAttribDivisor(loc, 1);
        });
        gl.bindVertexArray(null);
        return { vao, buf, cap: 0 };
      };
      this.vTile = mkVao(6, [[1, 4, 0], [2, 2, 4]]);
      this.vDyn = mkVao(22, [[1, 4, 0], [2, 2, 4], [3, 4, 6], [4, 4, 10], [5, 4, 14], [6, 4, 18]]);
      this.vSpr = mkVao(18, [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 4, 12], [5, 2, 16]]);
      this.vThick = mkVao(20, [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 4, 12], [5, 4, 16]]);

      this.histTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.histTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.histN = 256;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.histN, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(this.histN));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.histHead = 0;
      this.rv = new Float32Array(32); this.rv2 = new Float32Array(32); this.rv3 = new Float32Array(32);
      this.lp = new Float32Array(40); this.lc = new Float32Array(30);
      this.histByte = new Uint8Array(1);
    }

    tex(filter, wrap) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    setCanvasSize(W, H, dpr) {
      const c = this.canvas;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      this.W = W; this.H = H; this.dpr = dpr;
    }

    setWorld(staticCanvas, data, dw, dh, tiles, sw, sh) {
      const gl = this.gl;
      this.sw = sw; this.sh = sh;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      for (const k of ['tStatic', 'tData', 'tScene', 'tFx']) if (this[k]) gl.deleteTexture(this[k]);
      for (const k of ['fScene', 'fFx']) if (this[k]) gl.deleteFramebuffer(this[k]);
      this.tStatic = this.tex(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, staticCanvas);
      this.tData = this.tex(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, dw, dh, 0, gl.RGBA, gl.FLOAT, data);

      this.tScene = this.tex(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fScene = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fScene);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tScene, 0);

      this.fw = Math.max(2, sw >> 1); this.fh = Math.max(2, sh >> 1);
      this.tFx = this.tex(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.fw, this.fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fFx = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fFx);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tFx, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vTile.buf);
      gl.bufferData(gl.ARRAY_BUFFER, tiles, gl.STATIC_DRAW);
      this.nTiles = tiles.length / 6;
    }

    setAtlas(canvas) {
      const gl = this.gl;
      if (!this.tAtlas) this.tAtlas = this.tex(gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, this.tAtlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
    setGlyphs(canvas) {
      const gl = this.gl;
      if (!this.tGlyph) {
        this.tGlyph = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tGlyph);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tGlyph);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    pushHist(level, steps) {
      const gl = this.gl;
      if (gl.isContextLost()) return;
      gl.bindTexture(gl.TEXTURE_2D, this.histTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const v = Math.max(0, Math.min(255, level * 255 | 0));
      this.histByte[0] = v;
      for (let i = 0; i < steps; i++) {
        this.histHead = (this.histHead + 1) % this.histN;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, this.histHead, 0, 1, 1, gl.RED, gl.UNSIGNED_BYTE, this.histByte);
      }
    }

    bindTex(unit, tex, loc) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    draw(f) {
      const gl = this.gl, W = this.W, H = this.H;
      const rv = this.rv, rv2 = this.rv2, rv3 = this.rv3;
      const nr = Math.min(8, f.rings.length);
      for (let i = 0; i < nr; i++) {
        const r = f.rings[i];
        const o = i * 4;
        rv[o] = r.x; rv[o + 1] = r.y; rv[o + 2] = r.r;
        rv2[o] = r.a; rv2[o + 1] = r.w;
        rv3[o] = r.tilt; rv3[o + 1] = r.flip; rv3[o + 2] = r.max;
      }
      const nl = Math.min(10, f.lights.length);
      const lp = this.lp, lc = this.lc;
      for (let i = 0; i < nl; i++) {
        const l = f.lights[i];
        lp[i * 4] = l.x; lp[i * 4 + 1] = l.y; lp[i * 4 + 2] = l.r; lp[i * 4 + 3] = l.i;
        lc[i * 3] = l.c[0]; lc[i * 3 + 1] = l.c[1]; lc[i * 3 + 2] = l.c[2];
      }

      gl.disable(gl.BLEND);
      /* 1. scene */
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fScene);
      gl.viewport(0, 0, this.sw, this.sh);
      let P = this.pScene;
      gl.useProgram(P.p);
      gl.bindVertexArray(this.emptyVao);
      this.bindTex(0, this.tStatic, P.u.uStatic);
      this.bindTex(1, this.tData, P.u.uData);
      gl.uniform2f(P.u.uRes, W, H);
      gl.uniform1f(P.u.uT, f.t);
      gl.uniform1f(P.u.uWx, f.wx);
      gl.uniform1f(P.u.uFlash, f.flash);
      gl.uniform1f(P.u.uDim, f.dim);
      gl.uniform1f(P.u.uWB, f.worldB);
      gl.uniform1i(P.u.uNR, nr);
      gl.uniform4fv(P.u.uRing, rv);
      gl.uniform4fv(P.u.uRing2, rv2);
      gl.uniform1i(P.u.uNL, nl);
      gl.uniform4fv(P.u.uLP, lp);
      gl.uniform3fv(P.u.uLC, lc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (f.nSprites) {
        P = this.pSpr;
        gl.useProgram(P.p);
        gl.bindVertexArray(this.vSpr.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vSpr.buf);
        gl.bufferData(gl.ARRAY_BUFFER, f.sprites.subarray(0, f.nSprites * 18), gl.DYNAMIC_DRAW);
        this.bindTex(0, this.tAtlas, P.u.uAtlas);
        this.bindTex(1, this.tData, P.u.uData);
        gl.uniform2f(P.u.uRes, W, H);
        gl.uniform1f(P.u.uT, f.t);
        gl.uniform1f(P.u.uDim, f.dim);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.nSprites);
      }

      if (VZ.debugScene) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fScene);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.blitFramebuffer(0, 0, this.sw, this.sh, 0, this.canvas.height, this.canvas.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }
      /* 2. fx */
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fFx);
      gl.viewport(0, 0, this.fw, this.fh);
      P = this.pFx;
      gl.useProgram(P.p);
      gl.bindVertexArray(this.emptyVao);
      this.bindTex(0, this.histTex, P.u.uHist);
      gl.uniform2f(P.u.uRes, W, H);
      gl.uniform1f(P.u.uHead, (this.histHead + 0.5) / this.histN);
      gl.uniform1f(P.u.uT, f.t);
      gl.uniform1f(P.u.uVoice, f.voice);
      gl.uniform2f(P.u.uVP, f.voiceP[0], f.voiceP[1]);
      gl.uniform1i(P.u.uNR, nr);
      gl.uniform4fv(P.u.uRing, rv);
      gl.uniform4fv(P.u.uRing2, rv2);
      gl.uniform4fv(P.u.uRing3, rv3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      /* 3. tiles */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.031, 0.043, 0.042, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const setTile = (P) => {
        gl.useProgram(P.p);
        gl.uniform2f(P.u.uRes, W, H);
        gl.uniform1f(P.u.uCalm, f.calm);
        gl.uniform1f(P.u.uMotion, f.motion ? 1 : 0);
        gl.uniform3f(P.u.uLight, f.light[0], f.light[1], f.light[2]);
        gl.uniform3f(P.u.uEye, W * 0.5, H * 0.46, 760);
        gl.uniform1f(P.u.uPx, 1 / this.dpr);
        gl.uniform1f(P.u.uSheen, f.sheen);
        gl.uniform1f(P.u.uVT, f.voiceTint);
        this.bindTex(0, this.tScene, P.u.uScene);
        this.bindTex(1, this.tFx, P.u.uFx);
        this.bindTex(2, this.tGlyph, P.u.uGlyph);
      };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      setTile(this.pTile);
      gl.bindVertexArray(this.vTile.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nTiles);

      const drawDyn = (buf, n) => {
        if (!n) return;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        setTile(this.pDyn);
        gl.bindVertexArray(this.vDyn.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vDyn.buf);
        gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, n * 22), gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      };
      drawDyn(f.dynA, f.nDynA);

      if (f.nThick) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        P = this.pThick;
        gl.useProgram(P.p);
        gl.bindVertexArray(this.vThick.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vThick.buf);
        gl.bufferData(gl.ARRAY_BUFFER, f.thick.subarray(0, f.nThick * 20), gl.DYNAMIC_DRAW);
        gl.uniform2f(P.u.uRes, W, H);
        gl.uniform3f(P.u.uLight, f.light[0], f.light[1], f.light[2]);
        gl.uniform1f(P.u.uT, f.t);
        gl.uniform1f(P.u.uPx, 1 / this.dpr);
        this.bindTex(0, this.tScene, P.u.uScene);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.nThick);
      }
      drawDyn(f.dynB, f.nDynB);
      gl.disable(gl.BLEND);
    }
  }
  VZ.Renderer = Renderer;
})();
