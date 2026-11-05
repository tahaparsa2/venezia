import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { createHostSim, profileFor } from '../engine/gate/hostsim.mjs';
import { write } from './gate-helpers.mjs';
import { testDir } from './helpers.mjs';

/** A raw request, because `fetch` tidies away the addresses these tests need. */
const raw = (port, target, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: target, method }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  });
  request.on('error', reject);
  request.end();
});

async function site(t, profile) {
  const dir = testDir(t);
  const root = path.join(dir, 'site');
  write(root, 'index.html', 'home');
  write(root, 'Logo.svg', '<svg/>');
  write(root, 'app.js', 'js');
  write(root, 'data.wasm', 'w');
  write(root, 'sub/index.html', 'sub');
  write(root, 'empty/x.txt', 'x');
  write(dir, 'secret.txt', 'outside');
  const sim = await createHostSim({ root, profile });
  t.after(() => sim.close());
  return { sim, root, dir, port: sim.port };
}

const pages = profileFor('github-pages', { slug: 'todo' });

test('profiles are per target', () => {
  assert.deepEqual(profileFor('github-pages', { slug: 'a' }), { id: 'github-pages', base: '/venezia-sites/a/', caseSensitive: true, spaFallback: false, notFoundPage: true });
  assert.equal(profileFor('local').base, '/');
  assert.equal(profileFor('vercel').base, '/');
  assert.equal(profileFor(undefined, { slug: 'a' }).id, 'default');
  assert.equal(profileFor('no-such-target', { slug: 'a' }).base, '/a/');
  assert.equal(profileFor({ id: 'github-pages', slug: 'b' }).base, '/venezia-sites/b/');
  assert.deepEqual(
    profileFor({ base: 'x/y', caseSensitive: false, spaFallback: true }),
    { id: 'custom', base: '/x/y/', caseSensitive: false, spaFallback: true, notFoundPage: true },
  );
});

test('the site lives only under its base path', async (t) => {
  const { port, sim } = await site(t, pages);
  assert.equal(sim.url, `http://127.0.0.1:${port}/venezia-sites/todo/`);
  assert.equal((await raw(port, '/venezia-sites/todo/')).body, 'home');
  assert.equal((await raw(port, '/')).status, 404);
  assert.equal((await raw(port, '/app.js')).status, 404);
  const bare = await raw(port, '/venezia-sites/todo?x=1');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, '/venezia-sites/todo/?x=1');
});

test('case matters even on a case-insensitive disk', async (t) => {
  const { port } = await site(t, pages);
  assert.equal((await raw(port, '/venezia-sites/todo/Logo.svg')).status, 200);
  assert.equal((await raw(port, '/venezia-sites/todo/logo.svg')).status, 404);
});

test('a case-insensitive host can be asked for', async (t) => {
  const { port } = await site(t, { ...pages, caseSensitive: false });
  assert.equal((await raw(port, '/venezia-sites/todo/logo.svg')).status, 200);
});

test('no SPA fallback by default, and 404.html answers with a 404', async (t) => {
  const { port, root } = await site(t, pages);
  assert.equal((await raw(port, '/venezia-sites/todo/deep/link')).status, 404);
  write(root, '404.html', 'custom');
  const missing = await raw(port, '/venezia-sites/todo/deep/link');
  assert.equal(missing.status, 404);
  assert.equal(missing.body, 'custom');
});

test('SPA fallback answers routes, not missing files', async (t) => {
  const { port } = await site(t, { id: 'x', base: '/', caseSensitive: true, spaFallback: true });
  assert.equal((await raw(port, '/deep/link')).body, 'home');
  assert.equal((await raw(port, '/missing.png')).status, 404);
});

test('folders redirect, then serve their index, or 404 without one', async (t) => {
  const { port } = await site(t, pages);
  const redirect = await raw(port, '/venezia-sites/todo/sub?y=2');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/venezia-sites/todo/sub/?y=2');
  assert.equal((await raw(port, '/venezia-sites/todo/sub/')).body, 'sub');
  assert.equal((await raw(port, '/venezia-sites/todo/empty/')).status, 404);
});

test('nothing outside the root can be reached', async (t) => {
  const { port, root, dir } = await site(t, { id: 'x', base: '/', caseSensitive: true, spaFallback: false });
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(dir, path.join(root, 'folder'));
  for (const attempt of ['/../secret.txt', '/%2e%2e/secret.txt', '/sub/../../secret.txt', '/..%2fsecret.txt', '/link.txt', '/folder/secret.txt', '/folder/', '/%2e%2e%5csecret.txt']) {
    const response = await raw(port, attempt);
    assert.ok(response.status >= 400, attempt);
    assert.notEqual(response.body, 'outside', attempt);
  }
});

test('bad addresses and methods are refused, not fatal', async (t) => {
  const { port } = await site(t, { id: 'x', base: '/', caseSensitive: true, spaFallback: false });
  assert.equal((await raw(port, '/%E0%A4%A')).status, 400);
  assert.equal((await raw(port, '/a%00b')).status, 400);
  assert.equal((await raw(port, '/', 'POST')).status, 405);
  const head = await raw(port, '/app.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await raw(port, '/')).body, 'home', 'still serving');
});

test('files carry the right type', async (t) => {
  const { port } = await site(t, pages);
  assert.match((await raw(port, '/venezia-sites/todo/app.js')).headers['content-type'], /javascript/);
  assert.equal((await raw(port, '/venezia-sites/todo/data.wasm')).headers['content-type'], 'application/wasm');
  assert.equal((await raw(port, '/venezia-sites/todo/Logo.svg')).headers['x-content-type-options'], 'nosniff');
});
