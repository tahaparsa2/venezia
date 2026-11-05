// LAN mode: certificates, pairing, and every request refused without a paired device.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';
import { promisify } from 'node:util';

import WebSocket from 'ws';

import { checkHeaders, createPairing, readCookie } from '../engine/net/auth.mjs';
import { ensureCertificates, mobileConfig } from '../engine/net/certs.mjs';
import { readSurfaceKey } from '../engine/net/client.mjs';
import { LAN_NAME, lanAddresses, publishName } from '../engine/net/mdns.mjs';
import { qrSvg, qrTerminal } from '../engine/net/qr.mjs';
import { REPO, testDir } from './helpers.mjs';
import { raw, serve, stubEngine } from './net.helpers.mjs';

const run = promisify(execFile);
const openssl = async (args) => (await run('openssl', args)).stdout;

function fakeSpawn() {
  const spawned = [];
  const fake = (bin, args) => {
    const child = new EventEmitter();
    child.bin = bin;
    child.args = args.slice(3);
    child.stdin = {
      on() {},
      destroy() {},
      end() {
        child.killed = true;
        child.emit('close', 0, null);
      },
    };
    spawned.push(child);
    return child;
  };
  return { spawn: fake, spawned };
}

/* --------------------------------------------------------------------- certificates */

test('the root is a name-constrained CA, the leaf meets Apple\'s rules', async (t) => {
  const dir = testDir(t);
  const made = await ensureCertificates({ dir, hosts: [LAN_NAME, 'localhost'], ips: ['10.20.30.40', '127.0.0.1'] });
  assert.equal(made.issued, true);

  const root = await openssl(['x509', '-in', path.join(dir, 'ca.crt'), '-noout', '-text']);
  assert.match(root, /CA:TRUE, pathlen:0/);
  assert.match(root, /Name Constraints: critical/);
  assert.match(root, /DNS:local/);
  assert.match(root, /IP:192\.168\.0\.0\/255\.255\.0\.0/);

  const leaf = await openssl(['x509', '-in', path.join(dir, 'leaf.crt'), '-noout', '-text']);
  assert.match(leaf, /CA:FALSE/);
  assert.match(leaf, /TLS Web Server Authentication/);
  assert.match(leaf, /DNS:venezia\.local/);
  assert.match(leaf, /IP Address:10\.20\.30\.40/);
  assert.match(leaf, /ecdsa-with-SHA256/);

  const dates = await openssl(['x509', '-in', path.join(dir, 'leaf.crt'), '-noout', '-enddate']);
  const days = (Date.parse(dates.split('=')[1]) - Date.now()) / 86_400_000;
  assert.ok(days <= 825, 'iOS refuses a leaf longer than 825 days');

  assert.match(await openssl(['verify', '-CAfile', path.join(dir, 'ca.crt'), path.join(dir, 'leaf.crt')]), /OK/);
});

test('the root cannot vouch for a public name, even with its own key', async (t) => {
  const dir = testDir(t);
  await ensureCertificates({ dir, hosts: [LAN_NAME], ips: [] });
  const file = (name) => path.join(dir, name);
  fs.writeFileSync(file('evil.cnf'), '[v]\nsubjectAltName = DNS:bank.example\nextendedKeyUsage = serverAuth\n');
  await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('evil.key')]);
  await openssl(['req', '-new', '-key', file('evil.key'), '-subj', '/CN=bank.example', '-config', file('ca.cnf'), '-out', file('evil.csr')]);
  await openssl(['x509', '-req', '-sha256', '-days', '30', '-in', file('evil.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
    '-set_serial', '7', '-extfile', file('evil.cnf'), '-extensions', 'v', '-out', file('evil.crt')]);
  await assert.rejects(
    openssl(['verify', '-CAfile', file('ca.crt'), file('evil.crt')]),
    /permitted subtree violation|name constraint/i,
  );
});

test('keys are private, and a second call reuses what is good', async (t) => {
  const dir = testDir(t);
  const first = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: ['10.20.30.40'] });
  assert.equal(fs.statSync(path.join(dir, 'ca.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'leaf.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const second = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: ['10.20.30.40'] });
  assert.equal(second.issued, false);
  assert.equal(second.cert, first.cert);
});

test('a new address gets a new leaf under the same root, so the phone stays trusted', async (t) => {
  const dir = testDir(t);
  const first = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: ['10.20.30.40'] });
  const second = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: ['10.0.0.77'] });
  assert.equal(second.issued, true);
  assert.equal(second.ca, first.ca);
  assert.notEqual(second.cert, first.cert);
});

test('an expiring leaf is renewed', async (t) => {
  const dir = testDir(t);
  const first = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: [] });
  const later = await ensureCertificates({ dir, hosts: [LAN_NAME], ips: [], now: () => Date.now() + 380 * 86_400_000 });
  assert.equal(later.ca, first.ca);
  assert.notEqual(later.cert, first.cert);
});

test('macOS system LibreSSL makes the same chain', { skip: !fs.existsSync('/usr/bin/openssl') }, async (t) => {
  const dir = testDir(t);
  await ensureCertificates({ dir, hosts: [LAN_NAME], ips: ['10.20.30.40'], opensslBin: '/usr/bin/openssl' });
  assert.match(await openssl(['verify', '-CAfile', path.join(dir, 'ca.crt'), path.join(dir, 'leaf.crt')]), /OK/);
});

test('Apple\'s own trust check accepts the chain for our name and refuses another', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = testDir(t);
  await ensureCertificates({ dir, hosts: [LAN_NAME], ips: [] });
  const verify = (host) => run('security', ['verify-cert', '-c', path.join(dir, 'leaf.crt'), '-r', path.join(dir, 'ca.crt'), '-p', 'ssl', '-s', host]);
  assert.match((await verify(LAN_NAME)).stdout + (await verify(LAN_NAME)).stderr, /verification successful/);
  await assert.rejects(verify('evil.example'));
});

test('the iOS profile carries the root', async (t) => {
  const { ca } = await ensureCertificates({ dir: testDir(t), hosts: [LAN_NAME], ips: [] });
  const profile = mobileConfig(ca);
  assert.match(profile, /com\.apple\.security\.root/);
  assert.match(profile, /<data>[A-Za-z0-9+/=]+<\/data>/);
  assert.equal(profile, mobileConfig(ca), 'the same root gives the same profile, so a reinstall replaces it');
});

/* --------------------------------------------------------------------------- pairing */

function pairingFor(t, options = {}) {
  return createPairing({ file: path.join(testDir(t), 'devices.json'), ...options });
}

test('a token works once', (t) => {
  const pairing = pairingFor(t);
  const { token } = pairing.start();
  assert.ok(Buffer.from(token, 'base64url').length >= 16, 'at least 128 bits');
  const claim = pairing.claim({ token, name: 'iPhone' });
  assert.equal(claim.ok, true);
  assert.equal(pairing.verify(claim.secret).name, 'iPhone');
  assert.equal(pairing.claim({ token }).status, 410);
});

test('a PIN works once, and five wrong tries burn the pairing', (t) => {
  const pairing = pairingFor(t);
  const { pin } = pairing.start();
  assert.match(pin, /^\d{6}$/);
  const wrong = pin === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++) assert.equal(pairing.claim({ pin: wrong, ip: `10.0.0.${i}` }).status, 403);
  assert.equal(pairing.claim({ pin, ip: '10.0.0.9' }).ok, true, 'the fifth try can still be right');

  const again = pairing.start();
  const other = again.pin === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) pairing.claim({ pin: other, ip: `10.0.0.${i}` });
  assert.equal(pairing.claim({ pin: again.pin, ip: '10.0.0.9' }).status, 410);
});

test('one address is locked out after ten wrong tries across pairings', (t) => {
  const pairing = pairingFor(t);
  for (let i = 0; i < 2; i++) {
    const { pin } = pairing.start();
    const wrong = pin === '000000' ? '000001' : '000000';
    for (let j = 0; j < 5; j++) pairing.claim({ pin: wrong, ip: '10.0.0.5' });
  }
  const { token } = pairing.start();
  assert.equal(pairing.claim({ token, ip: '10.0.0.5' }).status, 429);
  assert.equal(pairing.claim({ token, ip: '10.0.0.6' }).ok, true);
});

test('a pairing expires', (t) => {
  let clock = 1000;
  const pairing = pairingFor(t, { now: () => clock, ttlMs: 500 });
  const { token } = pairing.start();
  clock += 501;
  assert.equal(pairing.claim({ token }).status, 410);
});

test('a new pairing replaces the old one', (t) => {
  const pairing = pairingFor(t);
  const first = pairing.start();
  const second = pairing.start();
  assert.equal(pairing.claim({ token: first.token }).status, 403);
  assert.equal(pairing.claim({ token: second.token }).ok, true);
});

test('only a hash of the session is stored, the file is private, and devices survive a restart', (t) => {
  const dir = testDir(t);
  const file = path.join(dir, 'devices.json');
  const pairing = createPairing({ file });
  const { secret, device } = pairing.claim({ token: pairing.start().token, name: 'iPad' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(secret));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reopened = createPairing({ file });
  assert.equal(reopened.verify(secret).id, device.id);
  assert.deepEqual(reopened.list().map((entry) => entry.name), ['iPad']);
  assert.equal(Object.hasOwn(reopened.list()[0], 'hash'), false);
  assert.equal(reopened.revoke(device.id), true);
  assert.equal(reopened.verify(secret), null);
  assert.equal(reopened.revoke(device.id), false);
});

test('the session cookie cannot be read by script or sent elsewhere', (t) => {
  const cookie = pairingFor(t).cookie('abc');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.match(cookie, new RegExp(flag));
});

test('header checks', () => {
  const allowed = { hosts: new Set(['a:1']), origins: new Set(['https://a:1']) };
  const request = (headers, method = 'GET') => ({ headers, method });
  assert.equal(checkHeaders(request({ host: 'a:1' }), allowed), null);
  assert.equal(checkHeaders(request({ host: 'A:1', origin: 'HTTPS://A:1' }), allowed), null);
  assert.equal(checkHeaders(request({}), allowed).status, 421);
  assert.equal(checkHeaders(request({ host: 'a:1', origin: 'https://b:1' }), allowed).status, 403);
  assert.equal(checkHeaders(request({ host: 'a:1' }), { ...allowed, requireOrigin: true }).status, 403);
  assert.equal(checkHeaders(request({ host: 'a:1', 'sec-fetch-site': 'same-site' }), allowed).status, 403);
  assert.equal(readCookie('a=1; vz_session=abc=; b=2', 'vz_session'), 'abc=');
  assert.equal(readCookie(undefined, 'vz_session'), null);
});

test('a QR code encodes something and fits a terminal', () => {
  assert.match(qrSvg('https://venezia.local:8443/pair#t=abc'), /^<svg /);
  const lines = qrTerminal('https://venezia.local:8443/pair#t=abc').split('\n');
  assert.ok(lines.length > 10);
  assert.ok(lines.every((line) => line.length === lines[0].length));
});

/* --------------------------------------------------------------------------- the name */

test('addresses are private IPv4, Wi-Fi first', () => {
  const ip = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });
  assert.deepEqual(lanAddresses({
    lo0: [ip('127.0.0.1', { internal: true })],
    utun3: [ip('100.64.1.1'), ip('10.8.0.2')],
    en1: [ip('172.20.0.4'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    en0: [ip('192.168.1.20')],
    en5: [ip('8.8.8.8'), ip('172.32.0.1')],
  }), ['192.168.1.20', '172.20.0.4', '10.8.0.2']);
});

test('dns-sd runs with the exact arguments, restarts, moves, and stops', async () => {
  const fake = fakeSpawn();
  const { spawned } = fake;
  const name = publishName({ port: 8443, ip: '10.20.30.40', spawn: fake.spawn, restartMs: 5 });
  assert.deepEqual(spawned[0].args, ['dns-sd', '-P', 'Venezia', '_https._tcp', 'local', '8443', 'venezia.local', '10.20.30.40']);

  spawned[0].emit('close', 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawned.length, 2, 'restarted after it died');

  name.setIp('10.0.0.41');
  assert.equal(spawned[1].killed, true);
  assert.equal(spawned[2].args.at(-1), '10.0.0.41');
  name.setIp('10.0.0.41');
  assert.equal(spawned.length, 3, 'the same address changes nothing');

  name.stop();
  assert.equal(spawned[2].killed, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawned.length, 3, 'stays stopped');
});

test('a missing dns-sd is reported, not fatal', async () => {
  const lines = [];
  const name = publishName({
    port: 1, ip: '10.0.0.1', bin: '/nonexistent/dns-sd', restartMs: 100000, log: (line) => lines.push(line),
  });
  for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  name.stop();
  assert.match(lines.join(), /Could not publish/);
});

/** A stand-in for dns-sd: records its pid, then runs until told otherwise. */
function fakeDaemon(dir) {
  const bin = path.join(dir, 'fake-dns-sd');
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ > "${dir}/daemon.pid"\nexec sleep 30\n`, { mode: 0o755 });
  return bin;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function daemonPid(dir) {
  const file = path.join(dir, 'daemon.pid');
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return Number(fs.readFileSync(file, 'utf8'));
}

async function goneSoon(pid) {
  for (let i = 0; i < 300 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return !alive(pid);
}

test('stop really stops the daemon', async (t) => {
  const dir = testDir(t);
  const name = publishName({ port: 1, ip: '10.0.0.1', bin: fakeDaemon(dir) });
  const pid = await daemonPid(dir);
  assert.ok(alive(pid));
  name.stop();
  assert.ok(await goneSoon(pid), 'the daemon outlived stop()');
});

test('a server killed outright leaves no daemon behind', async (t) => {
  const dir = testDir(t);
  const bin = fakeDaemon(dir);
  const module = path.join(REPO, 'engine/net/mdns.mjs');
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { publishName } from ${JSON.stringify(module)};
    publishName({ port: 1, ip: '10.0.0.1', bin: ${JSON.stringify(bin)} });
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  const pid = await daemonPid(dir);
  assert.ok(alive(pid));
  server.kill('SIGKILL');
  assert.ok(await goneSoon(pid), 'the daemon outlived its server');
});

/* ---------------------------------------------------------------------- the LAN server */

async function lanServer(t, extra = {}) {
  const fake = fakeSpawn();
  const started = await serve(t, {
    engine: extra.engine,
    lan: true,
    lanPort: 0,
    addresses: extra.addresses ?? (() => ['10.1.2.3']),
    mdns: { spawn: fake.spawn },
    web: { 'index.html': '<title>home</title>' },
    log: () => {},
    ...extra.options,
  });
  const { server, engine } = started;
  const port = server.lanPort;
  const ask = (options) => raw({
    port,
    secure: true,
    ca: server.lanCa,
    servername: LAN_NAME,
    ...options,
    headers: { host: `${LAN_NAME}:${port}`, ...options.headers },
  });
  return {
    ...started, lanPort: port, ask, spawned: fake.spawned, engine,
  };
}

test('LAN mode serves HTTPS with a certificate the phone can verify, and publishes the name', async (t) => {
  const { ask, server, spawned, lanPort } = await lanServer(t);
  assert.equal(server.lanUrl, `https://${LAN_NAME}:${lanPort}`);
  assert.equal((await ask({ path: '/pair' })).status, 200);
  assert.deepEqual(spawned[0].args.slice(-3), [String(lanPort), LAN_NAME, '10.1.2.3']);
  await assert.rejects(raw({ port: lanPort, secure: true, servername: LAN_NAME, path: '/pair' }), /self-signed|unable to verify|issuer/i, 'an untrusted client sees a real TLS failure');
});

test('nothing but the pairing pages answers without a paired device', async (t) => {
  const engine = stubEngine(t);
  const { ask, lanPort } = await lanServer(t, { engine });
  const unpaired = [
    '/api/state', '/api/events?since=0', '/sse', '/llms.txt', '/api/lessons', '/evidence/a/b/c.png', '/api/say?text=hi', '/shared/sim.mjs',
  ];
  for (const target of unpaired) assert.equal((await ask({ path: target })).status, 401, target);

  const page = await ask({ path: '/', headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/pair');

  const command = await ask({
    path: '/api/command',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${LAN_NAME}:${lanPort}` },
    body: '{"type":"ship.create","idea":"x"}',
  });
  assert.equal(command.status, 401);
  assert.deepEqual(engine.commands, []);

  assert.equal((await ask({ path: '/pair/ca.crt' })).status, 200);
  assert.match((await ask({ path: '/pair/venezia.mobileconfig' })).headers['content-type'], /aspen-config/);
});

test('pair by QR token: the cookie opens everything, and only over HTTPS', async (t) => {
  const engine = stubEngine(t);
  const { ask, server, lanPort } = await lanServer(t, { engine });
  const { url, ipUrl, pin, fingerprint, qrSvg: svg, qrText } = server.startPairing();
  assert.match(url, new RegExp(`^https://venezia\\.local:${lanPort}/pair#t=`));
  assert.match(ipUrl, /^https:\/\/10\.1\.2\.3:/);
  assert.match(pin, /^\d{6}$/);
  assert.match(fingerprint, /^[0-9A-F:]+$/);
  assert.match(svg, /<svg/);
  assert.ok(qrText.length > 100);

  const token = url.split('#t=')[1];
  const origin = `https://${LAN_NAME}:${lanPort}`;
  const claim = await ask({
    path: '/api/pair/claim',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token, name: 'iPhone' }),
  });
  assert.equal(claim.status, 200);
  assert.deepEqual(Object.keys(claim.json), ['ok', 'device']);
  const [cookie] = claim.headers['set-cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);

  const session = cookie.split(';')[0];
  assert.equal((await ask({ path: '/api/state', headers: { cookie: session } })).status, 200);
  assert.match((await ask({ path: '/', headers: { cookie: session } })).text, /home/);
  const command = await ask({
    path: '/api/command',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie: session },
    body: '{"type":"ship.create","idea":"From the phone"}',
  });
  assert.equal(command.status, 200);
  assert.equal(engine.commands[0].idea, 'From the phone');

  const replay = await ask({
    path: '/api/pair/claim', method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }),
  });
  assert.equal(replay.status, 410, 'a token works once');

  const socket = new WebSocket(`wss://127.0.0.1:${lanPort}/ws`, {
    ca: server.lanCa, servername: LAN_NAME, headers: { host: `${LAN_NAME}:${lanPort}`, origin, cookie: session },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.terminate();

  const [{ id }] = server.pairing.list();
  server.pairing.revoke(id);
  assert.equal((await ask({ path: '/api/state', headers: { cookie: session } })).status, 401, 'revoked at once');
});

test('pair by PIN, and the fragment token never reaches the server', async (t) => {
  const { ask, server, lanPort } = await lanServer(t);
  const { pin } = server.startPairing();
  const origin = `https://${LAN_NAME}:${lanPort}`;
  const page = await ask({ path: '/pair' });
  assert.match(page.text, /location\.hash/);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.doesNotMatch(page.text, new RegExp(pin));
  const claim = await ask({
    path: '/api/pair/claim', method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ pin }),
  });
  assert.equal(claim.status, 200);
});

test('a claim needs a same-origin browser POST', async (t) => {
  const { ask, server } = await lanServer(t);
  const { token } = (() => {
    const pairing = server.startPairing();
    return { token: pairing.url.split('#t=')[1] };
  })();
  const body = JSON.stringify({ token });
  const json = { 'content-type': 'application/json' };
  assert.equal((await ask({ path: '/api/pair/claim', method: 'POST', headers: json, body })).status, 403);
  assert.equal((await ask({
    path: '/api/pair/claim', method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body,
  })).status, 403);
});

test('an unpaired WebSocket is refused on the LAN, and so is a paired one from another site', async (t) => {
  const { server, lanPort } = await lanServer(t);
  const attempt = (headers) => new Promise((resolve) => {
    const socket = new WebSocket(`wss://127.0.0.1:${lanPort}/ws`, {
      ca: server.lanCa, servername: LAN_NAME, headers: { host: `${LAN_NAME}:${lanPort}`, ...headers },
    });
    socket.once('open', () => { socket.terminate(); resolve('open'); });
    socket.once('unexpected-response', (request, response) => { request.destroy(); resolve(response.statusCode); });
    socket.once('error', (error) => resolve(error.message));
  });
  assert.equal(await attempt({ origin: `https://${LAN_NAME}:${lanPort}` }), 401);
  assert.equal(await attempt({ origin: 'https://evil.example' }), 403);
  assert.equal(await attempt({}), 403);
});

test('a claim that is not an object is refused, not a crash', async (t) => {
  const { ask, server, lanPort } = await lanServer(t);
  server.startPairing();
  for (const body of ['null', '3', '[]', '{"token":5,"pin":false}']) {
    const response = await ask({
      path: '/api/pair/claim', method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${LAN_NAME}:${lanPort}` }, body,
    });
    assert.equal(response.status, 403, body);
  }
});

test('a LAN Host outside the list is refused, and loopback pairing routes do not exist there', async (t) => {
  const { ask, lanPort } = await lanServer(t);
  assert.equal((await ask({ path: '/pair', headers: { host: `evil.example:${lanPort}` } })).status, 421);
  const start = await ask({
    path: '/api/pair/start', method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${LAN_NAME}:${lanPort}` },
  });
  assert.equal(start.status, 401, 'no phone can start a pairing');
});

test('pairing starts from the Mac over loopback, and devices are managed there', async (t) => {
  const engine = stubEngine(t);
  const { port, server, ask, lanPort } = await lanServer(t, { engine });
  const cli = { 'x-venezia-surface': 'cli', 'x-venezia-key': readSurfaceKey(engine.config) };
  const started = await raw({ port, path: '/api/pair/start', method: 'POST', headers: cli });
  assert.equal(started.status, 200);
  const claim = await ask({
    path: '/api/pair/claim',
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${LAN_NAME}:${lanPort}` },
    body: JSON.stringify({ pin: started.json.pin, name: 'Pixel' }),
  });
  assert.equal(claim.status, 200);
  const devices = (await raw({ port, path: '/api/devices', headers: cli })).json;
  assert.equal(devices[0].name, 'Pixel');
  const revoke = await raw({
    port, path: '/api/devices/revoke', method: 'POST', headers: { 'content-type': 'application/json', ...cli }, body: JSON.stringify({ id: devices[0].id }),
  });
  assert.equal(revoke.status, 200);
  assert.deepEqual(server.pairing.list(), []);
  assert.equal((await raw({
    port, path: '/api/devices/revoke', method: 'POST', headers: { 'content-type': 'application/json', ...cli }, body: '{"id":"nope"}',
  })).status, 404);
});

test('an address change reissues the leaf and republishes the name, with no restart', async (t) => {
  let addresses = ['10.1.2.3'];
  const { ask, spawned, server, lanPort } = await lanServer(t, {
    addresses: () => addresses,
    options: { watchMs: 15 },
  });
  addresses = ['10.9.9.9'];
  for (let i = 0; i < 100 && spawned.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawned.at(-1).args.at(-1), '10.9.9.9');
  const page = await raw({
    port: lanPort, secure: true, ca: server.lanCa, servername: LAN_NAME, path: '/pair', headers: { host: `10.9.9.9:${lanPort}` },
  });
  assert.equal(page.status, 200);
  const peer = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: lanPort, ca: server.lanCa, servername: LAN_NAME }, () => {
      resolve(socket.getPeerX509Certificate());
      socket.destroy();
    });
    socket.once('error', reject);
  });
  assert.equal(peer.checkIP('10.9.9.9'), '10.9.9.9', 'the live server took the new leaf');
  assert.equal((await ask({ path: '/pair', headers: { host: `10.1.2.3:${lanPort}` } })).status, 421, 'the old address no longer answers');
});
