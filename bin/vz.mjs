#!/usr/bin/env node
// vz: the headless CLI. Everything here is a client of a running server, except `serve`, which
// is that server, and `doctor`, which checks the machine. Every command takes --json.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { COMMAND_TYPES, COMMANDS } from '../shared/commands.mjs';
import { initialState, reduce } from '../shared/reducer.mjs';
import { PUBLISH_TARGETS, SIZES } from '../shared/vocabulary.mjs';
import { REPO_ROOT, loadConfig } from '../engine/config.mjs';
import {
  ClientError, createClient, findDecision, findShip, pickOption, readSurfaceKey, recommendedAnswers, resolveUrl, serverFile,
} from '../engine/net/client.mjs';
import { runDoctor } from '../engine/net/doctor.mjs';

const HELP = `vz: the Venezia command line

  vz serve [--sim] [--lan] [--port n] [--lan-port n]     Start the server
           [--speed n] [--fast-forward seconds] [--seed n] [--autopilot]    Demo options, with --sim
  vz new "idea" [--size gondola|galley|galleass] [--autonomy 0|1|2]         Start a project
  vz status [project]                                    See the fleet, or one project
  vz watch [project] [--since n] [--count n]             Follow events as they happen
  vz steer project "message" [--next | --now]            Send a message to a running project
  vz stop project                                        Interrupt the worker and pause
  vz approve [decision or project] [--option id] [--note text] [--confirm]  Say yes
  vz reject [decision or project] [--option id] [--note text]               Say no
  vz publish project [--target ${PUBLISH_TARGETS[4]}]                 Ask to publish
  vz open project                                        Open a prototype that passed the gate, and print its address
  vz lessons [--status s] [--search words] [--promote id] [--burn id]       Read or judge lessons
  vz pair [--list] [--revoke id]                         Link a phone. Needs serve --lan
  vz doctor                                              Check this machine
  vz mcp                                                 Serve MCP on stdio
  vz do type [--field value ...]                         Send any command, such as ship.pause
  vz do '{"type": "ship.pause", "shipId": "Aurora"}'     The same, as JSON

Every command takes --json, and --url to pick a server.
A project is its id or its name. "vz do" with no type lists every command.`;

const COMMON = { json: { type: 'boolean' }, url: { type: 'string' } };

function parse(args, options) {
  const { values, positionals } = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true });
  return { flags: values, words: positionals };
}

class UsageError extends Error {}

function numberFlag(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`--${name} must be a number`);
  return number;
}

const print = (flags, json, text) => console.log(flags.json ? JSON.stringify(json) : text);

/** How long a stop may take before the process leaves anyway. */
const STOP_LIMIT_MS = 20_000;
const config = loadConfig(process.env.VENEZIA_ROOT ? { root: process.env.VENEZIA_ROOT } : {});
/** The CLI proves itself with the running server's key. MCP claims nothing, and gets the least. */
const clientFor = (flags, surface = 'cli') => createClient({ url: resolveUrl({ url: flags.url, config }), surface, ...(surface === 'cli' ? { key: readSurfaceKey(config) } : {}) });

/** Send a command and report it. A refusal is an error, with its plain reason. */
async function send(flags, client, command, done) {
  const result = await client.command(command);
  if (result.ok === false) throw new ClientError(result.error ?? 'The server refused that');
  print(flags, result, done(result));
  return result;
}

const shipLine = (ship) => `${(ship.name ?? ship.id).padEnd(16)} ${ship.state.replaceAll('_', ' ').padEnd(18)} `
  + `${ship.hull.done}/${ship.hull.total} items  ${ship.lamp}${ship.blockReason ? `  ${ship.blockReason.replaceAll('_', ' ')}` : ''}`;

/* ---------------------------------------------------------------------- the commands */

async function serve(args) {
  const { flags } = parse(args, {
    sim: { type: 'boolean' },
    lan: { type: 'boolean' },
    port: { type: 'string' },
    'lan-port': { type: 'string' },
    speed: { type: 'string' },
    'fast-forward': { type: 'string' },
    seed: { type: 'string' },
    autopilot: { type: 'boolean' },
  });
  const { startServer } = await import('../engine/net/http.mjs');
  const port = numberFlag(flags.port, 'port');
  const lanPort = numberFlag(flags['lan-port'], 'lan-port');
  const log = (line) => console.error(line);

  let engine;
  if (flags.sim) {
    const { createSimEngine } = await import('../engine/sim-engine.mjs');
    engine = createSimEngine({
      speed: numberFlag(flags.speed, 'speed') ?? 1,
      fastForward: (numberFlag(flags['fast-forward'], 'fast-forward') ?? 0) * 1000,
      seed: numberFlag(flags.seed, 'seed'),
      autopilot: Boolean(flags.autopilot),
      config: { root: config.root },
    });
  } else {
    let createEngine;
    try {
      ({ createEngine } = await import('../engine/index.mjs'));
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      throw new ClientError('The engine is not built yet. Try the demo instead: vz serve --sim');
    }
    engine = await createEngine(config);
    await engine.start?.();
  }

  const server = await startServer({
    engine,
    config: engine.config ?? config,
    ...(port === undefined ? {} : { port }),
    ...(lanPort === undefined ? {} : { lanPort }),
    lan: Boolean(flags.lan),
    log,
  });
  const address = serverFile(config);
  fs.mkdirSync(path.dirname(address), { recursive: true });
  fs.writeFileSync(address, JSON.stringify({ url: server.url, pid: process.pid }));

  let stopping = false;
  const stop = async () => {
    // A second signal means the person has lost patience with the first.
    if (stopping) process.exit(1);
    stopping = true;
    fs.rmSync(address, { force: true });
    const deadline = setTimeout(() => {
      console.error('The host did not stop in time, so it is leaving now. A restart picks everything up.');
      process.exit(1);
    }, STOP_LIMIT_MS);
    deadline.unref();
    await server.close();
    await engine.close?.();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // One bad callback must not take every worker down. Stations show their own faults as cards,
  // so what lands here is noted on the health check, and the host keeps going.
  const survive = (error) => {
    console.error('The host hit an error outside any project:', error);
    engine.noteFault?.(error instanceof Error ? error : new Error(String(error)));
  };
  process.on('uncaughtException', survive);
  process.on('unhandledRejection', survive);

  print(flags, { ok: true, url: server.url, lanUrl: server.lanUrl, sim: Boolean(flags.sim), pid: process.pid },
    `Venezia is running at ${server.url}${flags.sim ? ' (demo, nothing here is real)' : ''}`
    + `${server.lanUrl ? `\nOn your network at ${server.lanUrl}. Run "vz pair" to link a phone.` : ''}`);
  await new Promise(() => {});
}

async function newShip(args) {
  const { flags, words } = parse(args, { size: { type: 'string' }, autonomy: { type: 'string' } });
  const idea = words.join(' ').trim();
  if (!idea) throw new UsageError('Give the idea: vz new "A tide table for the lagoon"');
  if (flags.size && !SIZES.includes(flags.size)) throw new UsageError(`--size must be one of: ${SIZES.join(', ')}`);
  const autonomy = numberFlag(flags.autonomy, 'autonomy');
  await send(flags, clientFor(flags), {
    type: 'ship.create',
    idea,
    ...(flags.size ? { size: flags.size } : {}),
    ...(autonomy === undefined ? {} : { autonomy }),
  }, (result) => `Started project ${result.id}`);
}

async function status(args) {
  const { flags, words } = parse(args, {});
  const state = await clientFor(flags).state();
  if (words.length > 0) {
    const ship = findShip(state, words.join(' '));
    const decisions = ship.openDecisions.map((entry) => state.decisions[entry.id].title);
    print(flags, ship, [
      shipLine(ship),
      `Idea: ${ship.idea}`,
      ...ship.items.map((item) => `  [${item.status === 'done' ? 'x' : ' '}] ${item.title ?? item.id}`),
      ...decisions.map((title) => `Waiting for you: ${title}`),
    ].join('\n'));
    return;
  }
  const ships = Object.values(state.ships);
  const waiting = state.inbox.map((id) => {
    const { title, tier, kind } = state.decisions[id];
    return `  ${id}  ${title} (${kind}, tier ${tier})`;
  });
  const { fiveHour, sevenDay, weather } = state.treasury;
  print(flags, {
    seq: state.seq,
    ships: ships.map(({ id, name, state: at, blockReason, hull, lamp }) => ({ id, name, state: at, blockReason, hull, lamp })),
    inbox: state.inbox.map((id) => state.decisions[id]),
    treasury: state.treasury,
    renown: state.renown,
  }, [
    ...(ships.length ? ships.map(shipLine) : ['No projects yet. Start one with: vz new "your idea"']),
    '',
    `Rate limit: ${Math.round(fiveHour * 100)}% of 5 hours, ${Math.round(sevenDay * 100)}% of 7 days (${weather})`,
    waiting.length ? `Waiting for you:\n${waiting.join('\n')}` : 'Nothing is waiting for you',
  ].join('\n'));
}

async function watch(args) {
  const { flags, words } = parse(args, { since: { type: 'string' }, count: { type: 'string' } });
  const client = clientFor(flags);
  const since = numberFlag(flags.since, 'since');
  const limit = numberFlag(flags.count, 'count') ?? Infinity;
  const only = words.length > 0 ? findShip(await client.state(), words.join(' ')).id : null;

  // The feed line is the reducer's. Folding from the start gives it the state it needs.
  let state = since === undefined ? await client.state() : initialState();
  let cursor = since === undefined ? state.seq : 0;
  let shown = 0;
  const show = (event) => {
    const line = state.feed.at(-1)?.seq === event.seq ? state.feed.at(-1).text : null;
    if (!flags.json && line === null) return; // meters and checkpoints have no line of their own
    const name = state.ships[event.shipId]?.name ?? event.shipId ?? 'fleet';
    console.log(flags.json ? JSON.stringify(event) : `${new Date(event.ts).toLocaleTimeString()}  ${name}  ${line}`);
    shown++;
  };
  for (;;) {
    const { events, seq, t } = await client.events({ since: cursor, wait: cursor < (since ?? 0) ? 0 : 25_000 });
    if (t === 'reset') {
      state = await client.state();
      cursor = state.seq;
      continue;
    }
    for (const event of events) {
      state = reduce(state, event);
      const fresh = since === undefined || event.seq > since;
      if (fresh && (only === null || event.shipId === only)) show(event);
      if (shown >= limit) return;
    }
    cursor = seq;
  }
}

async function steer(args) {
  const { flags, words } = parse(args, { next: { type: 'boolean' }, now: { type: 'boolean' } });
  const [reference, ...text] = words;
  if (!reference || text.length === 0) throw new UsageError('Say which project and what to tell it: vz steer Aurora "Make it dark"');
  if (flags.next && flags.now) throw new UsageError('Choose --next or --now, not both');
  const client = clientFor(flags);
  const ship = findShip(await client.state(), reference);
  const verb = flags.now ? 'now' : flags.next ? 'next' : 'nudge';
  await send(flags, client, { type: 'steer', shipId: ship.id, verb, text: text.join(' ') }, () => `Sent to ${ship.name ?? ship.id}`);
}

async function stop(args) {
  const { flags, words } = parse(args, {});
  if (words.length === 0) throw new UsageError('Say which project: vz stop Aurora');
  const client = clientFor(flags);
  const ship = findShip(await client.state(), words.join(' '));
  await send(flags, client, { type: 'ship.stop', shipId: ship.id }, () => `Stopped ${ship.name ?? ship.id}. Resume with: vz do ship.resume --shipId ${ship.id}`);
}

async function decide(args, intent) {
  const { flags, words } = parse(args, {
    option: { type: 'string' }, note: { type: 'string' }, token: { type: 'string' }, confirm: { type: 'boolean' },
  });
  const client = clientFor(flags);
  const state = await client.state();
  const decision = findDecision(state, words.length ? words.join(' ') : undefined);
  const name = state.ships[decision.shipId]?.name ?? 'the factory';
  if (decision.kind === 'questions' && intent === 'approve' && !flags.option) {
    await send(flags, client, { type: 'ship.answer', decisionId: decision.id, answers: recommendedAnswers(decision) }, () => `Answered for ${name} with the recommended answers`);
    return;
  }
  const option = flags.option
    ? decision.options.find((entry) => entry.id === flags.option)
    : pickOption(decision, intent);
  if (!option) throw new ClientError(`Choose one of: ${decision.options.map((entry) => entry.id).join(', ')}`);
  if (decision.tier >= 3 && intent === 'approve' && !flags.confirm) {
    throw new ClientError(`"${decision.title}" cannot be undone easily. If you mean it, run this again with --confirm.`);
  }
  // A decision bound to a payload needs the server's signature, as a finished hold gets on a phone.
  const token = flags.token ?? (decision.payloadHash && intent === 'approve' ? await client.approval(decision.id, { confirm: flags.confirm === true }) : undefined);
  await send(flags, client, {
    type: 'decision.resolve',
    id: decision.id,
    optionId: option.id,
    ...(flags.note ? { note: flags.note } : {}),
    ...(token ? { token } : {}),
  }, () => `${decision.title}: ${option.label}`);
}

async function publish(args) {
  const { flags, words } = parse(args, { target: { type: 'string', default: 'github-pages' } });
  if (words.length === 0) throw new UsageError('Say which project: vz publish Aurora');
  if (!PUBLISH_TARGETS.includes(flags.target)) throw new UsageError(`--target must be one of: ${PUBLISH_TARGETS.join(', ')}`);
  const client = clientFor(flags);
  const ship = findShip(await client.state(), words.join(' '));
  await send(flags, client, { type: 'publish.request', shipId: ship.id, target: flags.target }, () => `Asked to publish ${ship.name ?? ship.id} to ${flags.target}`);
}

async function open(args) {
  const { flags, words } = parse(args, {});
  if (words.length === 0) throw new UsageError('Say which project: vz open Aurora');
  const client = clientFor(flags);
  const ship = findShip(await client.state(), words.join(' '));
  await send(flags, client, { type: 'preview.open', shipId: ship.id }, (result) => `${ship.name ?? ship.id} is open at ${result.url}`);
}

async function lessons(args) {
  const { flags } = parse(args, {
    status: { type: 'string' }, search: { type: 'string' }, promote: { type: 'string' }, burn: { type: 'string' },
  });
  const client = clientFor(flags);
  if (flags.promote) {
    await send(flags, client, { type: 'lesson.promote', id: flags.promote }, () => 'That lesson is now a rule');
    return;
  }
  if (flags.burn) {
    await send(flags, client, { type: 'lesson.burn', id: flags.burn }, () => 'That lesson has been thrown away');
    return;
  }
  const found = await client.lessons({ status: flags.status, search: flags.search });
  const lines = found.map((lesson) => `${lesson.id}  ${lesson.status.padEnd(9)}  ${lesson.wins}/${lesson.uses} wins  ${lesson.text}`);
  print(flags, found, lines.length ? lines.join('\n') : 'No lessons yet');
}

async function pair(args) {
  const { flags } = parse(args, { list: { type: 'boolean' }, revoke: { type: 'string' } });
  const client = clientFor(flags);
  if (flags.list) {
    const devices = await client.devices();
    const lines = devices.map((device) => `${device.id}  ${device.name}  paired ${new Date(device.createdAt).toLocaleString()}`);
    print(flags, devices, lines.length ? lines.join('\n') : 'No devices are paired');
    return;
  }
  if (flags.revoke) {
    const result = await client.revokeDevice(flags.revoke);
    if (result.ok === false) throw new ClientError(result.error);
    print(flags, result, 'That device can no longer connect');
    return;
  }
  const result = await client.pairStart();
  if (result.ok === false) throw new ClientError(result.error);
  const { qrText, ...details } = result;
  const expires = new Date(result.expiresAt).toLocaleTimeString();
  print(flags, details, [
    qrText,
    '',
    'Scan this with your phone, or open the address and type the code.',
    `Address: ${result.url}`,
    ...(result.ipUrl ? [`If that does not open: ${result.ipUrl}`] : []),
    `Code: ${result.pin}, works once, until ${expires}`,
    `Certificate fingerprint: ${result.fingerprint}`,
  ].join('\n'));
}

async function doctor(args) {
  const { flags } = parse(args, {});
  const report = await runDoctor({ config });
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = report.checks.flatMap((entry) => [
    `${mark[entry.status]}  ${entry.plain}`,
    ...(entry.fix ? [`      ${entry.fix}`] : []),
  ]);
  print(flags, report, `${lines.join('\n')}\n\n${report.ok ? 'This machine is ready.' : 'Fix the failures above first.'}`);
  if (!report.ok) process.exitCode = 1;
}

async function mcp(args) {
  const { flags } = parse(args, {});
  const { runMcpServer } = await import('../engine/mcp.mjs');
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  await runMcpServer({ client: clientFor(flags, 'mcp'), version });
}

/** `--field value` pairs. A value is JSON if it parses as JSON, and text otherwise. */
function fieldsFrom(tokens) {
  const fields = {};
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('--') || tokens[i + 1] === undefined) {
      throw new UsageError(`Expected --field value, but found: ${tokens[i]}`);
    }
    const raw = tokens[++i];
    try {
      fields[tokens[i - 1].slice(2)] = JSON.parse(raw);
    } catch {
      fields[tokens[i - 1].slice(2)] = raw;
    }
  }
  return fields;
}

async function anyCommand(args) {
  const { values: flags, tokens } = parseArgs({ args, options: COMMON, allowPositionals: true, strict: false, tokens: true });
  const consumed = new Set(tokens.filter((token) => token.kind === 'option' && Object.hasOwn(COMMON, token.name)).flatMap((token) => (token.value === undefined || token.inlineValue
    ? [token.index]
    : [token.index, token.index + 1])));
  const [first, ...rest] = args.filter((_, index) => !consumed.has(index));
  if (first === undefined) {
    const lines = COMMAND_TYPES.map((name) => `${name.padEnd(18)} ${COMMANDS[name].plain}`);
    print(flags, COMMAND_TYPES.map((name) => ({ type: name, plain: COMMANDS[name].plain })), lines.join('\n'));
    return;
  }
  const client = clientFor(flags);
  let command;
  if (first.startsWith('{')) {
    try {
      command = JSON.parse(first);
    } catch {
      throw new UsageError('That is not valid JSON');
    }
  } else {
    command = { type: first, ...fieldsFrom(rest) };
  }
  if (typeof command.shipId === 'string') command.shipId = findShip(await client.state(), command.shipId).id;
  await send(flags, client, command, (result) => `Done${result.id ? `: ${result.id}` : ''}`);
}

const COMMAND_LINE = {
  serve,
  new: newShip,
  status,
  watch,
  steer,
  stop,
  approve: (args) => decide(args, 'approve'),
  reject: (args) => decide(args, 'reject'),
  publish,
  open,
  lessons,
  pair,
  doctor,
  mcp,
  do: anyCommand,
};

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
  console.log(HELP);
} else if (!Object.hasOwn(COMMAND_LINE, name)) {
  console.error(`There is no command called ${name}.\n\n${HELP}`);
  process.exitCode = 2;
} else {
  try {
    await COMMAND_LINE[name](rest);
  } catch (error) {
    const expected = error instanceof ClientError || error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS');
    if (!expected) throw error;
    if (rest.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(error.message);
    process.exitCode = error instanceof ClientError ? 1 : 2;
  }
}
