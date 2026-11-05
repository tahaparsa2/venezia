/* water.js: the one full-screen pass. Sky and water are the same drawing:
   parallel engraved lines whose thickness carries all the light. Nothing glows.
   Hulls, rings and voice all act by warping the coordinates the lines are read at,
   using a potential-flow displacement so lines part around a hull as streamlines do. */
window.V = window.V || {};
(function () {
  const VS = `attribute vec2 a; uniform vec2 uRes; varying vec2 vP;
  void main(){ vP=vec2((a.x+1.)*.5*uRes.x,(1.-a.y)*.5*uRes.y); gl_Position=vec4(a,0.,1.); }`;

  const FS = `#extension GL_OES_standard_derivatives : enable
  precision highp float;
  varying vec2 vP;
  uniform vec2 uRes, uFocus;
  uniform vec3 uMoon;
  uniform float uT,uWind,uStorm,uVoice,uHold,uHorizon,uShock,uDens;
  uniform vec4 uHullA[6];
  uniform vec4 uHullB[6];
  uniform vec4 uRing[6];
  uniform sampler2D uField;
  const vec3 LAG=vec3(.043,.122,.141);
  const vec3 VER=vec3(.243,.557,.494);
  const vec3 VRL=vec3(.392,.690,.620);
  const vec3 GLD=vec3(.851,.663,.227);
  const vec3 VEL=vec3(.937,.894,.796);
  const vec3 RED=vec3(.784,.224,.122);
  float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
  float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    float a=h1(i.x+i.y*57.),b=h1(i.x+1.+i.y*57.),c=h1(i.x+(i.y+1.)*57.),d=h1(i.x+1.+(i.y+1.)*57.);
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
  float line(float c,float t){float fr=abs(fract(c)-.5);float aa=fwidth(c)*.8;return 1.-smoothstep(t-aa,t+aa,fr);}
  /* Width in screen pixels, so a warped field never fattens a line. */
  float burin(float c,float px){float fw=fwidth(c);float t=min(px*fw,.47);float fr=abs(fract(c)-.5);return 1.-smoothstep(t-fw*.75,t+fw*.75,fr);}
  void main(){
    vec2 p=vP; float ny=p.y/uRes.y;
    vec3 col;
    float rain=0.;
    if(uStorm>.01){
      float rc=(p.x+p.y*.42+uT*90.)/9.; float rid=floor(rc);
      float rd=vn(vec2(rid*.73,p.y*.018-uT*5.5));
      rain=line(rc,.05+.06*uStorm)*smoothstep(.62-.22*uStorm,.82,rd)*uStorm;
    }
    if(p.y<uHorizon){
      /* sky */
      vec2 w=p; w.y+=sin(p.x*.011+uT*.09)*1.1;
      float c=w.y/2.5, id=floor(c);
      float md=distance(p,uMoon.xy), mr=uMoon.z;
      float cl=vn(p*vec2(.0075,.024)+vec2(uT*(.012+uWind*.05),3.))*.65+vn(p*vec2(.02,.06)+vec2(uT*(.02+uWind*.08),9.))*.35;
      float cloud=smoothstep(.5-.22*uStorm-.08*uWind,.74,cl);
      float halo=exp(-md/(mr*3.4));
      float tone=.055+.34*halo+cloud*(.16+.2*exp(-md/(mr*7.)))+uShock*.2;
      float st=vn(vec2(p.x*.008-uT*(.5+uWind*2.6),id*.91));
      tone+=(.1+.2*uStorm)*uWind*smoothstep(.62,.9,st);
      tone*=.75+.5*vn(vec2(p.x*.05,id*1.3));
      float ink=line(c,min(.46,tone));
      vec3 lc=mix(VER,GLD,clamp(halo*1.4,0.,1.));
      lc=mix(lc,VEL,clamp(cloud*.45+halo*.3,0.,1.));
      col=mix(LAG*.86,lc,ink*.92);
      if(md<mr){
        /* the moon: cross-cut, shaded towards the lower left */
        vec2 m=(p-uMoon.xy)/mr; float z=sqrt(max(0.,1.-dot(m,m)));
        float lit=clamp(dot(vec3(m,z),normalize(vec3(.5,-.45,.72))),0.,1.);
        float cr=vn(m*4.3+2.)*.5+vn(m*9.)*.5;
        float t1=.08+.38*lit*(.72+.45*cr);
        float a=line((p.x*.62+p.y*.79)/1.9,t1), b=line((p.x*.62-p.y*.79)/1.9,t1*.82);
        col=mix(LAG*.7,VEL,clamp(a+b*lit,0.,1.));
      }
      float rimd=abs(md-mr); col=mix(col,VEL,(1.-smoothstep(.2,1.1,rimd))*.9);
      col=mix(col,VEL,rain*.4);
      gl_FragColor=vec4(col,1.); return;
    }
    /* water */
    vec2 w=p; float gold=0.,red=0.,foam=0.,lee=1.;
    for(int i=0;i<6;i++){
      vec4 A=uHullA[i],B=uHullB[i];
      if(A.z<=0.) continue;
      vec2 q=p-A.xy; vec2 d=B.xy; vec2 n=vec2(-d.y,d.x);
      vec2 r=vec2(dot(q,d)/A.z,dot(q,n)/(A.z*.28));
      float rr=dot(r,r);
      w-=q*(.92/max(rr,1.));
      lee=min(lee,smoothstep(.62,1.02,rr));
      float nearH=exp(-rr*.22);
      gold+=B.z*nearH; red+=B.w*exp(-rr*.16);
      if(A.w>.01){
        float bx=-r.x-1.; float sp=abs(r.y)-bx*.42;
        foam+=A.w*(1.-smoothstep(0.,1.1,abs(sp)))*smoothstep(0.,.35,bx)*exp(-bx*.28);
      }
      foam+=.28*exp(-rr*.5);
    }
    float ringT=0.;
    for(int i=0;i<6;i++){
      vec4 R=uRing[i];
      if(R.w<=0.) continue;
      vec2 q=p-R.xy; float r=length(q*vec2(1.,1.85));
      float b=exp(-pow((r-R.z)/(8.+R.z*.012),2.));
      w+=normalize(q+.001)*sin((r-R.z)*.42)*b*9.*R.w;
      ringT+=b*R.w;
    }
    if(uVoice>.005){
      vec2 q=p-uFocus; float r=length(q*vec2(1.,1.8));
      float e=exp(-r/(70.+uVoice*90.));
      w+=normalize(q+.001)*sin(r*.16-uT*8.)*e*uVoice*8.;
      foam+=e*uVoice*.5;
    }
    if(uHold>.002){
      vec2 q=p-uFocus; float r=length(q*vec2(1.,1.7));
      w+=q*.2*uHold*exp(-r/220.);
      gold+=uHold*1.3*exp(-r/(50.+uHold*uHold*420.));
    }
    float A=1.+uWind*1.5+uStorm*2.6;
    w.y+=sin(w.x*.017+w.y*.03+uT*.46)*A*1.+sin(w.x*.047+w.y*.07-uT*.74)*A*.5;
    w.x+=sin(w.y*.05+uT*.3)*1.8;
    vec4 F=texture2D(uField,w/uRes);
    float d=F.r*36.;
    /* waterlines: close against the land, opening with distance, as on a chart */
    float flow=vn(w*vec2(.03,.05)+vec2(uT*.24,-uT*.09));
    /* Two line systems, crossfaded by thickness and never by coordinate:
       waterlines echo the shore, level lines take over in open water. */
    float c2=pow(d+.6,.9)*.62*uDens;
    float c1=log(max(w.y,-120.)+150.)*178.*uDens;
    float m=smoothstep(15.,30.,d);
    float moonC=exp(-pow((p.x-uMoon.x)/(12.+p.y*.075),2.));
    float add=.09*exp(-d/3.2)+F.g*.11+gold*.14+foam*.2*(.45+.6*flow)+ringT*.3;
    float inkA=0.,inkB=0.,idB=floor(c1),moonT=0.;
    vec2 ww=w;
    if(m<.995){
      float id=floor(c2),rid=h1(id*.37+3.),dir=rid>.5?1.:-1.;
      float dash=vn(vec2((ww.x+ww.y*.6)*(.016+.016*rid)+uT*(.1+.2*rid)*dir*(1.+uWind*1.4),id*.77));
      float sw=smoothstep(.34,.76,dash);
      float pull=smoothstep(.14,.32,dash+flow*.2);
      float t=(.07+.03*flow)*pull+.2*sw*sw*(.3+.7*flow);
      t=t*(1.+uWind*.3+uStorm*.6)+add+F.g*.12*sw+gold*.1*sw;
      inkA=burin(c2,min(t,.46)*2.3*(1.-m));
    }
    if(m>.005){
      float id=idB,rid=h1(id*.37+3.),dir=rid>.5?1.:-1.;
      float dash=vn(vec2(ww.x*(.011+.013*rid)+uT*(.1+.2*rid)*dir*(1.+uWind*1.4),id*.77));
      float sw=smoothstep(.34,.76,dash);
      float pull=smoothstep(.14,.32,dash+flow*.2);
      float t=(.055+.03*flow)*pull+.17*sw*sw*(.3+.7*flow);
      t=t*(1.+uWind*.34+uStorm*.7);
      float brk=vn(vec2(p.x*.06+uT*.1,id*.61))*vn(vec2(p.x*.015-uT*.13,id*.31));
      moonT=moonC*(.02+1.15*brk*brk*2.2);
      t+=moonT+add+gold*.1*sw;
      inkB=burin(c1,min(t,.46)*3.3*m);
    }
    float ink=max(inkA,inkB)*lee;
    vec3 lc=mix(VER,VRL,clamp(flow*.5+foam,0.,1.));
    lc=mix(lc,VEL,clamp(moonT*1.2+F.g*.2,0.,.85));
    lc=mix(lc,GLD,clamp(gold*.95+ringT*1.4+F.g*.5,0.,1.));
    lc=mix(lc,vec3(.91,.32,.19),clamp(red*1.25,0.,1.));
    vec3 bg=LAG*mix(.7,.98,ny);
    col=mix(bg,lc,ink*.96);
    col=mix(col,VEL,rain*.34);
    gl_FragColor=vec4(col,1.);
  }`;

  function sh(gl, t, s) {
    const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
    return o;
  }
  V.water = {
    scale: 2, ok: false,
    init(cv) {
      this.cv = cv;
      const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
      if (!gl || !gl.getExtension('OES_standard_derivatives')) return false;
      this.gl = gl;
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr); this.pr = pr;
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      ['uRes', 'uFocus', 'uMoon', 'uT', 'uWind', 'uStorm', 'uVoice', 'uHold', 'uHorizon', 'uShock', 'uField', 'uDens'].forEach((n) => { this.u[n] = gl.getUniformLocation(pr, n); });
      this.u.hullA = gl.getUniformLocation(pr, 'uHullA'); this.u.hullB = gl.getUniformLocation(pr, 'uHullB'); this.u.ring = gl.getUniformLocation(pr, 'uRing');
      this.hA = new Float32Array(24); this.hB = new Float32Array(24); this.rg = new Float32Array(24);
      this.tex = gl.createTexture();
      this.ok = true; return true;
    },
    field(L, grid) {
      const gl = this.gl; if (!gl) return;
      this.L = L;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, grid.tw, grid.th, 0, gl.RGBA, gl.UNSIGNED_BYTE, grid.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.resize();
    },
    resize() {
      const L = this.L, gl = this.gl; if (!gl || !L) return;
      this.cv.width = Math.round(L.W * this.scale); this.cv.height = Math.round(L.H * this.scale);
      gl.viewport(0, 0, this.cv.width, this.cv.height);
    },
    render(s) {
      const gl = this.gl, u = this.u, L = this.L; if (!gl || !L) return;
      gl.uniform2f(u.uRes, L.W, L.H); gl.uniform3f(u.uMoon, L.moon[0], L.moon[1], L.moon[2]);
      gl.uniform1f(u.uT, s.t); gl.uniform1f(u.uWind, s.wind); gl.uniform1f(u.uStorm, s.storm);
      gl.uniform1f(u.uVoice, s.voice); gl.uniform1f(u.uHold, s.hold); gl.uniform1f(u.uHorizon, L.horizon); gl.uniform1f(u.uDens, this.scale < 1.4 ? .66 : 1); gl.uniform1f(u.uShock, s.shock);
      gl.uniform2f(u.uFocus, s.fx, s.fy); gl.uniform1i(u.uField, 0);
      gl.uniform4fv(u.hullA, this.hA); gl.uniform4fv(u.hullB, this.hB); gl.uniform4fv(u.ring, this.rg);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
})();
