// Measures startup latency and RSS for N concurrent workers. usage: node rss.mjs <N> <turn:0|1> [mode]
import { spawn, execFileSync } from 'node:child_process';
const SP=process.env.SP, N=+process.argv[2], TURN=process.argv[3]==='1', MODE=process.argv[4]||'iso';
const flags= MODE==='iso'? ['--setting-sources','','--strict-mcp-config','--disable-slash-commands','--no-chrome','--settings','{"autoMemoryEnabled":false}'] : [];
const args=['-p','--output-format','stream-json','--input-format','stream-json','--verbose','--model','haiku','--no-session-persistence',...flags,'--allowedTools','Bash(echo *)'];
const tree=()=>{ const out=execFileSync('ps',['-axo','pid=,ppid=,rss=,comm=']).toString().trim().split('\n').map(l=>l.trim().split(/\s+/)); return out.map(a=>({pid:+a[0],ppid:+a[1],rss:+a[2],comm:a.slice(3).join(' ')})); };
const rssOf=(pids)=>{ const t=tree(); const set=new Set(pids); let grew=true; while(grew){grew=false; for(const p of t) if(!set.has(p.pid)&&set.has(p.ppid)){set.add(p.pid);grew=true;}} return {main:t.filter(p=>pids.includes(p.pid)).reduce((a,p)=>a+p.rss,0), all:t.filter(p=>set.has(p.pid)).reduce((a,p)=>a+p.rss,0), count:set.size}; };
const t0=Date.now(); const ws=[]; const peak={main:0,all:0,count:0}; let doneTurns=0;
for(let i=0;i<N;i++){ const c=spawn('claude',args,{cwd:SP+'/yard-r',stdio:['pipe','pipe','ignore']}); const w={c,t:{},buf:''}; ws.push(w);
 c.stdout.on('data',d=>{ w.buf+=d; let k; while((k=w.buf.indexOf('\n'))>=0){ const l=w.buf.slice(0,k); w.buf=w.buf.slice(k+1); if(!l.trim()) continue; const m=JSON.parse(l); const now=Date.now()-t0;
  if(m.type==='control_response'&&!w.t.ctl) { w.t.ctl=now; if(TURN){ c.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Use Bash to run: echo hi . Then reply ok.'},parent_tool_use_id:null})+'\n'); } }
  if(m.type==='system'&&m.subtype==='init'&&!w.t.init) w.t.init=now;
  if(m.type==='assistant'&&!w.t.first) w.t.first=now;
  if(m.type==='result'&&!w.t.result){ w.t.result=now; w.t.cost=m.total_cost_usd; w.t.err=m.is_error; doneTurns++; }
 }});
 c.stdin.write(JSON.stringify({type:'control_request',request_id:'i',request:{subtype:'initialize'}})+'\n');
}
const pids=ws.map(w=>w.c.pid); const sample=()=>{ const r=rssOf(pids); if(r.main>peak.main)peak.main=r.main; if(r.all>peak.all)peak.all=r.all; if(r.count>peak.count)peak.count=r.count; return r; };
const iv=setInterval(sample,200);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await wait(TURN?500:4000); 
if(TURN){ const end=Date.now()+60000; while(doneTurns<N&&Date.now()<end) await wait(200); await wait(600);} 
const settled=sample(); clearInterval(iv);
for(const w of ws){ w.c.kill('SIGTERM'); }
await wait(800);
console.log(JSON.stringify({N,TURN,MODE,mainRssMB:Math.round(settled.main/1024),treeRssMB:Math.round(settled.all/1024),peakMainMB:Math.round(peak.main/1024),peakTreeMB:Math.round(peak.all/1024),peakProcs:peak.count,perWorkerPeakMB:Math.round(peak.all/1024/N),timing:ws.map(w=>w.t)}));
process.exit(0);
