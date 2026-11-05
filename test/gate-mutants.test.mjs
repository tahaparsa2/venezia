// The mutants from research 05, on a dependency-free fixture so they run offline. Each one
// breaks a healthy yard the way a real bug or a lazy agent would, and names the step that
// must catch it. A mutant that survives may be a bad mutant, so controls must still pass.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { runGate } from '../engine/gate/index.mjs';
import { appendApp, editJson, editPackage, makeCliYard, makeYard, read, sharedBrowser, write } from './gate-helpers.mjs';

let browser;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

async function gate(t, yardOptions, options = {}) {
  const made = (yardOptions.make ?? makeYard)(t, yardOptions);
  const result = await runGate({
    yard: made.yard,
    contractHash: made.contractHash,
    evidenceDir: made.evidenceDir,
    slug: 'todo',
    browser,
    browserLock: async () => () => {},
    smokeTimeoutMs: 700,
    healthTimeoutMs: 2500,
    ...options,
  });
  return { ...made, ...result };
}

/** Every group runs in one pool, because the whole file is waiting on subprocesses. */
const groups = [];
const group = (name, define) => groups.push([name, define]);

const canvasApp = (yard) => {
  write(yard, 'src/main.js', `
const app = document.querySelector('#app');
app.innerHTML = '<input id="t" aria-label="t" style="opacity:0;position:absolute"><button id="add" style="opacity:0;position:absolute">a</button><ul id="l" style="position:absolute;opacity:0"></ul><canvas id="c" width="300" height="300"></canvas>';
const pen = document.querySelector('#c').getContext('2d');
const paint = pen.createLinearGradient(0, 0, 300, 300);
paint.addColorStop(0, '#40f');
paint.addColorStop(1, '#0fa');
pen.fillStyle = paint;
pen.fillRect(0, 0, 300, 300);
document.querySelector('#add').onclick = () => {
  const item = document.createElement('li');
  item.textContent = document.querySelector('#t').value;
  document.querySelector('#l').append(item);
};
`);
};

/** Healthy projects: the gate must not fail these. */
const controls = {
  'good app, run through npm scripts': { contract: { build: undefined, start: 'npm start', test: 'npm test --silent' } },
  'canvas-only app, with no text at all': {
    before: canvasApp,
    contract: { smoke: [{ fill: '#t', value: 'zzz' }, { click: '#add' }, { expectCount: '#l li', n: 1 }] },
  },
  'sparse white page': {
    after: (d) => write(d, 'src/style.css', 'body{margin:0;padding:8px;font:11px system-ui;background:#fff}img{display:none}'),
  },
  'no favicon, so the browser gets a 404 for it': {
    after: (d) => write(d, 'index.html', read(d, 'index.html').replace('<link rel=icon href="data:,">', '')),
  },
  'external host the contract names': {
    after: (d) => appendApp(d, "\nconst i=new Image();i.src=location.href.replace('127.0.0.1','localhost')+'logo.svg';i.alt='x';document.body.append(i);\n"),
    contract: { externalHosts: ['localhost'] },
  },
};

const browserMutants = {
  'console error on load': [(d) => appendApp(d, "\nconsole.error('boom');\n"), 'browser-server'],
  'uncaught error on load': [(d) => appendApp(d, '\nsetTimeout(()=>{null.x},10);\n'), 'browser-server'],
  'unhandled rejection': [(d) => appendApp(d, "\nPromise.reject(new Error('nope'));\n"), 'browser-server'],
  'error only on click': [(d) => appendApp(d, "\ndocument.querySelector('#add').addEventListener('click',()=>{throw new Error('click bug')});\n"), 'browser-server'],
  'button does nothing': [(d) => write(d, 'src/main.js', read(d, 'src/main.js').replace("document.querySelector('#l').append(item);", '')), 'browser-server'],
  'missing asset': [(d) => appendApp(d, "\nconst i=new Image();i.src='./nope.png';i.alt='x';document.body.append(i);\n"), 'browser-server'],
  'blank page': [(d) => write(d, 'src/main.js', '// renders nothing\n'), 'browser-server'],
  'overflows on a phone': [(d) => write(d, 'src/style.css', `${read(d, 'src/style.css')}\n#app{width:1000px}\n`), 'browser-server'],
  'no viewport tag': [(d) => write(d, 'index.html', read(d, 'index.html').replace('<meta name=viewport content="width=device-width,initial-scale=1">', '')), 'browser-server'],
  'absolute path breaks under a subfolder': [(d) => write(d, 'index.html', read(d, 'index.html').replace('src="./main.js"', 'src="/main.js"')), 'browser-host-sim'],
  'asset name differs by case': [(d) => { write(d, 'public/Logo2.svg', read(d, 'src/logo.svg')); appendApp(d, "\nconst i=new Image();i.src='./logo2.svg';i.alt='x';document.body.append(i);\n"); }, 'browser-host-sim'],
  'deep link needs SPA fallback': [(d) => appendApp(d, "\nif(!location.pathname.endsWith('/x')){fetch('./x').then(r=>{if(!r.ok)console.error('route 404')})}\n"), 'browser-host-sim'],
  'contacts a host the contract does not name': [(d) => appendApp(d, "\nnew Image().src='http://tracker.invalid/pixel.png';\n"), 'external-hosts'],
  'cheat: hardcoded smoke answer': [(d) => appendApp(d, "\ndocument.querySelector('#add').onclick=()=>{const li=document.createElement('li');li.textContent='buy oat milk';document.querySelector('#l').append(li)};\n"), 'browser-server'],
  'cheat: silenced console.error': [(d) => appendApp(d, "\nconsole.error=()=>{};console.error('hidden');\n"), 'browser-server'],
  'cheat: console.error swapped for a bound function': [(d) => appendApp(d, "\nconsole.error=(()=>{}).bind(null);\n"), 'browser-server'],
  'cheat: preventDefault on errors': [(d) => appendApp(d, "\nwindow.addEventListener('error',e=>e.preventDefault());setTimeout(()=>{null.x},5);\n"), 'browser-server'],
  'cheat: sniffs navigator.webdriver': [(d) => appendApp(d, "\nif(!navigator.webdriver){document.body.innerHTML=''}\n"), 'browser-server'],
  'cheat: sniffs Headless in the user agent': [(d) => appendApp(d, "\nif(!/Headless/.test(navigator.userAgent)){document.body.innerHTML=''}\n"), 'browser-server'],
};

const staticMutants = {
  'syntax error': [(d) => appendApp(d, '\nconst = ;\n'), 'build'],
  'build config throws': [(d) => write(d, 'build.config.mjs', "throw new Error('boom');\n"), 'build'],
  'fake build': [(d) => editPackage(d, (p) => { p.scripts.build = 'echo built ok'; }), 'locked-surface'],
  'edited test': [(d) => write(d, 'test/a.test.js', `${read(d, 'test/a.test.js')}\n//skip\n`), 'locked-surface'],
  'deleted test': [(d) => fs.rmSync(path.join(d, 'test/a.test.js')), 'locked-surface'],
  'hollow test script': [(d) => editPackage(d, (p) => { p.scripts.test = 'exit 0'; }), 'locked-surface'],
  'start script crashes': [(d) => editPackage(d, (p) => { p.scripts.start = 'node -e "process.exit(1)"'; }), 'locked-surface'],
  'stub server': [(d) => { editPackage(d, (p) => { p.scripts.start = 'node stub.mjs'; }); write(d, 'stub.mjs', ''); }, 'locked-surface'],
  'pretest hook rewrites the test': [(d) => editPackage(d, (p) => { p.scripts.pretest = 'true'; }), 'locked-surface'],
  'npmrc swaps the script shell': [(d) => write(d, '.npmrc', 'script-shell=/usr/bin/true\n'), 'locked-surface'],
  'contract weakened after lock': [(d) => editJson(d, 'venezia.contract.json', (j) => { j.smoke = []; }), 'contract'],
  'contract deleted': [(d) => fs.rmSync(path.join(d, 'venezia.contract.json')), 'contract'],
  'contract corrupted': [(d) => write(d, 'venezia.contract.json', '{not json'), 'contract'],
  'no lockfile': [(d) => fs.rmSync(path.join(d, 'package-lock.json')), 'lockfile'],
  'broken lockfile': [(d) => write(d, 'package-lock.json', '{'), 'install'],
  'broken package.json': [(d) => write(d, 'package.json', '{'), 'locked-surface'],
  'build leaves no index.html': [(d) => write(d, 'build.config.mjs', "import fs from 'node:fs';process.exit(0);\n"), 'build-output'],
  'empty index.html': [(d) => write(d, 'index.html', ''), 'build-output'],
  'source map in the output': [(d) => write(d, 'public/main.js.map', '{}'), 'payload'],
  '.env in the output': [(d) => write(d, 'public/.env.production', 'FOO=bar\n'), 'payload'],
  'symlink in the output': [(d) => fs.symlinkSync('/etc/hosts', path.join(d, 'src/hosts')), 'payload'],
  'output folder is a symlink': [(d) => { write(d, 'build.config.mjs', "import fs from 'node:fs';fs.mkdirSync('elsewhere',{recursive:true});fs.writeFileSync('elsewhere/index.html','x');fs.symlinkSync('elsewhere','dist');process.exit(0);\n"); }, 'payload'],
  'secret in the bundle': [(d) => appendApp(d, "\nwindow.K='sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE';\n"), 'secret-scan'],
  '.env left in the yard': [(d) => write(d, '.env', 'FOO=bar\n'), 'secret-scan'],
  'secret deep in a large file': [(d) => write(d, 'notes.txt', `${'x'.repeat(6e6)} ghp_${'a'.repeat(36)}`), 'secret-scan'],
  'private key file': [(d) => write(d, 'deploy.pem', 'not actually a key\n'), 'secret-scan'],
};

/** These change what the planner locked, so they reach the runtime paths behind locked-surface. */
const lockedInMutants = {
  'test fails': [(d) => write(d, 'test/a.test.js', "import test from 'node:test';import a from 'node:assert';test('x',()=>a.equal(1,2));\n"), 'test'],
  'fewer tests than promised': [(d) => write(d, 'test/a.test.js', "import test from 'node:test';test.skip('x',()=>{});\n"), 'test'],
  'server crashes on start': [(d) => editPackage(d, (p) => { p.scripts.start = 'node -e "process.exit(1)"'; }), 'start-health'],
  'server hangs': [(d) => editPackage(d, (p) => { p.scripts.start = 'node -e "require(\'http\').createServer(()=>{}).listen(process.env.PORT)"'; }), 'start-health'],
  'server ignores the port': [(d) => editPackage(d, (p) => { p.scripts.start = 'node -e "require(\'http\').createServer((q,s)=>s.end(\'x\')).listen(45871)"'; }), 'start-health'],
  'test rewrites the locked surface': [(d) => write(d, 'test/a.test.js', "import fs from 'node:fs';import test from 'node:test';test('x',()=>{fs.writeFileSync('test/b.txt','x');fs.appendFileSync('package.json',' ');const f='test/a.test.js';fs.appendFileSync(f,'// gone\\n')});\n"), 'surface-stable'],
};

const contractMutants = {
  'no smoke steps': [{ smoke: [] }, 'contract'],
  'misspelt smoke step': [{ smoke: [{ expectTxt: 'x' }] }, 'contract'],
  'output folder outside the yard': [{ outDir: '../..' }, 'contract'],
  'nothing locked': [{ locked: { files: {}, scripts: {} } }, 'contract'],
  'unknown kind': [{ kind: 'mystery' }, 'contract'],
};

group('healthy projects pass', () => {
  for (const [name, options] of Object.entries(controls)) {
    test(`control: ${name}`, async (t) => {
      if (!browser) return t.skip('Chrome is not installed');
      const result = await gate(t, options, { smokeTimeoutMs: 5000 });
      assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));
      assert.deepEqual(result.failed, []);
      return undefined;
    });
  }
});

group('browser mutants fail', () => {
  for (const [name, [mutate, want]] of Object.entries(browserMutants)) {
    test(name, async (t) => {
      if (!browser) return t.skip('Chrome is not installed');
      const result = await gate(t, { after: mutate });
      assert.equal(result.verdict, 'FAIL');
      assert.ok(result.failed.includes(want), `wanted ${want}, got ${result.failed}`);
      assert.equal(result.artifactHash, null);
      return undefined;
    });
  }
});

group('mutants that stop before the browser fail', () => {
  for (const [name, [mutate, want]] of Object.entries(staticMutants)) {
    test(name, async (t) => {
      const result = await gate(t, { after: mutate });
      assert.equal(result.verdict, 'FAIL', JSON.stringify(result.steps.map((s) => [s.step, s.ok])));
      assert.ok(result.failed.includes(want), `wanted ${want}, got ${result.failed}`);
    });
  }
});

group('runtime failures the planner locked in', () => {
  for (const [name, [mutate, want]] of Object.entries(lockedInMutants)) {
    test(name, async (t) => {
      if (!browser) return t.skip('Chrome is not installed');
      const result = await gate(t, { before: mutate, contract: { start: 'npm start', test: 'npm test --silent' } });
      assert.equal(result.verdict, 'FAIL', JSON.stringify(result.steps.map((s) => [s.step, s.ok])));
      assert.ok(result.failed.includes(want), `wanted ${want}, got ${result.failed}`);
      return undefined;
    });
  }
});

group('weak contracts fail', () => {
  for (const [name, [contract, want]] of Object.entries(contractMutants)) {
    test(name, async (t) => {
      const result = await gate(t, { contract });
      assert.equal(result.verdict, 'FAIL');
      assert.ok(result.failed.includes(want), `wanted ${want}, got ${result.failed}`);
    });
  }
});

/** The non-web route: test the package a stranger would receive, not the working tree. */
const cliMutants = {
  'exports file left out of the package': [(d) => editPackage(d, (p) => { p.files = ['bin.js']; }), /^golden-/],
  'undeclared dependency': [(d) => write(d, 'lib.js', "import 'left-pad-not-installed';\nexport const greet = (name) => `hello ${name}`;\n"), /^(golden-|test)/],
  'wrong output': [(d) => write(d, 'bin.js', "#!/usr/bin/env node\nconsole.log('goodbye');\n"), /^golden-/],
  'wrong exit code': [(d) => write(d, 'bin.js', `${read(d, 'bin.js')}\nprocess.exitCode = 3;\n`), /^golden-/],
  'entry point typo': [(d) => editPackage(d, (p) => { p.bin.hello = 'bni.js'; }), /^(golden-|clean-install)/],
};

group('packages', () => {
  test('a healthy command-line tool passes', async (t) => {
    const result = await gate(t, { make: makeCliYard });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));
    assert.match(result.artifactHash, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(result.evidenceDir, 'transcript.txt')));
    assert.ok(fs.readdirSync(result.evidenceDir).some((file) => file.endsWith('.tgz')));
  });

  test('a healthy library passes', async (t) => {
    const result = await gate(t, {
      make: makeCliYard,
      contract: { kind: 'library', golden: [{ run: 'node --input-type=module -e "import { greet } from \'hello-cli\'; console.log(greet(\'lib\'))"', stdout: 'hello lib' }] },
    });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));
  });

  test('no golden commands fails', async (t) => {
    const result = await gate(t, { make: makeCliYard, contract: { golden: [] } });
    assert.ok(result.failed.includes('golden'));
  });

  for (const [name, [mutate, want]] of Object.entries(cliMutants)) {
    test(name, async (t) => {
      const result = await gate(t, { make: makeCliYard, before: mutate });
      assert.equal(result.verdict, 'FAIL', JSON.stringify(result.steps.map((s) => [s.step, s.ok])));
      assert.ok(result.failed.some((step) => want.test(step)), `wanted ${want}, got ${result.failed}`);
    });
  }
});

describe('gate mutants', { concurrency: 6 }, () => {
  for (const [, define] of groups) define();
});
