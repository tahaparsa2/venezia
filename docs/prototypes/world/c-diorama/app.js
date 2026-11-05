/* Venezia, direction C: state, deck, sound. All data here is fake but shaped like the spec's events. */
(function(){
'use strict';
const $=(s)=>document.querySelector(s);
const W=window.VZWorld;
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
const LAMP={idle:'#f4efe2',work:'#58a9ff',done:'#49d68f',need:'#ffb12e',fail:'#ff4630'};

/* ---------- generated surfaces: bead blast and paper fibre ---------- */
(function(){
  const mk=(n,fn)=>{const c=document.createElement('canvas');c.width=c.height=n;const x=c.getContext('2d'),d=x.createImageData(n,n);fn(d.data,n);x.putImageData(d,0,0);return c.toDataURL('image/png');};
  document.documentElement.style.setProperty('--grain','url('+mk(128,(a)=>{for(let i=0;i<a.length;i+=4){const v=112+Math.random()*44;a[i]=a[i+1]=a[i+2]=v;a[i+3]=255;}})+')');
  document.documentElement.style.setProperty('--paper','url('+mk(160,(a,n)=>{for(let y=0;y<n;y++)for(let x=0;x<n;x++){const i=(y*n+x)*4,v=232+Math.random()*23-(Math.sin(y*.9+Math.sin(x*.07)*3)>.92?10:0);a[i]=v;a[i+1]=v*.98;a[i+2]=v*.94;a[i+3]=255;}})+')');
})();

/* ---------- the fleet ---------- */
const hulls=[
 {id:'lido',name:'Lido',kind:'gondola',z:-24,x:-1.1,station:0,progress:1,state:'idle',lamp:'idle',yaw:.1,
  note:'Waiting at the mouth',plain:'A small sketch, not started yet.',lede:'A tiny idea in the lion’s mouth. No contract needed for a sketch this small.',
  facts:[['Type','Gondola, sketch'],['Worker','None yet'],['Next','Begin when you say'],['Spent','0 ducats']]},
 {id:'burano',name:'Burano',kind:'galley',z:-14,station:1,progress:.14,state:'fog',lamp:'need',
  note:'3 open questions',plain:'Fog: 3 questions need your answer.',lede:'The contract cannot be written yet. Burano is waiting on three answers from you and spends nothing while it waits.',
  facts:[['Type','Galley, build'],['Worker','Planner, paused'],['Ask','Which database? Login needed? Who pays?'],['Spent','11 ducats']]},
 {id:'torcello',name:'Torcello',kind:'galleass',z:-8.2,station:2,progress:.56,state:'build',lamp:'work',tow:true,
  note:'Building 9 of 16',plain:'Building: work item 9 of 16.',lede:'Windows are handing over one work item at a time. Masts are on, oars are going in.',
  facts:[['Type','Galleass, platform'],['Workers','3 builders, turn 41 of 90'],['Now','payments/webhook.ts'],['Spent','128 ducats']]},
 {id:'murano',name:'Murano',kind:'galley',z:4.6,station:3,progress:.88,state:'leak',lamp:'fail',
  note:'Gate failed, 2 of 31',plain:'Leak: gate failed, 2 of 31 checks.',lede:'The bar is down. Two browser checks failed, so the Repairer is working on them with fresh context.',
  facts:[['Type','Galley, build'],['Worker','Repairer, attempt 2 of 3'],['Failing','login.spec:44, cart.spec:12'],['Spent','96 ducats']]},
 {id:'aurora',name:'Aurora',kind:'galley',z:14.6,x:-1.4,station:4,progress:1,state:'gilded',lamp:'need',
  note:'Verified, waiting on you',plain:'Verified. Waiting for your decision.',lede:'Every check passed on this exact build. Aurora will not leave the basin until you hold the ring.',
  facts:[['Type','Galley, build'],['Receipt','bollo 7f3a…c19e, 31 of 31'],['Target','GitHub Pages, public'],['Spent','74 ducats']]},
 {id:'giudecca',name:'Giudecca',kind:'galley',z:21.6,x:4.2,station:5,progress:1,state:'done',lamp:'done',yaw:.03,
  note:'Chronicle ready',plain:'Finished. Chronicle unread.',lede:'Back from the public web. The chronicle is written and two new lessons are waiting to be read.',
  facts:[['Type','Galley, build'],['Live at','giudecca.github.io'],['Lessons','2 proposed, 0 confirmed'],['Spent','52 ducats']]},
];
const byId=(id)=>hulls.find(h=>h.id===id);
let plain=false, selected=null, effort=1;
const EFFORT=['Low','Medium','High','Max'];
let ducats=412, renown=1240, used=.63;
const decision={open:false,state:'none'};

/* ---------- sound: a small synthesiser, nothing sampled ---------- */
const S={ctx:null,on:true,noise:null,
  init(){ if(this.ctx||!this.on)return; const AC=window.AudioContext||window.webkitAudioContext; if(!AC)return; const c=this.ctx=new AC();
    this.master=c.createDynamicsCompressor();const g=c.createGain();g.gain.value=.9;this.master.connect(g);g.connect(c.destination);this.out=g;
    const b=c.createBuffer(1,c.sampleRate*2,c.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;this.noise=b;
    /* water lapping, very low */
    const n=c.createBufferSource();n.buffer=b;n.loop=true;const lp=c.createBiquadFilter();lp.type='lowpass';lp.frequency.value=420;const a=c.createGain();a.gain.value=.018;
    const lfo=c.createOscillator();lfo.frequency.value=.13;const lg=c.createGain();lg.gain.value=.012;lfo.connect(lg);lg.connect(a.gain);lfo.start();
    n.connect(lp);lp.connect(a);a.connect(this.master);n.start();this.amb=a;
  },
  burst(dur,freq,q,gain,type,when){const c=this.ctx;if(!c||!this.on)return;const t=(when||c.currentTime),n=c.createBufferSource();n.buffer=this.noise;n.loop=true;const f=c.createBiquadFilter();f.type=type||'bandpass';f.frequency.value=freq;f.Q.value=q;const g=c.createGain();g.gain.setValueAtTime(gain,t);g.gain.exponentialRampToValueAtTime(.0001,t+dur);n.connect(f);f.connect(g);g.connect(this.master);n.start(t,Math.random());n.stop(t+dur+.02);},
  tone(freq,dur,gain,type,when,glide){const c=this.ctx;if(!c||!this.on)return;const t=(when||c.currentTime),o=c.createOscillator();o.type=type||'sine';o.frequency.setValueAtTime(freq,t);if(glide)o.frequency.exponentialRampToValueAtTime(glide,t+dur);const g=c.createGain();g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(gain,t+.004);g.gain.exponentialRampToValueAtTime(.0001,t+dur);o.connect(g);g.connect(this.master);o.start(t);o.stop(t+dur+.02);},
  down(p){this.burst(.022,2600*(p||1),.9,.26);this.burst(.05,520,.8,.2,'lowpass');this.tone(150*(p||1),.05,.2,'sine');},
  up(p){this.burst(.018,3600*(p||1),1.1,.13);this.tone(240*(p||1),.03,.06,'sine');},
  tick(){this.burst(.012,3100,3,.16);this.tone(1200,.012,.03,'square');},
  ratchet(n){const c=this.ctx;if(!c||!this.on)return;for(let i=0;i<n;i++){const t=c.currentTime+i*.077;this.burst(.02,1700+Math.random()*500,2.5,.11,'bandpass',t);}},
  yes(){const c=this.ctx;if(!c)return;this.tone(622,.16,.09,'triangle');this.tone(932,.24,.08,'triangle',c.currentTime+.09);},
  no(){const c=this.ctx;if(!c)return;this.tone(196,.22,.16,'triangle',0,130);},
  /* the Marangona: inharmonic partials, a hum note under the strike */
  bell(f,g){const c=this.ctx;if(!c||!this.on)return;f=f||220;g=g||.26;const ps=[[.5,1,7],[1,.8,5.2],[1.19,.55,3.6],[1.5,.42,3],[2,.5,2.4],[2.51,.25,1.8],[2.98,.18,1.4],[4.07,.1,.8]];ps.forEach(p=>this.tone(f*p[0],p[2],g*p[1]*.5,'sine'));this.burst(.05,2600,.6,.22);},
  droneStart(){const c=this.ctx;if(!c||!this.on||this.dr)return;const g=c.createGain();g.gain.value=.0001;const lp=c.createBiquadFilter();lp.type='lowpass';lp.frequency.value=180;lp.Q.value=3;
    const os=[73.4,110,146.8,110.5].map((f,i)=>{const o=c.createOscillator();o.type=i%2?'sawtooth':'triangle';o.frequency.value=f;o.connect(lp);o.start();return o;});lp.connect(g);g.connect(this.master);g.gain.exponentialRampToValueAtTime(.12,c.currentTime+.3);this.dr={g,lp,os};},
  drone(p){if(!this.dr)return;const c=this.ctx;this.dr.lp.frequency.setTargetAtTime(180+p*p*1500,c.currentTime,.05);this.dr.g.gain.setTargetAtTime(.1+p*.14,c.currentTime,.05);this.dr.os.forEach((o,i)=>o.detune.setTargetAtTime(p*(i-1.5)*6,c.currentTime,.1));},
  droneStop(q){if(!this.dr)return;const c=this.ctx,d=this.dr;this.dr=null;d.g.gain.setTargetAtTime(.0001,c.currentTime,q||.08);setTimeout(()=>d.os.forEach(o=>o.stop()),900);},
  splash(){const c=this.ctx;if(!c||!this.on)return;this.tone(60,.5,.5,'sine',0,30);this.burst(1.3,1400,.4,.5,'lowpass');for(let i=0;i<14;i++)this.burst(.12+Math.random()*.2,1800+Math.random()*3400,4,.05+Math.random()*.05,'bandpass',c.currentTime+.1+Math.random()*1.1);},
};
const haptic=(p)=>{try{if(S.ctx&&navigator.vibrate&&navigator.userActivation&&navigator.userActivation.hasBeenActive)navigator.vibrate(p);}catch(e){}};

/* ---------- labels pinned in the model ---------- */
const labels=$('#labels');
const STN=W.stations||[];
const staEls=[],tagEls={};
STN.forEach((s)=>{const e=document.createElement('div');e.className='sta';e.textContent=s.fiction;labels.appendChild(e);staEls.push(e);});
hulls.forEach(h=>{const e=document.createElement('div');e.className='tag';e.innerHTML='<span class="pin"></span><span class="lead"></span><span class="flag"><b></b><i></i></span>';labels.appendChild(e);tagEls[h.id]=e;});
function tagText(h){const e=tagEls[h.id];e._fw=0;e.querySelector('b').textContent=h.name;e.querySelector('i').textContent=h.note;e.style.setProperty('--c',LAMP[h.lamp]);e.classList.toggle('sel',selected===h.id);e.classList.toggle('attn',h.lamp==='fail'||h.state==='fog');}

/* ---------- lamps ---------- */
const SYM={idle:'<circle cx="7" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',work:'<path d="M2 7h7M7 3.5 11 7 7 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',done:'<path d="M2.5 7.3 5.7 10.4 11.5 3.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',need:'<path d="M7 2v6.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="7" cy="11.4" r="1.25" fill="currentColor"/>',fail:'<path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'};
const lampWord={idle:'idle',work:'working',done:'finished, unread',need:'needs you',fail:'failed'};
const lamps=$('#lamps');const lampEls={};
const order=['aurora','torcello','murano','burano','giudecca','lido'];
order.forEach((id,i)=>{const h=byId(id),b=document.createElement('button');b.className='lamp';b.dataset.id=id;
  b.innerHTML='<span class="glass"><span class="sym"><svg viewBox="0 0 14 14" width="14" height="14"></svg></span></span><span class="nm"></span>';lamps.appendChild(b);lampEls[id]=b;
  press(b,()=>{S.down(1.2);},()=>{S.up(1.2);choose(id);});});
function paintLamp(h){const b=lampEls[h.id];b.dataset.s=h.lamp;b.querySelector('.nm').textContent=h.name;b.querySelector('svg').innerHTML=SYM[h.lamp];b.classList.toggle('sel',selected===h.id);b.setAttribute('aria-label',h.name+', '+lampWord[h.lamp]);b.setAttribute('aria-pressed',selected===h.id);}
function setLamp(id,s){const h=byId(id);h.lamp=s;paintLamp(h);tagText(h);}

/* A pointer press that always pairs down and up, with a little visible key travel */
function press(el,onDown,onUp,onCancel){let active=false;
  el.addEventListener('pointerdown',e=>{e.preventDefault();S.init();resume();active=true;el.classList.add('down');try{el.setPointerCapture(e.pointerId);}catch(_){ }onDown&&onDown(e);});
  const end=(e)=>{if(!active)return;active=false;resume();el.classList.remove('down');(e.type==='pointerup'?onUp:(onCancel||onUp))&&(e.type==='pointerup'?onUp:(onCancel||onUp))(e);};
  el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);el.addEventListener('lostpointercapture',end);
  el.addEventListener('click',e=>{if(e.detail===0){onDown&&onDown(e);onUp&&onUp(e);}}); /* keyboard activation */
}
function resume(){if(S.ctx&&S.ctx.state==='suspended')S.ctx.resume();}

/* ---------- tape, feed, folio ---------- */
const tapeText=$('#tapeText');
function tape(t){tapeText.textContent=t;tapeText.style.animation='none';void tapeText.offsetWidth;
  const over=tapeText.scrollWidth-tapeText.parentNode.clientWidth+16;
  if(over>0&&!REDUCED){tapeText.style.setProperty('--over',-over+'px');tapeText.style.animation='tapeRun '+Math.max(3,over/26)+'s 1.4s steps('+Math.ceil(over/3)+',end) forwards';}}
const feedList=$('#feedList');
let clock=9*60+41;
const stamp=()=>{const h=Math.floor(clock/60),m=clock%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');};
function feed(html,color,toTape){const li=document.createElement('li');li.style.setProperty('--c',color||'#777');li.style.setProperty('--r',Math.random()*30-15);li.innerHTML='<time>'+stamp()+'</time>'+html;feedList.prepend(li);while(feedList.children.length>26)feedList.lastChild.remove();if(toTape!==false)tape(html.replace(/<[^>]+>/g,''));}
function detail(){
  const h=byId(selected)||byId('aurora');const d=$('#detail');const c=LAMP[h.lamp];
  d.innerHTML='<h2>'+h.name+'</h2><div class="sub">'+h.plain+'</div><p class="lede">'+h.lede+'</p><ul class="line" style="--c:'+c+'">'+STN.map((s,i)=>'<li class="'+(i<h.station?'past':i===h.station?'now':'')+'">'+(plain?s.plain:s.fiction)+'</li>').join('')+'</ul><dl>'+h.facts.map(f=>'<dt>'+f[0]+'</dt><dd>'+f[1]+'</dd>').join('')+'</dl>';
}
function choose(id){
  selected=selected===id?null:id;
  W.select(selected);hulls.forEach(paintLamp);hulls.forEach(tagText);detail();
  if(selected){const h=byId(selected);tape(h.name+': '+h.plain);
    /* green is a to-do: it clears when you look */
    if(h.lamp==='done'){setTimeout(()=>{if(selected===id){setLamp(id,'idle');h.note='Read';tagText(h);}},1400);}
    if(id==='aurora'&&decision.state==='kept')offerDecision();
  }
}
W.onTap=(id)=>{if(id){S.init();resume();S.tick();choose(id);}else if(selected){choose(selected);}};

/* ---------- decision card ---------- */
const card=$('#card');const dial=$('#dial');
function layoutInsets(){
  const wide=innerWidth>=1000&&innerWidth/innerHeight>=1.25;
  const deckH=$('#deck').offsetHeight,hudH=72;
  if(wide){W.setInsets({l:300,r:30,t:30,b:0});}
  else if(innerHeight<500){W.setInsets({l:0,r:$('#deck').offsetWidth+14,t:40,b:4});}
  else{const c=card.classList.contains('in')?Math.max(0,card.offsetHeight-26):0;W.setInsets({l:-6,r:-6,t:hudH,b:deckH+c+6});}
}
function offerDecision(){
  decision.open=true;decision.state='open';setCardCopy('open');
  card.classList.add('in');document.body.classList.add('has-card');dial.classList.add('ask');S.ratchet(11);haptic([8,40,8]);
  setLamp('aurora','need');feed('<em>Aurora</em> asked to publish. Public, 14 files.','#ffb12e');
  S.bell(330,.1);
  if(selected!=='aurora')choose('aurora');layoutInsets();detail();
}
function setCardCopy(k){
  $('#replay').hidden=true;card.classList.remove('done','holding');$('#cardStamp').textContent='Verified';
  $('#cardTitle').textContent='Aurora wants to publish to GitHub Pages.';$('#cardBody').textContent='14 files, public link. Gate passed.';
  $('#cardHint').textContent='Hold the ring for 2 seconds. Reject keeps it private.';
  if(k==='hold'){card.classList.add('holding');$('#cardHint').textContent='Keep holding. Let go now and nothing is published.';}
  if(k==='armed'){card.classList.add('holding');$('#cardHint').textContent='Ready. Let go of the ring to publish.';}
  if(k==='published'){card.classList.add('done');$('#cardStamp').textContent='Live';$('#cardTitle').textContent='Aurora is on the public web.';$('#cardBody').textContent='aurora.venezia-sites.github.io, 14 files. One gold tessera set.';$('#cardHint').textContent='Rolls back on its own if the live check fails.';$('#replay').hidden=false;}
  layoutInsets();
}
function closeCard(){card.classList.remove('in');document.body.classList.remove('has-card');dial.classList.remove('ask');S.ratchet(7);layoutInsets();}
$('#replay').addEventListener('click',()=>{S.init();S.tick();const h=byId('aurora');Object.assign(h,{station:4,state:'gilded',note:'Verified, waiting on you',lamp:'need',tz:14.6,z:h.z});W.ring('reset');W.hull('aurora').tz=14.6;W.hull('aurora').state='gilded';W._buc.visible=false;closeCard();paintLamp(h);tagText(h);setTimeout(offerDecision,1100);});

function nudgeCard(msg){card.classList.remove('nudge');void card.offsetWidth;card.classList.add('nudge');$('#cardHint').textContent=msg;dial.classList.remove('ask');void dial.offsetWidth;dial.classList.add('ask');}

/* ---------- Approve / Reject ---------- */
const approve=$('#approve'),reject=$('#reject');
press(approve,()=>S.down(1),()=>{S.up(1);S.yes();haptic(10);
  if(decision.open)nudgeCard('Publishing is public, so Approve is not enough. Hold the ring for 2 seconds.');
  else tape('Nothing is waiting for approval.');});
press(reject,()=>S.down(.8),()=>{S.up(.8);S.no();haptic(16);
  if(decision.open){decision.open=false;decision.state='kept';closeCard();const h=byId('aurora');h.note='Kept private';h.lamp='idle';paintLamp(h);tagText(h);feed('You rejected the publish. <em>Aurora</em> stays private. Tap its lamp to ask again.','#ff4630');detail();}
  else tape('Nothing is waiting for a decision.');});

/* ---------- the ring, and the dial around it ---------- */
const arc=$('#ringArc'),ringLabel=$('#ringLabel');
let ring={holding:false,t0:0,armed:false,p:0};
function setArc(p){arc.style.strokeDasharray=(p*100)+' 100';arc.style.opacity=p>0?1:0;}
function ringDown(){
  if(!decision.open){S.tick();tape('The ring is cold. Nothing is waiting to publish.');return;}
  document.body.classList.add('ceremony');
  ring={holding:true,t0:performance.now(),armed:false,p:0};dial.classList.add('hold');dial.classList.remove('ask');S.droneStart();setCardCopy('hold');haptic(12);W.ring('hold',0);ringLabel.textContent='2.0';
}
function ringUp(){
  if(!ring.holding)return;ring.holding=false;dial.classList.remove('hold','armed');S.droneStop(ring.armed?.04:.12);
  if(ring.armed)publish();
  else{document.body.classList.remove('ceremony');W.ring('cancel');setArc(0);setCardCopy('open');dial.classList.add('ask');ringLabel.textContent='Ring';tape('Let go early. Nothing was published.');S.no();}
}
function publish(){
  decision.open=false;decision.state='sent';W.ring('drop');card.classList.remove('holding');ringLabel.textContent='Ring';$('#cardHint').textContent='Publishing…';feed('You held the ring. <em>Aurora</em> is publishing.','#d9a93a');
  dial.classList.remove('ask');
}
W._onSplash=()=>{
  S.splash();S.bell(196,.3);setTimeout(()=>S.bell(246.9,.2),900);haptic([30,60,120]);setArc(0);
  const dk=$('#deck');dk.classList.remove('sweep');void dk.offsetWidth;dk.classList.add('sweep');
  setTimeout(()=>{document.body.classList.remove('ceremony');const h=byId('aurora');h.station=5;h.note='Live, checked';h.state='gilded';W.hull('aurora').tz=20.5;setLamp('aurora','done');setCardCopy('published');
    feed('Live check passed. <em>Aurora</em> is public.','#d9a93a');addRenown(120);flyTile();detail();},1500);
};
press(dial,(e)=>{
  S.init();
  const r=dial.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;const px=e.clientX??cx,py=e.clientY??cy;
  const d=Math.hypot(px-cx,py-cy);
  if(d<34){dial._mode='ring';ringDown();}
  else{dial._mode='turn';dial._a=Math.atan2(py-cy,px-cx);dial._acc=0;}
},()=>{if(dial._mode==='ring')ringUp();dial._mode=null;},()=>{if(dial._mode==='ring')ringUp();dial._mode=null;});
dial.addEventListener('pointermove',e=>{if(dial._mode!=='turn')return;const r=dial.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;const a=Math.atan2(e.clientY-cy,e.clientX-cx);let da=a-dial._a;if(da>Math.PI)da-=6.283;if(da<-Math.PI)da+=6.283;dial._a=a;turn(da);});
dial.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowUp'){e.preventDefault();S.init();turn(.25);}if(e.key==='ArrowLeft'||e.key==='ArrowDown'){e.preventDefault();S.init();turn(-.25);}});
dial.addEventListener('wheel',e=>{e.preventDefault();S.init();turn((e.deltaY>0?1:-1)*.2);},{passive:false});
let dialAngle=-46,acc=0;
function turn(rad){const deg=rad*57.3;dialAngle=Math.max(-138,Math.min(138,dialAngle+deg));dial.style.setProperty('--a',dialAngle+'deg');acc+=deg;if(Math.abs(acc)>6){S.tick();haptic(2);acc=0;}
  const e=Math.round((dialAngle+138)/276*3);if(e!==effort){effort=e;dial.setAttribute('aria-valuenow',e);paintScale();const t=byId(selected)||byId('torcello');tape('Effort '+EFFORT[e]+' for '+t.name+"'s next worker.");feed('Effort set to '+EFFORT[e]+' for <em>'+t.name+'</em>.','#58a9ff',false);S.down(1.1);}}
(function(){const g=$('#dialTicks');let s='';for(let i=0;i<=30;i++){const a=(-138+i*276/30-90)*Math.PI/180,m=i%10===0,r0=m?56:58,r1=62;s+='<line class="t'+(m?' m':'')+'" x1="'+(70+Math.cos(a)*r0)+'" y1="'+(70+Math.sin(a)*r0)+'" x2="'+(70+Math.cos(a)*r1)+'" y2="'+(70+Math.sin(a)*r1)+'"/>';}
  EFFORT.forEach((n,i)=>{const a=(-138+i*92-90)*Math.PI/180;s+='<text id="sc'+i+'" x="'+(70+Math.cos(a)*69.5)+'" y="'+(72.6+Math.sin(a)*69.5)+'">'+['LOW','MED','HI','MAX'][i]+'</text>';});g.innerHTML=s;})();
function paintScale(){EFFORT.forEach((n,i)=>$('#sc'+i).classList.toggle('on',i===effort));}

/* ---------- hold to talk, with the real microphone when allowed ---------- */
const talk=$('#talk'),deck=$('#deck'),vc=$('#voice'),vx=vc.getContext('2d');
let v={on:false,an:null,stream:null,buf:null,t:0,amp:0};
function talkDown(){
  if(v.on)return;v.on=true;v.t=0;deck.classList.add('talking');deck.classList.remove('processing');S.tone(880,.05,.05,'sine');haptic(8);
  const md=navigator.mediaDevices;
  if(md&&md.getUserMedia&&S.ctx){md.getUserMedia({audio:{echoCancellation:true}}).then(st=>{if(!v.on){st.getTracks().forEach(t=>t.stop());return;}v.stream=st;const src=S.ctx.createMediaStreamSource(st),an=S.ctx.createAnalyser();an.fftSize=512;an.smoothingTimeConstant=.5;src.connect(an);v.an=an;v.buf=new Uint8Array(an.frequencyBinCount);}).catch(()=>{});}
}
function talkUp(){
  if(!v.on)return;v.on=false;deck.classList.remove('talking');deck.classList.add('processing');S.tone(660,.05,.05,'sine');
  if(v.stream){v.stream.getTracks().forEach(t=>t.stop());v.stream=null;v.an=null;}
  setTimeout(()=>{deck.classList.remove('processing');heard();},REDUCED?150:620);
}
function heard(){
  const id=selected||'torcello';const h=byId(id);S.tone(1046,.09,.05,'sine');
  if(id==='aurora'&&decision.open){tape('Heard “publish it”. Voice can ask, only the ring can publish.');nudgeCard('Voice can ask but not approve a public link. Hold the ring for 2 seconds.');return;}
  if(id==='burano'&&h.state==='fog'){h.state='moving';W.hull(id).state='moving';h.note='Writing the contract';h.plain='Writing the contract.';h.progress=.2;setLamp(id,'work');feed('You answered <em>Burano</em>. Postgres, no login, free. Fog lifted.','#58a9ff');W.hull(id).tz=-12.5;W.handover(1,id);detail();return;}
  feed('You told <em>'+h.name+'</em>: use a darker theme. It reads this at the next window.','#58a9ff');W.handover(Math.min(h.station,3)||1,id);
}
press(talk,()=>{S.down(.9);talkDown();},()=>{S.up(.9);talkUp();},()=>{S.up(.9);talkUp();});

function drawVoice(dt){
  const w=vc.width,h=vc.height,ctx=vx;const speaking=deck.classList.contains('talking'),proc=deck.classList.contains('processing');
  if(!speaking&&!proc){if(v.amp>.001){v.amp=0;W.voice(0);}return;}
  v.t+=dt;ctx.clearRect(0,0,w,h);
  const N=46,bw=w/N;let sum=0;
  for(let i=0;i<N;i++){let a=0;
    if(v.an&&speaking){v.an.getByteFrequencyData(v.buf);const k=Math.floor(2+i*.9);a=v.buf[k]/255;}
    else if(speaking){ /* no microphone: a speech shaped envelope so the deck still answers */
      const syll=Math.pow(Math.abs(Math.sin(v.t*5.3+Math.sin(v.t*1.7)*2)),.8)*(.55+.45*Math.sin(v.t*.9));
      const pos=1-Math.abs(i-N*.42)/(N*.6);a=clamp01(syll*pos*(.55+.45*Math.sin(i*1.9+v.t*19)*Math.sin(i*.7-v.t*11)));
    } else a=.12+.1*Math.sin(i*.4-v.t*16);
    sum+=a;
    const bh=Math.max(3,a*h*.9),x=i*bw;ctx.fillStyle=proc?'#f3f1ea':'#6ff5c9';ctx.globalAlpha=.45+a*.55;ctx.fillRect(x+1.6,(h-bh)/2,bw-3.2,bh);}
  ctx.globalAlpha=1;v.amp=sum/N;W.voice(speaking?v.amp:0);
}
const clamp01=(x)=>Math.max(0,Math.min(1,x));

/* ---------- HUD ---------- */
const tiles=$('#tiles');
function addTile(dark){const t=document.createElement('i');t.className='tile'+(dark?' dark':'');t.style.setProperty('--r',Math.floor(Math.random()*24-12));tiles.appendChild(t);return t;}
[0,0,0,1,0,0,0].forEach(d=>addTile(d));
function addRenown(n){const from=renown,to=renown+n,t0=performance.now();renown=to;(function f(now){const k=Math.min(1,(now-t0)/900);$('#renown').textContent=Math.round(from+(to-from)*k).toLocaleString('en-US');if(k<1)requestAnimationFrame(f);})(t0);}
function flyTile(){
  const hA=W.hull('aurora'),p=W.project(hA.x,1,hA.z);const t=document.createElement('i');t.className='tile';t.style.cssText='position:absolute;left:0;top:0;width:18px;height:18px;--r:8;z-index:30;transition:transform 1s cubic-bezier(.4,0,.15,1),width 1s,height 1s;transform:translate('+p.x+'px,'+p.y+'px) rotate(0deg)';$('#fly').appendChild(t);
  const tgt=tiles.getBoundingClientRect();requestAnimationFrame(()=>requestAnimationFrame(()=>{t.style.transform='translate('+(tgt.right-8)+'px,'+tgt.top+'px) rotate(190deg)';t.style.width=t.style.height='9px';}));
  setTimeout(()=>{t.remove();addTile(0);S.tone(1318,.5,.06,'sine');S.tone(1976,.6,.04,'sine');},1050);
}
function paintWeather(){
  const name=used<.5?'Clear':used<.75?'Wind':used<.9?'Gale':'Storm';$('#weatherName').textContent=name;
  $('#weatherSub').textContent=Math.round(used*100)+'% of window used';
  const left=Math.round((1-used)*100);$('#windowLeft').textContent=left+'% left, 1h 12m';
  $('#vane').style.transform='rotate('+(used<.5?20:used<.75?78:used<.9?96:118)+'deg)';W.setWeather(used);
}
$('#hudWeather').addEventListener('click',()=>{S.init();S.tick();used=used<.5?.63:used<.8?.94:.38;paintWeather();feed(used>.9?'Storm: 94% of the rate limit used. Workers slow down.':used<.5?'Clear: the rate limit is at 38%.':'Wind is up: 63% of the rate limit used.','#58a9ff');});
$('#plainToggle').addEventListener('click',e=>{S.init();S.tick();plain=!plain;e.currentTarget.setAttribute('aria-pressed',plain);
  document.querySelectorAll('[data-f]').forEach(n=>n.textContent=plain?n.dataset.p:n.dataset.f);staEls.forEach((el,i)=>el.textContent=plain?STN[i].plain:STN[i].fiction);$('#weatherName').parentNode.previousElementSibling.textContent=plain?'Rate limit':'Weather';if(decision.open)setCardCopy('open');detail();});
$('#soundToggle').addEventListener('click',e=>{S.on=!S.on;e.currentTarget.setAttribute('aria-pressed',S.on);if(S.on)S.init();if(S.out)S.out.gain.value=S.on?.9:0;});

/* ---------- keyboard: same commands, per spec 12 ---------- */
const keyHeld={};
addEventListener('keydown',e=>{
  if(e.repeat)return;const k=e.key.toLowerCase();
  if(k>='1'&&k<='6'){const id=order[+k-1];lampEls[id].classList.add('down');S.init();S.down(1.2);keyHeld[k]=()=>{lampEls[id].classList.remove('down');choose(id);};}
  else if(k==='y'){approve.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));keyHeld[k]=()=>approve.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));}
  else if(k==='n'){reject.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));keyHeld[k]=()=>reject.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));}
  else if(k===' '){e.preventDefault();talk.classList.add('down');S.init();S.down(.9);talkDown();keyHeld[k]=()=>{talk.classList.remove('down');S.up(.9);talkUp();};}
  else if(k==='r'){S.init();dial._mode='ring';ringDown();keyHeld[k]=()=>{dial._mode=null;ringUp();};}
  else if(k==='['){turn(-.25);S.init();}else if(k===']'){turn(.25);S.init();}
  else if(k==='escape'&&selected)choose(selected);
});
addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(keyHeld[k]){keyHeld[k]();delete keyHeld[k];}});

/* ---------- a live factory, on a short fake timeline ---------- */
const startup=()=>{
  const ok=W.init($('#world'),hulls.map(h=>Object.assign({},h)));
  if(!ok){$('#nogl').hidden=false;}
  hulls.forEach(h=>{paintLamp(h);tagText(h);});paintScale();paintWeather();layoutInsets();detail();
  feed('<em>Giudecca</em> finished. Chronicle is ready to read.','#49d68f',false);clock+=2;
  feed('<em>Burano</em> stopped on 3 open questions. Spending nothing.','#ffb12e',false);clock+=1;
  feed('<em>Murano</em> failed the gate, 2 of 31 checks. Repairer started.','#ff4630',false);clock+=2;
  feed('<em>Aurora</em> passed 31 of 31 checks. Receipt signed.','#d9a93a',false);clock+=1;
  feed('<em>Torcello</em> took work item 9 of 16.','#58a9ff');
  addEventListener('resize',layoutInsets);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(layoutInsets);
  /* timeline */
  const after=(ms,fn)=>setTimeout(fn,ms);
  after(+(new URLSearchParams(location.search).get('card')||3200),offerDecision);
  let wi=0;
  setInterval(()=>{ /* every few seconds a window opens and hands Torcello its next item */
    const h=byId('torcello'),wh=W.hull('torcello');if(!wh||h.state!=='build')return;
    clock+=1;W.handover(2,'torcello');const items=Math.min(16,9+(wi+1));
    setTimeout(()=>{wi++;h.progress=Math.min(.96,h.progress+.035);wh.progress=h.progress;wh.tz=Math.min(-.8,wh.tz+.9);h.note='Building '+items+' of 16';h.plain='Building: work item '+items+' of 16.';tagText(h);if(selected==='torcello')detail();feed('Window opened. <em>Torcello</em> took work item '+items+' of 16.','#58a9ff',decision.open?false:true);
      if(wi%5===0)W.closeWindows(2);},1200);
    ducats-=1;$('#ducats').textContent=ducats;
  },5200);
  after(70000,()=>{ /* the Repairer succeeds and the bar lifts */
    const h=byId('murano'),wh=W.hull('murano');h.state='moving';wh.state='moving';h.note='Gate passed, 31 of 31';h.plain='Gate passed on the third run.';setLamp('murano','work');W.barUp=true;wh.tz=10.2;S.bell(415,.1);addTile(0);addRenown(40);feed('Repairer fixed <em>Murano</em>. Gate passed, tessera set.','#d9a93a',!decision.open);if(selected==='murano')detail();
  });
  let tp=performance.now();
  W.onFrame=(dt,t)=>{
    if(ring.holding){const p=Math.min(1,(performance.now()-ring.t0)/2000);ring.p=p;setArc(p);W.ring('hold',p);S.drone(p);ringLabel.textContent=p<1?(2-p*2).toFixed(1):'Now';
      if(p>=1&&!ring.armed){ring.armed=true;dial.classList.add('armed');S.bell(392,.12);setCardCopy('armed');haptic(24);}}
    drawVoice(dt);
    placeLabels();
  };
};
function placeLabels(){
  const wide=innerWidth>=1000;
  const here=selected?byId(selected).station:-1,hudB=wide?0:68;
  STN.forEach((s,i)=>{const p=W.project(-9.4,i<4?4.3:2.2,s.z),w=staEls[i].offsetWidth||64;staEls[i].classList.toggle('here',i===here);staEls[i].style.opacity=p.y<hudB+10?0:'';staEls[i].style.transform='translate3d('+Math.max(wide?322:8,p.x-w).toFixed(1)+'px,'+(p.y-6).toFixed(1)+'px,0)';});
  /* flags stand off the street on a thin lead so they never sit on a hull */
  const flags=[];
  hulls.forEach(h=>{const wh=W.hull(h.id);if(!wh)return;const p=W.project(wh.x,1.1,wh.z),e=tagEls[h.id],f=e._f||(e._f=e.querySelector('.flag')),l=e._l||(e._l=e.querySelector('.lead'));
    if(!e._fw){e._fw=f.offsetWidth;e._fh=f.offsetHeight;}const fw=e._fw,fh=e._fh,maxX=innerWidth-fw-6;e.style.opacity=p.y<hudB||p.y>innerHeight?0:'';
    let fx=Math.min(maxX,p.x+(wide?34:50)),fy=p.y+(wide?-44:-6);
    if(fx<p.x+10)fy=p.y+16;
    flags.push({e,f,l,p,fx,fy,fw,fh});});
  /* keep flags from stacking on one another: push each one down clear of the last */
  flags.forEach(o=>{if(!wide)o.fy=Math.max(o.fy,hudB+2);});flags.sort((a,b)=>a.fy-b.fy);
  for(let i=1;i<flags.length;i++){const a=flags[i-1],b=flags[i];if(b.fx<a.fx+a.fw&&a.fx<b.fx+b.fw&&b.fy<a.fy+a.fh+3)b.fy=a.fy+a.fh+3;}
  flags.forEach(o=>{const inside=o.fx<o.p.x+10,ax=inside?o.p.x:o.fx,ay=inside?o.fy:o.fy+o.fh/2,dx=ax-o.p.x,dy=ay-o.p.y,len=Math.hypot(dx,dy),ang=Math.atan2(dy,dx);
    o.e.style.transform='translate3d('+o.p.x.toFixed(1)+'px,'+o.p.y.toFixed(1)+'px,0)';o.f.style.transform='translate3d('+(o.fx-o.p.x).toFixed(1)+'px,'+(o.fy-o.p.y).toFixed(1)+'px,0)';o.l.style.width=len.toFixed(1)+'px';o.l.style.transform='rotate('+ang.toFixed(3)+'rad)';});
}
window.__vz={ring:(p)=>{},hold:ringDown,release:ringUp,state:()=>({decision,used}),choose,setUsed:(u)=>{used=u;paintWeather();},W};
startup();
})();
