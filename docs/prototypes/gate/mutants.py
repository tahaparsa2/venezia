import shutil,os,json,subprocess,hashlib,sys,time
G='fixtures/good'; M='fixtures/m'
shutil.rmtree(M,ignore_errors=True); os.makedirs(M)
def rd(p): return open(p).read()
def wr(p,s): os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(s)
def pj(d,f):
    p=f'{d}/package.json'; j=json.load(open(p)); f(j); wr(p,json.dumps(j))
def ct(d,f):
    p=f'{d}/venezia.contract.json'; j=json.load(open(p)); f(j); wr(p,json.dumps(j))
def app(d,s): wr(f'{d}/src/main.js',rd(f'{d}/src/main.js')+s)
muts={
 'build-syntax-error':(lambda d:app(d,'\nconst = ;\n'),'build'),
 'fake-build-echo':(lambda d:pj(d,lambda j:j['scripts'].update(build='echo built ok')),'locked-surface'),
 'failing-test':(lambda d:wr(f'{d}/test/a.test.js',"import test from 'node:test';import a from 'node:assert';test('x',()=>a.equal(1,2));"),'locked-surface'),
 'start-crashes':(lambda d:pj(d,lambda j:j['scripts'].update(start='node -e "process.exit(1)"')),'locked-surface'),
 'server-hangs-no-response':(lambda d:pj(d,lambda j:j['scripts'].update(start='node -e "require(\'http\').createServer(()=>{}).listen(process.env.PORT)"')),'locked-surface'),
 'wrong-port':(lambda d:pj(d,lambda j:j['scripts'].update(start='vite preview --port 45871 --strictPort')),'locked-surface'),
 'console-error-on-load':(lambda d:app(d,"\nconsole.error('boom');\n"),'browser-server'),
 'uncaught-on-load':(lambda d:app(d,"\nsetTimeout(()=>{null.x},10);\n"),'browser-server'),
 'unhandled-rejection':(lambda d:app(d,"\nPromise.reject(new Error('nope'));\n"),'browser-server'),
 'error-only-on-click':(lambda d:app(d,"\ndocument.querySelector('#add').addEventListener('click',()=>{throw new Error('click bug')});\n"),'browser-server'),
 'noop-button':(lambda d:app(d,"\ndocument.querySelector('#add').onclick=()=>{};\n"),'browser-server'),
 'missing-asset-404':(lambda d:app(d,"\nconst i=new Image();i.src='./nope.png';i.alt='x';document.body.append(i);\n"),'browser-server'),
 'blank-page':(lambda d:wr(f'{d}/src/main.js','// renders nothing\n'),'browser-server'),
 'phone-overflow':(lambda d:wr(f'{d}/src/style.css',rd(f'{d}/src/style.css')+'\n#app{width:1000px}\n'),'browser-server'),
 'no-viewport-meta':(lambda d:wr(f'{d}/index.html',rd(f'{d}/index.html').replace('<meta name=viewport content="width=device-width,initial-scale=1">','')),'browser-server'),
 'absolute-base-breaks-subpath':(lambda d:wr(f'{d}/vite.config.js',"export default { base: '/' }\n"),'browser-host-sim'),
 'case-mismatch-public-asset':(lambda d:(wr(f'{d}/public/Logo.svg',rd(f'{d}/src/logo.svg')),app(d,"\nconst i=new Image();i.src='./logo.svg';i.alt='x';document.body.append(i);\n")),'browser-host-sim'),
 'spa-route-needs-fallback':(lambda d:app(d,"\nif(!location.pathname.endsWith('/x')){fetch('./x').then(r=>{if(!r.ok)console.error('route 404')})}\n"),'browser-host-sim'),
 'secret-in-bundle':(lambda d:app(d,"\nwindow.K='sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE';\n"),'secret-scan'),
 'dotenv-left-behind':(lambda d:wr(f'{d}/.env','FOO=bar\n'),'secret-scan'),
 'no-lockfile':(lambda d:os.remove(f'{d}/package-lock.json'),'lockfile'),
 'runtime-start-crash-in-config':(lambda d:wr(f'{d}/vite.config.js',"throw new Error('boom');export default {}"),'build'),
 'contract-weakened-after-lock':(lambda d:ct(d,lambda j:j.update(smoke=[])),'contract'),
 'contract-deleted':(lambda d:os.remove(f'{d}/venezia.contract.json'),'contract'),
 'cheat-hollow-test':(lambda d:pj(d,lambda j:j['scripts'].update(test='exit 0')),'locked-surface'),
 'cheat-delete-tests':(lambda d:shutil.move(f'{d}/test/a.test.js',f'{d}/moved.txt'),'locked-surface'),
 'cheat-edit-test':(lambda d:wr(f'{d}/test/a.test.js',rd(f'{d}/test/a.test.js')+'\n//skip\n'),'locked-surface'),
 'cheat-hardcoded-smoke':(lambda d:app(d,"\ndocument.querySelector('#add').onclick=()=>{const li=document.createElement('li');li.textContent='buy oat milk';document.querySelector('#l').append(li)};\n"),'browser-server'),
 'cheat-silence-console':(lambda d:app(d,"\nconsole.error=()=>{};console.error('hidden');\n"),'browser-server'),
 'cheat-preventdefault-uncaught':(lambda d:app(d,"\nwindow.addEventListener('error',e=>e.preventDefault());setTimeout(()=>{null.x},5);\n"),'browser-server'),
 'cheat-stub-server':(lambda d:(pj(d,lambda j:j['scripts'].update(start='node stub.mjs')),wr(f'{d}/stub.mjs','')),'locked-surface'),
 'cheat-webdriver-sniff':(lambda d:app(d,"\nif(!navigator.webdriver){document.body.innerHTML=''}\n"),'browser-server'),
}
controls={
 'CONTROL-good':(lambda d:None,None),
 'CONTROL-canvas-only':(lambda d:(wr(f'{d}/src/main.js',"import './style.css';\nconst a=document.querySelector('#app');a.innerHTML='<input id=t aria-label=t style=\"opacity:0;position:absolute\"><button id=add style=\"opacity:0;position:absolute\">a</button><ul id=l style=\"position:absolute;opacity:0\"></ul><canvas id=c width=300 height=300></canvas>';const x=c.getContext('2d');let g=x.createLinearGradient(0,0,300,300);g.addColorStop(0,'#40f');g.addColorStop(1,'#0fa');x.fillStyle=g;x.fillRect(0,0,300,300);add.onclick=()=>{const li=document.createElement('li');li.textContent=t.value;l.append(li)};\n"),ct(d,lambda j:j.update(smoke=[{'fill':'#t','value':'zzz'},{'click':'#add'},{'expectCount':'#l li','n':1}]))),None),
 'CONTROL-sparse-white-page':(lambda d:wr(f'{d}/src/style.css','body{margin:0;padding:8px;font:11px system-ui}img{display:none}'),None),
 'CONTROL-third-party-404-favicon':(lambda d:wr(f'{d}/index.html',rd(f'{d}/index.html').replace('<link rel=icon href="data:,">','')),None),
}
lock=hashlib.sha256(open(f'{G}/venezia.contract.json','rb').read()).hexdigest()
res=[]; names={**controls,**muts}
only=sys.argv[1:] 
for n,(f,want) in names.items():
    if only and n not in only: continue
    d=f'{M}/{n}'; shutil.copytree(G,d,ignore=shutil.ignore_patterns('node_modules','dist'))
    ret=f(d)
    # lockfile hash must move with control that intentionally rewrites its contract
    l=hashlib.sha256(open(f'{d}/venezia.contract.json','rb').read()).hexdigest() if n=='CONTROL-canvas-only' else lock
    t=time.time(); p=subprocess.run(['node','gate.mjs',d,f'ev/{n}','--lock',l,'--slug','todo'],capture_output=True,text=True,timeout=120)
    try: o=json.loads(p.stdout.strip().splitlines()[-1])
    except Exception: o={'verdict':'CRASH','failed':[p.stderr[-300:]]}
    exp='PASS' if want is None else 'FAIL'
    ok=(o['verdict']==exp) and (want is None or want in o['failed'])
    res.append((n,o['verdict'],o['failed'],want,'OK' if ok else 'MISS',round(time.time()-t,1)))
    print(res[-1],flush=True)
print('caught',sum(1 for r in res if r[4]=='OK'),'of',len(res))
json.dump(res,open('mutants-result.json','w'),indent=1)
