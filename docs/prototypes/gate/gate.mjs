#!/usr/bin/env node
// Venezia evidence gate prototype. Agent-independent: judges only by exit codes, HTTP, and browser events.
// usage: gate.mjs <projectDir> <evidenceDir> [--lock <sha256 of venezia.contract.json>] [--slug name]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { chromium, devices } from 'playwright-core';

const [,, projArg, evArg, ...rest] = process.argv;
const proj = path.resolve(projArg), ev = path.resolve(evArg); fs.mkdirSync(ev,{recursive:true});
const flag = n => { const i=rest.indexOf(n); return i<0?null:rest[i+1] };
const lock = flag('--lock'), slug = flag('--slug')||'app';
const sha = b => createHash('sha256').update(b).digest('hex');
const steps=[]; const t0=Date.now();
const rec=(id,ok,detail={},ms)=>{const s={id,ok,ms,...detail};steps.push(s);return ok};
const finish=(extra={})=>{const failed=steps.filter(s=>s.ok===false).map(s=>s.id);
  const verdict=failed.length?'FAIL':'PASS';
  const e={schema:1,verdict,failed,totalMs:Date.now()-t0,project:proj,node:process.version,steps,...extra};
  fs.writeFileSync(path.join(ev,'evidence.json'),JSON.stringify(e,null,1));
  console.log(JSON.stringify({verdict,failed,totalMs:e.totalMs})); process.exit(verdict==='PASS'?0:1)};
const kids=new Set(); const killAll=()=>{for(const c of kids){try{process.kill(-c.pid,'SIGKILL')}catch{}}};
process.on('exit',killAll);

function run(id,cmd,{cwd=proj,env={},timeout=180000}={}){const s=Date.now();
  const r=spawnSync('sh',['-c',cmd],{cwd,env:{...process.env,CI:'1',...env},timeout,encoding:'utf8',maxBuffer:5e7});
  const log=(r.stdout||'')+(r.stderr||''); fs.writeFileSync(path.join(ev,id+'.log'),log);
  return {ok:r.status===0,code:r.status,timedOut:r.error?.code==='ETIMEDOUT',ms:Date.now()-s,tail:log.slice(-400),stdout:r.stdout||''}}
const freePort=()=>new Promise(r=>{const s=netServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});

// ---- contract: authored by planner BEFORE build, hash-locked so the builder cannot weaken it
const cPath=path.join(proj,'venezia.contract.json');
if(!fs.existsSync(cPath)){rec('contract',false,{reason:'missing venezia.contract.json'});finish()}
const cBuf=fs.readFileSync(cPath); const contract=JSON.parse(cBuf); const cHash=sha(cBuf);
if(lock&&lock!==cHash){rec('contract',false,{reason:'hash mismatch: contract edited after lock',expected:lock,got:cHash});finish()}
rec('contract',true,{sha256:cHash,kind:contract.kind,locked:!!lock});
{const bad=[];for(const[f,h]of Object.entries(contract.locked?.files||{})){const p=path.join(proj,f);if(!fs.existsSync(p))bad.push(`missing ${f}`);else if(sha(fs.readFileSync(p))!==h)bad.push(`changed ${f}`)}
 const pj=fs.existsSync(path.join(proj,'package.json'))?JSON.parse(fs.readFileSync(path.join(proj,'package.json'))):{};
 for(const[k,v]of Object.entries(contract.locked?.scripts||{}))if(pj.scripts?.[k]!==v)bad.push(`script ${k} changed`);
 if(contract.locked){rec('locked-surface',bad.length===0,{bad}); if(bad.length)finish()}}

const pkgP=path.join(proj,'package.json'); const pkg=fs.existsSync(pkgP)?JSON.parse(fs.readFileSync(pkgP)):null;
const has=n=>!!pkg?.scripts?.[n];

// ---- install (scripts off: generated deps must not run code on the host unreviewed)
if(pkg){const lockf=fs.existsSync(path.join(proj,'package-lock.json'));
  if(!lockf) rec('lockfile',false,{reason:'no package-lock.json: not reproducible'});
  else{const r=run('install','npm ci --ignore-scripts --no-audit --no-fund');rec('install',r.ok,{code:r.code,tail:r.ok?'':r.tail},r.ms); if(!r.ok)finish()}}
else if(contract.install){const r=run('install',contract.install);rec('install',r.ok,{code:r.code},r.ms); if(!r.ok)finish()}

// ---- build + output existence (exit 0 is not enough: "build": "echo ok" must fail)
if(contract.kind==='web'||has('build')){
  const cmd=contract.build||'npm run build'; const r=run('build',cmd);rec('build',r.ok,{code:r.code,tail:r.ok?'':r.tail},r.ms); if(!r.ok)finish();
  if(contract.outDir){const d=path.join(proj,contract.outDir);const idx=path.join(d,'index.html');
    const ok=fs.existsSync(idx)&&fs.statSync(idx).size>0; rec('build-output',ok,{outDir:contract.outDir}); if(!ok)finish()}}

// ---- tests: must run and exist if contract says so
if(contract.test){const r=run('test',contract.test);const m=r.stdout.match(/^# pass (\d+)/m);const n=m?+m[1]:null;
  const enough=!contract.minTests||(n!==null&&n>=contract.minTests);rec('test',r.ok&&enough,{code:r.code,tests:n,min:contract.minTests,tail:r.ok&&enough?'':r.tail},r.ms)}

// ---- secret scan on everything that could leave the machine
const SECRET=[[/sk-ant-[A-Za-z0-9_-]{20,}/,'anthropic'],[/\bgh[pousr]_[A-Za-z0-9]{36,}/,'github'],[/\bAKIA[0-9A-Z]{16}\b/,'aws'],[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'pem'],[/\bsk-[A-Za-z0-9]{32,}\b/,'openai-like'],[/\bxox[baprs]-[0-9A-Za-z-]{20,}/,'slack']];
function* walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(['node_modules','.git'].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())yield* walk(p);else yield p}}
{const hits=[];let n=0;for(const f of walk(proj)){const st=fs.statSync(f);if(st.size>5e6)continue;n++;const s=fs.readFileSync(f,'latin1');for(const[re,name]of SECRET)if(re.test(s))hits.push({file:path.relative(proj,f),type:name});
   if(path.basename(f).startsWith('.env')&&!f.endsWith('.example'))hits.push({file:path.relative(proj,f),type:'dotenv-file'})}
 rec('secret-scan',hits.length===0,{files:n,hits})}

const browserChecks=[];
async function drive(browser,base,label,{runSmoke}){
  const out={label,ok:true,problems:[]};
  for(const [name,opt] of [['phone',devices['iPhone 15']],['desktop',{viewport:{width:1440,height:900}}]]){
    const ctx=await browser.newContext(opt); const page=await ctx.newPage();
    const nonce='vz'+Math.random().toString(36).slice(2,10); const errs=[];
    await page.exposeBinding('__vzReport',(_,t)=>errs.push('captured: '+t));
    await ctx.addInitScript(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>false,configurable:true});
      const r=window.__vzReport;
      addEventListener('error',e=>{if(e.target===window)r(String(e.message))},true);
      addEventListener('unhandledrejection',e=>r(String(e.reason&&e.reason.message||e.reason)),true)});
    const origin=new URL(base).origin;
    page.on('console',m=>{if(m.type()!=='error')return;if(/^Failed to load resource/.test(m.text()))return;errs.push('console: '+m.text())});
    page.on('pageerror',e=>errs.push('pageerror: '+e.message));
    page.on('response',r=>{if(r.status()>=400&&r.url().startsWith(origin)&&!r.url().endsWith('/favicon.ico'))errs.push(`http ${r.status()}: ${r.url().slice(origin.length)}`)});
    page.on('requestfailed',r=>{if(!r.url().endsWith('/favicon.ico'))errs.push('netfail: '+r.url().slice(0,100))});
    const ext=new Set(); page.on('request',r=>{const u=r.url();if(/^https?:/.test(u)&&!u.startsWith(origin))ext.add(new URL(u).host)});
    let nav; try{nav=await page.goto(base,{waitUntil:'load',timeout:15000})}catch(e){out.problems.push(`${name}: nav failed ${e.message.split('\n')[0]}`);await ctx.close();continue}
    if(!nav||nav.status()>=400)out.problems.push(`${name}: status ${nav?.status()}`);
    await page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>{});
    const m=await page.evaluate(()=>{const de=document.documentElement;const vis=[...document.body.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.display!=='none'});
      return {text:(document.body.innerText||'').trim().length,visible:vis.length,overflowX:de.scrollWidth-de.clientWidth,consoleTampered:!/\[native code\]/.test(Function.prototype.toString.call(console.error)),title:document.title,viewportMeta:!!document.querySelector('meta[name=viewport]'),brokenImages:[...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.getAttribute('src'))}});
    const shot=path.join(ev,`${label}-${name}.png`); await page.screenshot({path:shot});
    const buf=fs.readFileSync(shot);
    // blank check: count dominant-colour share by rendering the shot in canvas
    const b64=buf.toString('base64'); const p2=await ctx.newPage();
    await p2.goto('about:blank');
    const uni=await p2.evaluate(async b=>{const i=new Image();i.src='data:image/png;base64,'+b;await i.decode();const W=480,H=300;const c=new OffscreenCanvas(W,H);const x=c.getContext('2d');x.drawImage(i,0,0,W,H);const d=x.getImageData(0,0,W,H).data;const m=new Map();for(let k=0;k<d.length;k+=4){const q=(d[k]>>3)+','+(d[k+1]>>3)+','+(d[k+2]>>3);m.set(q,(m.get(q)||0)+1)}return Math.max(...m.values())/(W*H)},b64);
    await p2.close();
    if(m.visible<1||uni>=0.9995)out.problems.push(`${name}: blank (visible=${m.visible} text=${m.text} dominant=${uni.toFixed(5)})`);
    if(m.consoleTampered)out.problems.push(`${name}: page overrode console.error`);
    if(m.brokenImages.length)out.problems.push(`${name}: broken images ${m.brokenImages}`);
    if(name==='phone'&&m.overflowX>1)out.problems.push(`phone: horizontal overflow ${m.overflowX}px`);
    if(name==='phone'&&!m.viewportMeta)out.problems.push('phone: no viewport meta');
    if(runSmoke&&contract.smoke){ try{ for(const s of contract.smoke){
        if(s.click)await page.locator(s.click).first().click({timeout:3000});
        else if(s.fill)await page.locator(s.fill).first().fill(s.value.replaceAll('$NONCE',nonce),{timeout:3000});
        else if(s.press)await page.keyboard.press(s.press);
        else if(s.expectText)await page.getByText(s.expectText.replaceAll('$NONCE',nonce)).first().waitFor({timeout:3000});
        else if(s.expectCount){await page.waitForFunction(([q,n])=>document.querySelectorAll(q).length===n,[s.expectCount,s.n],{timeout:3000})}
      } await page.screenshot({path:path.join(ev,`${label}-${name}-after-smoke.png`)}) }catch(e){out.problems.push(`${name}: smoke failed: ${e.message.split('\n')[0].slice(0,140)}`)} }
    else if(runSmoke&&!contract.smoke){ out.problems.push('contract has no smoke steps') }
    await page.waitForTimeout(150);
    for(const e of errs)out.problems.push(`${name}: ${e}`);
    if(ext.size)out.external=[...(out.external||[]),...ext];
    out[name]={...m,dominant:+uni.toFixed(5),sha256:sha(buf),bytes:buf.length,errors:errs.length};
    await ctx.close();
  }
  out.ok=out.problems.length===0; return out;
}

// static host simulator: subpath, case-sensitive like Linux hosting, no SPA fallback
function staticSim(root,sub){const srv=createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);
    if(!u.startsWith(sub)){s.statusCode=404;return s.end('nf')}u=u.slice(sub.length)||'/';if(u.endsWith('/'))u+='index.html';
    let cur=root;for(const seg of u.split('/').filter(Boolean)){if(seg==='..'){s.statusCode=403;return s.end()}
      if(!fs.existsSync(cur)||!fs.statSync(cur).isDirectory()||!fs.readdirSync(cur).includes(seg)){s.statusCode=404;return s.end('nf')}cur=path.join(cur,seg)}
    if(fs.statSync(cur).isDirectory()){s.statusCode=301;s.setHeader('location',q.url+'/');return s.end()}
    const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
    s.setHeader('content-type',T[path.extname(cur)]||'application/octet-stream');fs.createReadStream(cur).pipe(s)});
  return new Promise(r=>srv.listen(0,'127.0.0.1',()=>r(srv)))}

if(contract.kind==='web'){
  const port=await freePort(); const s=Date.now();
  const startCmd=(contract.start||'npm start').replaceAll('$PORT',String(port));
  const log=fs.openSync(path.join(ev,'start.log'),'w');
  const c=spawn('sh',['-c',startCmd],{cwd:proj,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore',log,log],detached:true}); kids.add(c);
  let exited=null; c.on('exit',x=>exited=x);
  const health=`http://127.0.0.1:${port}${contract.health||'/'}`; let up=false,last='';
  while(Date.now()-s<20000&&exited===null){try{const r=await fetch(health,{signal:AbortSignal.timeout(1000)});last=String(r.status);if(r.status<400){up=true;break}}catch(e){last=e.cause?.code||e.name}await new Promise(r=>setTimeout(r,200))}
  rec('start-health',up,{port,health,last,exited},Date.now()-s);
  if(!up){killAll();finish()}
  const launch=Date.now(); const browser=await chromium.launch({channel:'chrome',headless:true});
  rec('browser-launch',true,{version:browser.version()},Date.now()-launch);
  const b1=Date.now(); const prod=await drive(browser,`http://127.0.0.1:${port}/`,'server',{runSmoke:true}); rec('browser-server',prod.ok,{...prod},Date.now()-b1);
  killAll();
  // restart check: no orphan server
  if(contract.outDir&&contract.static){const sub=`/${slug}/`;const srv=await staticSim(path.join(proj,contract.outDir),sub);
    const b2=Date.now(); const r=await drive(browser,`http://127.0.0.1:${srv.address().port}${sub}`,'hostsim',{runSmoke:true});rec('browser-host-sim',r.ok,{...r,sub},Date.now()-b2);srv.close()}
  await browser.close();
}
if(contract.kind==='cli'||contract.kind==='library'){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vz-pack-'));
  const p=run('pack',(contract.pack||'npm pack --pack-destination "$OUT"').replaceAll('$OUT',tmp));
  rec('pack',p.ok,{code:p.code,tail:p.ok?'':p.tail},p.ms); if(!p.ok)finish();
  const art=fs.readdirSync(tmp).find(f=>/\.(tgz|whl)$/.test(f));
  const clean=path.join(tmp,'clean');fs.mkdirSync(clean);fs.writeFileSync(path.join(clean,'package.json'),'{"private":true}');
  if(art.endsWith('.tgz')){const i=run('clean-install',`npm i --no-audit --no-fund --ignore-scripts "${path.join(tmp,art)}"`,{cwd:clean});rec('clean-install',i.ok,{artifact:art},i.ms); if(!i.ok)finish();}
  else rec('clean-install',true,{artifact:art,via:'uvx --from wheel'});
  for(const [n,t] of (contract.golden||[]).entries()){const cmd=t.run.replaceAll('$BIN',path.join(clean,'node_modules/.bin')).replaceAll('$WHEEL',path.join(tmp,art||''));const r=run(`golden-${n}`,cmd,{cwd:clean});
    const ok=r.code===(t.exit??0)&&(!t.stdout||r.stdout.includes(t.stdout));rec(`golden-${n}`,ok,{cmd:t.run,code:r.code,want:t.stdout,tail:ok?'':r.tail},r.ms)}
  if(!(contract.golden||[]).length)rec('golden',false,{reason:'no golden commands'});
  fs.writeFileSync(path.join(ev,'transcript.txt'),steps.filter(s=>s.id.startsWith('golden')).map(s=>JSON.stringify(s)).join('\n'));
}
killAll(); finish();
