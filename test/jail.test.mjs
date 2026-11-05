// Yard code is written by a model, so it runs confined. These tests run real hostile code in the
// real sandbox, and every test proves the sandbox from the inside. Only sentinels are used.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../engine/config.mjs';
import { createPreviewManager } from '../engine/gate/preview.mjs';
import { JailError, createJail, jailAvailable, jailProfile, startEgress } from '../engine/gate/jail.mjs';
import { redact } from '../engine/gate/redact.mjs';
import { freePort, listensWide, runCommand, startServer, yardEnv } from '../engine/gate/util.mjs';
import { runGate } from '../engine/gate/index.mjs';
import { createStore } from '../engine/store.mjs';
import { makeYard, read, sharedBrowser, write } from './gate-helpers.mjs';
import { testDir } from './helpers.mjs';
import { sleep } from './stub-gate.mjs';
import { until } from './worker-support.mjs';

const UTIL = fileURLToPath(new URL('../engine/gate/util.mjs', import.meta.url));
const JAIL = fileURLToPath(new URL('../engine/gate/jail.mjs', import.meta.url));
const TOKEN = `ghp_${'a1B2'.repeat(10)}`;

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

function bench(t, { ports = [] } = {}) {
  const root = testDir(t);
  const config = loadConfig({ root });
  const workdir = path.join(root, 'work');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(path.join(scratch, 'home'), { recursive: true });
  const env = yardEnv({ home: path.join(scratch, 'home'), ghConfigDir: path.join(scratch, 'gh') });
  return { root, config, workdir, scratch, env, jail: createJail(config, { workdir, scratch, ports }) };
}

/** Whether a process with this command line is alive. */
function running(marker) {
  return new Promise((resolve) => {
    const ps = spawn('ps', ['-axo', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (chunk) => { out += chunk; });
    ps.on('close', () => resolve(out.split('\n').some((line) => line.startsWith(marker))));
  });
}

test('the machine this runs on has a working sandbox', () => {
  assert.equal(jailAvailable(), true);
});

test('with no sandbox, nothing runs at all', async (t) => {
  const { config, workdir, scratch, env } = bench(t);
  assert.throws(() => createJail({ ...config, sandboxBin: '/nonexistent/sandbox-exec' }, { workdir, scratch }), JailError);
  await assert.rejects(runCommand('echo hi', { cwd: workdir, env }), JailError);
  await assert.rejects(startServer({ command: 'true', cwd: workdir, env, port: 1 }), JailError);
});

test('a gate on a machine with no sandbox says ERROR and runs nothing from the yard', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    contract: { test: 'touch ran-unconfined' },
  });
  const config = { ...loadConfig({ root }), sandboxBin: '/nonexistent/sandbox-exec' };
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config, browser });
  assert.equal(result.verdict, 'ERROR');
  assert.match(result.steps.at(-1).detail, /sandbox/);
  assert.equal(fs.existsSync(path.join(yard, 'ran-unconfined')), false);
});

test('a command keeps its exit code, and output comes back', async (t) => {
  const { workdir, env, jail } = bench(t);
  const result = await runCommand('echo out; echo err >&2; exit 7', { jail, cwd: workdir, env });
  assert.equal(result.code, 7);
  assert.equal(result.ok, false);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
});

test('code in a jail cannot read, write or reach anything of the host', async (t) => {
  const { root, config, workdir, env, jail } = bench(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret-sentinel.txt'), 'not-a-real-credential');
  fs.mkdirSync(path.join(config.dataDir, 'publish'), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'publish', 'approval.key'), 'fake-approval-key');
  fs.mkdirSync(config.yardsDir, { recursive: true });
  const sibling = path.join(config.yardsDir, 'ship-other');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'a.txt'), 'another ship');

  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    response.end('reached');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());

  write(workdir, 'evil.mjs', `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import dns from 'node:dns/promises';
    import { execSync } from 'node:child_process';
    const attempt = async (name, work) => { try { out[name] = await work(); } catch (error) { out[name] = 'refused:' + (error.cause?.code ?? error.code ?? error.message); } };
    const out = {};
    await attempt('sentinel', () => fs.readFileSync(${JSON.stringify(path.join(outside, 'secret-sentinel.txt'))}, 'utf8'));
    await attempt('key', () => fs.readFileSync(${JSON.stringify(path.join(config.dataDir, 'publish', 'approval.key'))}, 'utf8'));
    await attempt('sibling', () => fs.readFileSync(${JSON.stringify(path.join(sibling, 'a.txt'))}, 'utf8'));
    await attempt('engine', () => fs.readdirSync(${JSON.stringify(path.join(root, '..', '..', '..', 'engine'))}));
    await attempt('home', () => fs.readdirSync(os.userInfo().homedir));
    await attempt('write', () => fs.writeFileSync(${JSON.stringify(path.join(outside, 'written.txt'))}, 'x'));
    await attempt('doctrine', () => fs.appendFileSync(${JSON.stringify(path.join(root, '..', '..', '..', 'engine', 'doctrine', 'common.md'))}, 'x'));
    await attempt('loopback', () => fetch('http://127.0.0.1:${server.address().port}/from-the-yard').then((r) => r.text()));
    await attempt('internet', () => fetch('https://example.com/').then((r) => r.status));
    await attempt('dns', () => dns.lookup('example.com'));
    await attempt('open', () => execSync('open -g /System/Applications/Calculator.app 2>&1; echo $?', { encoding: 'utf8' }));
    await attempt('keychain', () => execSync('security list-keychains 2>&1', { encoding: 'utf8' }));
    fs.writeFileSync('report.json', JSON.stringify(out));
  `);
  const result = await runCommand('node evil.mjs', { jail, cwd: workdir, env });
  assert.equal(result.code, 0, result.tail);
  const report = JSON.parse(read(workdir, 'report.json'));
  for (const name of ['sentinel', 'key', 'sibling', 'engine', 'home', 'write', 'doctrine', 'loopback', 'internet', 'dns']) {
    assert.match(String(report[name]), /^refused:/, `${name} answered ${report[name]}`);
  }
  assert.doesNotMatch(report.open, /^0\s*$/m, 'launch services must not open an app');
  assert.doesNotMatch(report.keychain, /\.keychain/, 'the keychain must stay out of reach');
  assert.deepEqual(seen, []);
  assert.equal(fs.existsSync(path.join(outside, 'written.txt')), false);
});

test('a jail can serve and reach its own port, and a server on every interface is caught', async (t) => {
  const free = await freePort();
  const { workdir, env, jail } = bench(t, { ports: [free] });
  write(workdir, 'serve.mjs', `
    import http from 'node:http';
    const server = http.createServer((q, r) => r.end('own port')).listen(${free}, '127.0.0.1', async () => {
      console.log(await (await fetch('http://127.0.0.1:${free}/')).text());
      server.close();
      server.closeAllConnections();
    });
  `);
  const result = await runCommand('node serve.mjs', { jail, cwd: workdir, env });
  assert.equal(result.code, 0, result.tail);
  assert.match(result.stdout, /own port/);

  const wide = http.createServer().listen(0, '0.0.0.0');
  await new Promise((resolve) => { wide.once('listening', resolve); });
  t.after(() => wide.close());
  assert.equal(await listensWide(wide.address().port), true);
  const near = http.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => { near.once('listening', resolve); });
  t.after(() => near.close());
  assert.equal(await listensWide(near.address().port), false);
});

test('a detached process does not outlive its job, and bystanders are left alone', async (t) => {
  const { workdir, env, jail } = bench(t);
  const bystander = spawn('sleep', ['93.31'], { stdio: 'ignore' });
  t.after(() => bystander.kill('SIGKILL'));
  write(workdir, 'daemon.mjs', `
    import { spawn } from 'node:child_process';
    spawn('sleep', ['93.32'], { detached: true, stdio: 'ignore' }).unref();
    spawn('nohup', ['sleep', '93.33'], { detached: true, stdio: 'ignore' }).unref();
    console.log('left two behind');
  `);
  const result = await runCommand('node daemon.mjs', { jail, cwd: workdir, env });
  assert.equal(result.code, 0, result.tail);
  await sleep(100);
  assert.equal(await running('sleep 93.32'), false);
  assert.equal(await running('sleep 93.33'), false);
  assert.equal(await running('sleep 93.31'), true, 'a process outside the job is not touched');
});

test('a command past its time is killed, however it tries to hang on', async (t) => {
  const { workdir, env, jail } = bench(t);
  const result = await runCommand("trap '' TERM HUP INT; sleep 93.34 & wait", { jail, cwd: workdir, env, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(await running('sleep 93.34'), false);
});

test('jobs and servers die with a host that is killed outright', async (t) => {
  const root = testDir(t);
  const workdir = path.join(root, 'work');
  fs.mkdirSync(path.join(root, 'scratch/home'), { recursive: true });
  fs.mkdirSync(workdir);
  write(workdir, 'serve.cjs', "require('http').createServer((q, r) => r.end('ok')).listen(process.env.PORT, process.env.HOST);\n");
  const port = await freePort();
  const host = path.join(root, 'host.mjs');
  fs.writeFileSync(host, `
    import { runCommand, startServer } from ${JSON.stringify(UTIL)};
    import { createJail } from ${JSON.stringify(JAIL)};
    const scratch = ${JSON.stringify(path.join(root, 'scratch'))};
    const workdir = ${JSON.stringify(workdir)};
    const jail = createJail({}, { workdir, scratch, ports: [${port}] });
    runCommand('sleep 93.35', { jail, cwd: workdir, env: process.env });
    const server = await startServer({ jail, command: 'node serve.cjs', cwd: workdir, env: process.env, port: ${port}, timeoutMs: 8000 });
    process.stdout.write('UP ' + server.up + ' ' + server.last + '\\n');
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [host], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  const line = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(String(chunk)));
    child.once('exit', (code) => reject(new Error(`The host exited with ${code}`)));
  });
  child.removeAllListeners('exit');
  assert.match(line, /UP true/);
  assert.equal(await running('sleep 93.35'), true);
  child.kill('SIGKILL');
  await new Promise((resolve) => { child.once('close', resolve); });
  await sleep(300);
  assert.equal(await running('sleep 93.35'), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
});

test('the network allowlist goes through one port, and only by name', async (t) => {
  const egress = await startEgress(['registry.example.invalid']);
  t.after(() => egress.close());
  const { default: net } = await import('node:net');
  const ask = (target) => new Promise((resolve) => {
    const socket = net.connect(egress.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0]); socket.destroy(); });
    socket.once('error', () => resolve('socket error'));
    socket.once('close', () => resolve('closed'));
  });
  assert.match(await ask('evil.example.com:443'), /403/);
  assert.match(await ask('registry.example.invalid:22'), /403/);
  const plain = await fetch(`http://127.0.0.1:${egress.port}/`);
  assert.equal(plain.status, 403);
});

test('a jail profile holds the host and credentials shut', () => {
  const profile = jailProfile({ workdir: '/Users/x/yards/a', scratch: '/Users/x/data/s', hidden: ['/Users/x/data'], ports: [5000], home: '/Users/x', env: { PATH: '/usr/bin' } });
  assert.match(profile, /\(deny file-read-data[^\n]*"\/Users\/x"/);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /localhost:5000/);
  assert.match(profile, /\(allow signal \(target same-sandbox\)\)/);
  assert.doesNotMatch(profile, /com\.apple\.SecurityServer|launchservices/i);
});

test('the hostile yard from the review gets nowhere through the real gate', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    contract: { test: 'node evil.mjs', minTests: 0 },
    before: (dir) => write(dir, 'evil.mjs', `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      spawn('sleep', ['93.36'], { detached: true, stdio: 'ignore' }).unref();
      const seen = process.env.HOME.includes('.scratch') ? 'scratch home' : 'real home';
      fs.writeFileSync('report.txt', seen);
    `),
  });
  const config = loadConfig({ root });
  const controller = new AbortController();
  await runGate({
    yard, contract, contractHash, evidenceDir, config, browser, signal: controller.signal,
    onStep: (step) => { if (step.step === 'test') controller.abort(); },
  });
  assert.equal(read(yard, 'report.txt'), 'scratch home');
  await sleep(100);
  assert.equal(await running('sleep 93.36'), false, 'the daemon died with the step that started it');
});

test('secrets in command output reach no log, no step and no evidence', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    contract: { test: `echo ${TOKEN}; exit 1` },
  });
  const details = [];
  const config = loadConfig({ root });
  const result = await runGate({
    yard, contract, contractHash, evidenceDir, config, browser, onStep: (step) => details.push(JSON.stringify(step)),
  });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(details.join('').includes(TOKEN), false, 'gate.step would put it on the feed');
  for (const file of fs.readdirSync(evidenceDir)) {
    if (file.endsWith('.log') || file.endsWith('.json')) assert.equal(read(evidenceDir, file).includes(TOKEN), false, file);
  }
  assert.match(read(evidenceDir, 'test.log'), /\[github secret removed\]/);
  assert.match(redact(`x ${TOKEN} y`), /^x \[github secret removed\] y$/);
});

test('a log that cannot be written is a host fault, and it does not take the host down', async (t) => {
  const { workdir, env, jail } = bench(t);
  const result = await runCommand('echo hi', { jail, cwd: workdir, env, logFile: '/nonexistent-dir/x.log' });
  assert.equal(result.code, 0);
  assert.equal(result.ok, false);
  assert.match(result.hostFault, /could not write/);
});

test('a gate on a nearly full disk says ERROR, which costs no repair', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t);
  const config = { ...loadConfig({ root }), minFreeBytes: Number.MAX_SAFE_INTEGER };
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config, browser });
  assert.equal(result.verdict, 'ERROR');
  assert.match(result.steps.at(-1).detail, /disk/i);
});

test('a preview stopped while it is starting never comes up', async (t) => {
  const dir = testDir(t);
  const root = path.join(dir, 'tree');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'slow.mjs'), `import http from 'node:http';
setTimeout(() => http.createServer((q, s) => s.end('hi')).listen(process.env.PORT, process.env.HOST), 800);`);
  const store = createStore({ path: ':memory:' });
  t.after(() => store.close());
  store.append({ type: 'ship.created', shipId: 's1', data: { idea: 'x' } });
  const config = loadConfig({ root: dir, port: 45310 + Math.floor(Math.random() * 400) });
  const previews = createPreviewManager({ config, store });
  const starting = previews.start({ shipId: 's1', root, contract: { start: 'node slow.mjs' } });
  await sleep(250);
  assert.equal(await previews.stop('s1'), true);
  assert.equal(await starting, null);
  assert.equal(store.state().ships.s1.preview ?? null, null);
  assert.equal(previews.list().length, 0);
});

test('a preview that floods its log is capped, stopped, and says so', async (t) => {
  const dir = testDir(t);
  const root = path.join(dir, 'tree');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'chat.mjs'), `import http from 'node:http';
http.createServer((q, s) => s.end('hi')).listen(process.env.PORT, process.env.HOST);
const b = 'x'.repeat(1 << 20); const go = () => process.stdout.write(b, () => setImmediate(go)); go();`);
  const store = createStore({ path: ':memory:' });
  t.after(() => store.close());
  store.append({ type: 'ship.created', shipId: 's1', data: { idea: 'x' } });
  const limit = 2 * 1024 * 1024;
  const config = loadConfig({ root: dir, port: 45710 + Math.floor(Math.random() * 400), previewLogBytes: limit });
  const previews = createPreviewManager({ config, store });
  t.after(() => previews.stopAll());
  await previews.start({ shipId: 's1', root, contract: { start: 'node chat.mjs' } }).catch(() => null);
  await until(() => previews.list().length === 0, { timeoutMs: 8000, what: 'the preview to be stopped' });
  assert.ok(fs.statSync(path.join(dir, 'data/previews/s1/preview.log')).size < limit * 1.5);
  assert.ok(store.events({ types: ['bell.rung'] }).some((event) => /writing too much/.test(event.data.reason)));
});
