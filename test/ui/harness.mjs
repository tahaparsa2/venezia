// Shared by the deck and card checks. `inject` puts a real event through the real store, by
// wrapping the sim in the browser, so a test can raise any decision on demand. shared/ is not
// changed: the wrapper exists only in the route below.

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
export const SHOTS = path.join(REPO, 'data/shots');

export const WRAPPER = `
import * as real from '/shared/sim-real.mjs';
export * from '/shared/sim-real.mjs';
export function createSim(options) {
  const sim = real.createSim(options);
  const listeners = [];
  const subscribe = sim.subscribe;
  sim.subscribe = (listener, more) => {
    listeners.push(listener);
    return subscribe(listener, more);
  };
  let seq = 1_000_000;
  sim.inject = (type, shipId, data) => {
    const event = { seq: ++seq, ts: Date.now(), type, shipId, actor: 'host', data };
    for (const listener of listeners) listener(event);
  };
  const injected = new Map();
  const command = sim.command;
  sim.commands = [];
  sim.command = (input, more) => {
    sim.commands.push(input);
    const id = input.id ?? input.decisionId;
    if ((input.type === 'decision.resolve' || input.type === 'ship.answer') && injected.has(id)) {
      sim.inject('decision.resolved', injected.get(id), { id, optionId: input.optionId ?? 'answered', answers: input.answers });
      return { ok: true, id };
    }
    return command(input, more);
  };
  sim.raise = (decision) => {
    injected.set(decision.id, decision.shipId);
    sim.inject('decision.opened', decision.shipId, decision);
  };
  return sim;
}`;

/** Serve the sim through the wrapper above, so a test can raise any decision. */
export async function wrapSim(page) {
  await page.route('**/shared/sim.mjs', (route) => route.fulfill({ contentType: 'text/javascript', body: WRAPPER }));
  await page.route('**/shared/sim-real.mjs', (route) => route.fulfill({
    contentType: 'text/javascript', body: fs.readFileSync(path.join(REPO, 'shared/sim.mjs')),
  }));
}

export async function open({ width = 390, height = 844, url = '/', query = '', touch = width < 700, dsf = 2, args = [], init, permissions, reducedMotion } = {}) {
  const server = await serveWeb();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dsf, hasTouch: touch, permissions, reducedMotion,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push(message.text());
  });
  await wrapSim(page);
  if (init) await page.addInitScript(init);
  await page.goto(`${server.url}${url}?demo=fleet&nosw=1&ambient=0&speed=0.001${query}`);
  await page.waitForSelector('html[data-booted]');
  const close = async () => {
    await browser.close();
    server.close();
  };
  return { page, browser, context, server, errors, close };
}

/** Clear whatever decisions the prologue left, so the injected card is on top. */
export const raise = (page, decision) => page.evaluate((d) => window.venezia.store.demo.raise(d), decision);

export async function clearInbox(page) {
  await page.evaluate(async () => {
    const { store } = window.venezia;
    for (const id of store.getLiveState().inbox) {
      const decision = store.getLiveState().decisions[id];
      store.demo.inject('decision.resolved', decision.shipId, { id, optionId: 'cleared' });
    }
  });
  await page.waitForTimeout(650);
}

export const SAMPLE = Object.freeze({
  questions: {
    id: 'd-questions', kind: 'questions', tier: 0, title: '3 questions about Aurora',
    plain: 'Pick an answer for each one, or take the recommended answers.',
    detail: { questions: [
      { id: 'audience', text: 'Who will use this?', options: [{ id: 'me', label: 'Just me', recommended: true }, { id: 'customers', label: 'Customers on their phones' }, { id: 'team', label: 'A small team' }] },
      { id: 'storage', text: 'Where should the data live?', options: [{ id: 'static', label: 'Static files, no server', recommended: true }, { id: 'browser', label: 'In the browser only' }, { id: 'server', label: 'A small server' }] },
      { id: 'look', text: 'How should it look?', options: [{ id: 'plain', label: 'Plain and fast', recommended: true }, { id: 'warm', label: 'Warm and hand made' }, { id: 'bold', label: 'Bold' }] },
    ] },
    options: [{ id: 'defaults', label: 'Use the recommended answers', recommended: true }],
  },
  contract: {
    id: 'd-contract', kind: 'contract', tier: 1, title: 'Approve the contract for Rialto?',
    plain: 'This says what done means. Each item has a check the host runs itself.',
    detail: { acceptance: [
      { text: 'The booking page loads on a 390 px phone with no sideways scroll', check: 'browser-server' },
      { text: 'A date in the past is refused', check: 'test: rejects past dates' },
      { text: 'A confirmation shows the workshop address', check: 'browser-host-sim' },
      { text: 'The built site works under /slug/ with no fallback', check: 'browser-host-sim' },
      { text: 'Nothing is stored on a server', check: 'secret-scan, test' },
    ] },
    options: [{ id: 'approve', label: 'Approve', recommended: true }, { id: 'changes', label: 'Ask for changes' }],
  },
  tool: {
    id: 'd-tool', kind: 'tool', tier: 0, title: 'Run this command?',
    plain: 'The builder wants to run a database migration.',
    detail: { tool: 'Bash', input: { command: 'npx prisma migrate deploy --schema ./db/schema.prisma' }, description: 'Apply pending migrations' },
    options: [{ id: 'allow', label: 'Allow once' }, { id: 'always', label: 'Allow for the rest of this run' }, { id: 'deny', label: 'Deny' }],
  },
  network: {
    id: 'd-network', kind: 'network', tier: 1, title: 'Allow network access?',
    plain: 'The builder wants to reach fonts.googleapis.com, which is not on the allowed list.',
    detail: { tool: 'SandboxNetworkAccess', host: 'fonts.googleapis.com' },
    options: [{ id: 'allow', label: 'Allow', recommended: true }, { id: 'always', label: 'Allow for this run' }, { id: 'deny', label: 'Refuse', danger: true }],
  },
  publish: {
    id: 'd-publish', kind: 'publish', tier: 3, title: 'Publish Aurora?', payloadHash: 'abc123',
    plain: 'This puts Aurora on the public web, on GitHub Pages.',
    detail: { target: 'github-pages', url: 'https://example.github.io/venezia-sites/aurora/', files: 14, bytes: 48211 },
    options: [{ id: 'publish', label: 'Publish', recommended: true, danger: true }, { id: 'keep', label: 'Keep it local' }],
  },
  irreversible: {
    id: 'd-irreversible', kind: 'publish', tier: 4, title: 'Replace the live site for Aurora?', payloadHash: 'def456',
    plain: 'The old pages at this address are deleted for good.',
    detail: { target: 'github-pages', url: 'https://example.github.io/venezia-sites/aurora/', files: 14, bytes: 48211 },
    options: [{ id: 'publish', label: 'Replace it', danger: true }, { id: 'cancel', label: 'Leave it alone' }],
  },
  dangerTool: {
    id: 'd-danger', kind: 'tool', tier: 4, title: 'Delete the repository?', payloadHash: 'aaa111',
    plain: 'This removes the private repository and all its history.',
    detail: { tool: 'Bash', input: { command: 'gh repo delete example/aurora --yes' } },
    options: [{ id: 'allow', label: 'Delete it', danger: true }, { id: 'deny', label: 'Keep it' }],
  },
  budget: {
    id: 'd-budget', kind: 'budget', tier: 1, title: 'This project used up its budget for the build',
    plain: 'The photo pipeline took longer than planned. Adding budget lets the builder finish. Nothing has been lost.',
    detail: { spentUsd: 4.2, limitUsd: 4 },
    options: [{ id: 'retry', label: 'Add budget and continue', recommended: true }, { id: 'stop', label: 'Stop this project', danger: true }],
  },
  gap: {
    id: 'd-gap', kind: 'gap', tier: 0, title: 'A write outside the project was refused',
    plain: 'The builder tried to write outside its project folder, so it was refused. Say what should happen instead.',
    detail: { tool: 'Write', path: '/Users/x/.config/app.json' },
    options: [{ id: 'noted', label: 'Noted' }],
  },
  lesson: {
    id: 'd-lesson', kind: 'lesson', tier: 0, title: 'Make this lesson a rule?',
    plain: 'It helped 4 of 5 projects pass first try.',
    detail: { lessonId: 'x', text: 'Keep small data sets as JSON next to the page, so the gate can test them offline.', why: 'The menu passed first try because nothing needed a server.', wins: 4, losses: 1 },
    options: [{ id: 'promote', label: 'Make it a rule', recommended: true }, { id: 'keep', label: 'Keep it as a hint' }, { id: 'burn', label: 'Throw it away', danger: true }],
  },
});
