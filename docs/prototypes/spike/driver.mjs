// Generic stream-json driver: node driver.mjs <scenario.mjs> <outfile>
// A scenario exports { args, cwd, env?, steps(ctx) } where ctx offers send(obj), wait(pred|ms), kill(), lines.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [,, scen, out] = process.argv;
const s = (await import(path.resolve(scen))).default;
const t0 = Date.now();
const log = fs.createWriteStream(out);
const stamp = () => Date.now() - t0;
const child = spawn('claude', s.args, { cwd: s.cwd, env: { ...process.env, ...(s.env||{}) }, stdio: ['pipe','pipe','pipe'] });
let buf=''; const lines=[]; const waiters=[]; let exited=null;
child.stdout.on('data', d => { buf+=d; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(!l.trim()) continue; let o; try{o=JSON.parse(l)}catch{o={raw:l}}; const rec={t:stamp(),dir:'out',msg:o}; lines.push(rec); log.write(JSON.stringify(rec)+'\n'); for(const w of [...waiters]) if(w.p(o,rec)){waiters.splice(waiters.indexOf(w),1); w.r(o);} } });
child.stderr.on('data', d => { log.write(JSON.stringify({t:stamp(),dir:'err',msg:String(d)})+'\n'); });
child.on('exit',(c,sig)=>{ exited={c,sig,t:stamp()}; log.write(JSON.stringify({t:stamp(),dir:'exit',msg:{code:c,signal:sig}})+'\n'); for(const w of waiters) w.r(null); });
const ctx = {
  lines, child,
  send(o){ log.write(JSON.stringify({t:stamp(),dir:'in',msg:o})+'\n'); child.stdin.write(JSON.stringify(o)+'\n'); },
  user(text){ ctx.send({type:'user',message:{role:'user',content:text},parent_tool_use_id:null}); },
  wait(p,timeout=60000){ return new Promise(r=>{ if(typeof p==='number') return setTimeout(r,p); const hit=lines.find(l=>p(l.msg,l)&&!l._c); if(hit){hit._c=true; return r(hit.msg);} const w={p,r}; waiters.push(w); setTimeout(()=>{const i=waiters.indexOf(w); if(i>=0){waiters.splice(i,1); r(null);}},timeout); }); },
  close(){ child.stdin.end(); },
  kill(sig='SIGTERM'){ child.kill(sig); },
  exited(){ return exited; },
};
const guard=setTimeout(()=>{log.write(JSON.stringify({t:stamp(),dir:'guard',msg:'timeout kill'})+'\n'); child.kill('SIGKILL'); process.exit(3)}, s.guardMs||150000);
await s.steps(ctx);
await new Promise(r=>{ if(exited) r(); else child.on('exit',r); setTimeout(r,8000);});
if(!exited) child.kill('SIGKILL');
clearTimeout(guard);
log.end();
setTimeout(()=>process.exit(0),300);
