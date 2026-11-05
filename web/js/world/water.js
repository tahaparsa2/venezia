// The one full-screen pass, and the page's only WebGL context. Sky and water are the same drawing:
// parallel engraved lines whose thickness carries all the light. Nothing glows. Hulls, rings and
// voice all act by warping the coordinates the lines are read at, with a potential-flow
// displacement, so lines part around a hull as streamlines do.

import { vec3 } from './ink.js';

export const WATER_HULLS = 10;
export const WATER_RINGS = 6;
export const WATER_LIGHTS = 6;

const VS = `attribute vec2 a; uniform vec2 uRes; varying vec2 vP;
void main(){ vP=vec2((a.x+1.)*.5*uRes.x,(1.-a.y)*.5*uRes.y); gl_Position=vec4(a,0.,1.); }`;

const fragment = (inks) => `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vP;
uniform vec2 uRes, uFocus;
uniform vec3 uMoon,uSun;
uniform float uT,uWind,uStorm,uVoice,uHold,uHorizon,uShock,uDens,uDay,uPhase,uMoonUp,uHush;
uniform vec4 uHullA[${WATER_HULLS}];
uniform vec4 uHullB[${WATER_HULLS}];
uniform vec4 uRing[${WATER_RINGS}];
uniform vec3 uLight[${WATER_LIGHTS}];
uniform sampler2D uField;
const vec3 LAG=${vec3(inks.lagoon)};
const vec3 VER=${vec3(inks.verdigris)};
const vec3 VRL=${vec3(inks.verdigrisLight)};
const vec3 GLD=${vec3(inks.gold)};
const vec3 VEL=${vec3(inks.vellum)};
const vec3 RED=${vec3(inks.vermilionGlow)};
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
    /* Rain is ruled lines too, driven hard across the plate. */
    float rc=(p.x+p.y*(.42+.34*uStorm)+uT*(90.+150.*uStorm))/(9.-3.5*uStorm); float rid=floor(rc);
    float rd=vn(vec2(rid*.73,p.y*.018-uT*(5.5+6.*uStorm)));
    rain=line(rc,.05+.07*uStorm)*smoothstep(.62-.3*uStorm,.82,rd)*uStorm;
  }
  if(p.y<uHorizon){
    /* sky */
    vec2 w=p; w.y+=sin(p.x*.011+uT*.09)*1.1;
    float c=w.y/2.5, id=floor(c);
    float md=distance(p,uMoon.xy), mr=uMoon.z;
    float speed=1.+uStorm*7.;
    float cl=vn(p*vec2(.0075,.024)+vec2(uT*(.012+uWind*.05)*speed,3.))*.65+vn(p*vec2(.02,.06)+vec2(uT*(.02+uWind*.08)*speed,9.))*.35;
    float cloud=smoothstep(.5-.3*uStorm-.08*uWind,.74-.08*uStorm,cl);
    float veil=1.-.86*uStorm;                     /* a storm puts the moon out */
    /* The real phase: how much of the disc is lit, and which way it faces. */
    float ang=uPhase*6.2832;
    vec3 sun=normalize(vec3(sin(ang),-.12,-cos(ang)));
    float fullness=.5*(1.+sun.z);
    float halo=exp(-md/(mr*3.4))*uMoonUp*veil*(.3+.7*fullness);
    /* Day is more line, not another colour: a pale plate, the same burin. */
    float sd=distance(p,uSun.xy), sr=uSun.z*1.25, dayUp=uDay*veil;
    float glow=exp(-sd/(sr*6.5))*dayUp;
    float tone=.055+.34*halo+cloud*(.16+.2*exp(-md/(mr*7.))*uMoonUp*veil)+uShock*.26+uDay*.2+glow*.2;
    float st=vn(vec2(p.x*.008-uT*(.5+uWind*2.6),id*.91));
    tone+=(.1+.24*uStorm)*uWind*smoothstep(.62,.9,st);
    tone*=.75+.5*vn(vec2(p.x*.05,id*1.3));
    /* Storm light is hard: cloud rims stand out of black, with nothing between. */
    tone*=mix(1.,.28+1.9*smoothstep(.4,.82,cl),uStorm);
    float ink=line(c,min(.46,tone));
    vec3 lc=mix(VER,VEL,clamp(halo*1.4+cloud*.45+uDay*.62,0.,1.));
    col=mix(LAG*(.86-.34*uStorm+uDay*.75),lc,ink*.92);
    /* stars, only where the moon leaves the sky dark */
    float dark=(1.-uDay)*(1.-.8*uMoonUp)*(1.-uStorm)*(1.-cloud);
    if(dark>.02){vec2 g=floor(p/7.);float s=h1(g.x*1.3+g.y*57.1);
      if(s>.965){vec2 f=fract(p/7.)-.5;col=mix(col,VEL,dark*.8*(1.-smoothstep(.04,.16,length(f))));}}
    if(dayUp>.02){
      /* The sun of an old chart: ruled rings, and rays that come and go. Vellum, never gold. */
      vec2 q=p-uSun.xy; float an=atan(q.y,q.x);
      float ray=smoothstep(.1,.9,sin(an*18.))*smoothstep(sr*1.22,sr*1.34,sd)*(1.-smoothstep(sr*1.5,sr*(2.1+.9*sin(an*9.+1.)*.5),sd));
      float rim=1.-smoothstep(.5,1.3,abs(sd-sr));
      float disc=(1.-smoothstep(sr-.5,sr+.5,sd))*line(sd/2.1,.2+.26*(1.-sd/sr));
      col=mix(col,VEL,clamp(ray*.8+rim*.9+disc*.9,0.,1.)*dayUp);
    }
    if(md<mr&&uMoonUp>.01){
      /* the moon: cross-cut, with its real phase */
      vec2 m=(p-uMoon.xy)/mr; float z=sqrt(max(0.,1.-dot(m,m)));
      float lit=clamp(dot(vec3(m,z),sun)*1.5+.08,0.,1.);
      float cr=vn(m*4.3+2.)*.5+vn(m*9.)*.5;
      float t1=.03+.42*lit*(.72+.45*cr);
      float a=line((p.x*.62+p.y*.79)/1.9,t1), b=line((p.x*.62-p.y*.79)/1.9,t1*.82);
      /* The unlit part keeps the sky's own lines, only darker, so a thin moon is a thin moon. */
      float shown=smoothstep(.03,.2,lit);
      col=mix(col*.8,mix(LAG*.7,VEL,clamp(a+b*lit,0.,1.)),shown*(veil*.4+.6*(1.-uStorm)));
    }
    if(uMoonUp>.01){
      float rimd=abs(md-mr);
      vec2 toward=normalize(sun.xy+vec2(.0001));
      float limb=clamp(fullness*1.5+dot((p-uMoon.xy)/max(md,.001),toward)*.9+.1,0.,1.);
      col=mix(col,VEL,(1.-smoothstep(.2,1.1,rimd))*.8*uMoonUp*veil*limb);
    }
    col=mix(col,VEL,rain*.5+uShock*.05);
    gl_FragColor=vec4(col,1.); return;
  }
  /* water */
  vec2 w=p; float gold=0.,red=0.,foam=0.,lee=1.;
  for(int i=0;i<${WATER_HULLS};i++){
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
  /* w>0 is a gold ring, a real publish or a receipt. w<0 is plain water, and may never be gold. */
  float ringT=0.,ringG=0.;
  for(int i=0;i<${WATER_RINGS};i++){
    vec4 R=uRing[i];
    if(R.w==0.) continue;
    float k=abs(R.w);
    vec2 q=p-R.xy; float r=length(q*vec2(1.,1.85));
    float b=exp(-pow((r-R.z)/(9.+R.z*.014),2.));
    w+=normalize(q+.001)*sin((r-R.z)*.42)*b*13.*k;
    ringT+=b*k;
    if(R.w>0.) ringG+=b*k;
  }
  float lamp=0.;
  for(int i=0;i<${WATER_LIGHTS};i++){
    vec3 Q=uLight[i];
    if(Q.z<=0.) continue;
    vec2 q=(p-Q.xy)*vec2(.75,1.);
    if(q.y<0.) continue;
    lamp+=Q.z*exp(-dot(q,q)/1500.);
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
  float A=1.+uWind*1.5+uStorm*3.2;
  /* Storm swell: long ridges that travel, on top of the ordinary chop. */
  float swell=sin(w.x*.021+w.y*.052-uT*1.7);
  w.y+=swell*uStorm*7.5;
  w.x+=sin(w.y*.04+uT*1.1)*uStorm*5.;
  w.y+=sin(w.x*.017+w.y*.03+uT*.46)*A*1.+sin(w.x*.047+w.y*.07-uT*.74)*A*.5;
  w.x+=sin(w.y*.05+uT*.3)*1.8;
  vec4 F=texture2D(uField,w/uRes);
  float d=F.r*36.;
  /* waterlines: close against the land, opening with distance, as on a chart */
  float flow=vn(w*vec2(.03,.05)+vec2(uT*.24,-uT*.09));
  float crest=uStorm*smoothstep(.55,.98,swell)*smoothstep(.3,.7,flow+.2);
  foam+=crest*.9;
  /* Two line systems, crossfaded by thickness and never by coordinate:
     waterlines echo the shore, level lines take over in open water. */
  float c2=pow(d+.6,.9)*.62*uDens;
  float c1=log(max(w.y,-120.)+150.)*178.*uDens;
  float m=smoothstep(15.,30.,d);
  /* The bright road on the water belongs to whichever light is up. */
  float lightX=mix(uMoon.x,uSun.x,uDay);
  float moonC=exp(-pow((p.x-lightX)/(12.+p.y*.075),2.))*max(uMoonUp,uDay*.8)*(1.-uStorm);
  float add=.09*exp(-d/3.2)+F.g*.11+gold*.14+foam*.2*(.45+.6*flow)+ringT*.36+lamp*.22;
  float inkA=0.,inkB=0.,idB=floor(c1),moonT=0.;
  vec2 ww=w;
  if(m<.995){
    float id=floor(c2),rid=h1(id*.37+3.),dir=rid>.5?1.:-1.;
    float dash=vn(vec2((ww.x+ww.y*.6)*(.016+.016*rid)+uT*(.1+.2*rid)*dir*(1.+uWind*1.4+uStorm*2.),id*.77));
    float sw=smoothstep(.34,.76,dash);
    float pull=smoothstep(.14,.32,dash+flow*.2);
    float t=(.07+.03*flow)*pull+.2*sw*sw*(.3+.7*flow);
    t=t*(1.+uWind*.3+uStorm*.8)+add+F.g*.12*sw+gold*.1*sw;
    inkA=burin(c2,min(t,.46)*2.3*(1.-m));
  }
  if(m>.005){
    float id=idB,rid=h1(id*.37+3.),dir=rid>.5?1.:-1.;
    float dash=vn(vec2(ww.x*(.011+.013*rid)+uT*(.1+.2*rid)*dir*(1.+uWind*1.4+uStorm*2.),id*.77));
    float sw=smoothstep(.34,.76,dash);
    float pull=smoothstep(.14,.32,dash+flow*.2);
    float t=(.055+.03*flow)*pull+.17*sw*sw*(.3+.7*flow);
    t=t*(1.+uWind*.34+uStorm*.9);
    float brk=vn(vec2(p.x*.06+uT*.1,id*.61))*vn(vec2(p.x*.015-uT*.13,id*.31));
    moonT=moonC*(.02+1.15*brk*brk*2.2);
    t+=moonT+add+gold*.1*sw;
    inkB=burin(c1,min(t,.46)*3.3*m);
  }
  float ink=max(inkA,inkB)*lee;
  vec3 lc=mix(VER,VRL,clamp(flow*.5+foam,0.,1.));
  lc=mix(lc,VEL,clamp(moonT*1.2+F.g*.3+lamp*.5+crest*.9,0.,.9));
  lc=mix(lc,VEL,clamp((ringT-ringG)*1.2,0.,.8));
  lc=mix(lc,GLD,clamp(gold*.95+ringG*1.6,0.,1.));
  lc=mix(lc,RED,clamp(red*1.25,0.,1.));
  lc=mix(lc,VEL,uDay*.3*(1.-uStorm));
  vec3 bg=LAG*mix(.7,.98,ny)*(1.-.42*uStorm)*(1.+uDay*.62*(1.-uStorm*.8));
  col=mix(bg,lc,ink*.96*(1.-uHush*.74));
  col=mix(col,VEL,rain*.42+uShock*.1);
  gl_FragColor=vec4(col,1.);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

/** With no WebGL the water is still engraved, just not moving. */
function paintStill(canvas, L, inks) {
  canvas.width = L.W;
  canvas.height = L.H;
  const c = canvas.getContext('2d');
  c.fillStyle = inks.lagoon;
  c.fillRect(0, 0, L.W, L.H);
  c.strokeStyle = inks.verdigris;
  c.lineWidth = 0.6;
  c.globalAlpha = 0.7;
  c.beginPath();
  for (let y = L.horizon; y < L.H; y += 3.4 + (y - L.horizon) * 0.006) {
    c.moveTo(0, y);
    c.lineTo(L.W, y);
  }
  c.stroke();
}

export function createWater(canvas, inks) {
  const hullA = new Float32Array(WATER_HULLS * 4);
  const hullB = new Float32Array(WATER_HULLS * 4);
  const rings = new Float32Array(WATER_RINGS * 4);
  const lights = new Float32Array(WATER_LIGHTS * 3);
  let gl = null;
  let u = {};
  let texture = null;
  let chart = null;
  let grid = null;
  let lost = false;

  function program() {
    const pr = gl.createProgram();
    gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, fragment(inks)));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(pr, 'a');
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    u = {};
    for (const name of ['uRes', 'uFocus', 'uMoon', 'uSun', 'uT', 'uWind', 'uStorm', 'uVoice', 'uHold', 'uHorizon', 'uShock', 'uField', 'uDens', 'uDay', 'uPhase', 'uMoonUp', 'uHush', 'uHullA', 'uHullB', 'uRing', 'uLight']) {
      u[name] = gl.getUniformLocation(pr, name);
    }
    texture = gl.createTexture();
  }

  function upload() {
    if (!gl || !grid) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, grid.tw, grid.th, 0, gl.RGBA, gl.UNSIGNED_BYTE, grid.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function start() {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'default', preserveDrawingBuffer: false });
    if (!gl || !gl.getExtension('OES_standard_derivatives')) {
      gl = null;
      return false;
    }
    program();
    return true;
  }

  const onLost = (event) => {
    event.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    gl.getExtension('OES_standard_derivatives');
    program();
    upload();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const api = {
    scale: 2,
    quality: 2,
    hullA,
    hullB,
    rings,
    lights,
    ok: start(),
    field(L, field) {
      chart = L;
      grid = field;
      if (!gl) {
        paintStill(canvas, L, inks);
        return;
      }
      upload();
      api.resize();
    },
    resize() {
      if (!gl || !chart) return;
      canvas.width = Math.round(chart.W * api.scale);
      canvas.height = Math.round(chart.H * api.scale);
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    render(s) {
      if (!gl || !chart || lost) return;
      const L = chart;
      gl.uniform2f(u.uRes, L.W, L.H);
      gl.uniform3f(u.uMoon, s.moon[0], s.moon[1], s.moon[2]);
      gl.uniform3f(u.uSun, s.sun[0], s.sun[1], s.sun[2]);
      gl.uniform1f(u.uT, s.t);
      gl.uniform1f(u.uWind, s.wind);
      gl.uniform1f(u.uStorm, s.storm);
      gl.uniform1f(u.uVoice, s.voice);
      gl.uniform1f(u.uHold, s.hold);
      gl.uniform1f(u.uHorizon, L.horizon);
      gl.uniform1f(u.uDens, api.scale < 1.4 ? 0.66 : 1);
      gl.uniform1f(u.uShock, s.shock);
      gl.uniform1f(u.uDay, s.day);
      gl.uniform1f(u.uPhase, s.phase);
      gl.uniform1f(u.uMoonUp, s.moonUp);
      gl.uniform1f(u.uHush, s.hush);
      gl.uniform2f(u.uFocus, s.fx, s.fy);
      gl.uniform1i(u.uField, 0);
      gl.uniform4fv(u.uHullA, hullA);
      gl.uniform4fv(u.uHullB, hullB);
      gl.uniform4fv(u.uRing, rings);
      gl.uniform3fv(u.uLight, lights);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
    },
  };
  return api;
}
