// Chronicle: the same log at three depths, with the scrubber that walks the whole factory back
// through time. Lines are computed from events, so they cannot be wrong about what happened.

import { cmd } from '/js/commands.js';
import { TERM } from '/shared/vocabulary.mjs';
import { clock, clockSeconds, h, plural, setText, span, syncList, token, usd } from '/js/folio/dom.js';
import { simpleLine, technicalLine } from '/js/folio/words.js';

const QUIET = new Set(['worker.text', 'worker.context']);
const TECH_LIMIT = 400;
const DEPTHS = [['simple', 'Simple'], ['technical', 'Technical'], ['commentary', 'Commentary']];

/** Margin notes: why a moment matters. Facts about the system, never about the project. */
const GLOSS = {
  'gate.failed': 'A failure is kept, not hidden. The fix must be a new commit, and the whole gate runs again.',
  'gate.first': 'Passing first try is the only gate that earns renown.',
  'receipt.issued': 'The receipt names the commit, the contract and the evidence. Change one byte and it is void.',
  'receipt.voided': 'This is why the gold dims: the proof was for code that is no longer the code.',
  'review.changes': 'The reviewer is never the builder, and has to cite evidence.',
  'ship.refit': 'A refit adds a contract version. Only you can change a contract once it is accepted.',
  'ship.forked': 'A rewind never overwrites. It forks from a checkpoint, on a new branch.',
  'publish.rolledback': 'The broker checks the live page after publishing, and undoes it on its own if it fails.',
  'steer.sent': 'Every steer is kept, and is material for lessons.',
  'lesson.drafted': 'A lesson starts as a hint. Only you can make one law.',
};

function factsOf(events) {
  const runs = new Map();
  const gates = [];
  const stages = [];
  let gate = null;
  let spent = 0;
  let steers = 0;
  let voided = 0;
  let refits = 0;
  const hints = { used: 0, wins: 0, losses: 0 };
  for (const { type, data, ts } of events) {
    if (type === 'worker.started') runs.set(data.runId, { role: data.role, costUsd: 0 });
    else if (type === 'worker.stopped') {
      const run = runs.get(data.runId);
      if (run) run.costUsd = data.costUsd;
      spent += data.costUsd;
    } else if (type === 'gate.started') {
      gate = { failed: [], ok: null };
      gates.push(gate);
    } else if (type === 'gate.step' && gate && !data.ok) gate.failed.push(data.step);
    else if (type === 'gate.finished' && gate) gate.ok = data.ok;
    else if (type === 'ship.state') stages.push({ state: data.state, ts });
    else if (type === 'steer.sent') steers += 1;
    else if (type === 'receipt.voided') voided += 1;
    else if (type === 'ship.refit') refits += 1;
    else if (type === 'lesson.used') hints.used += 1;
    else if (type === 'lesson.scored') hints[data.outcome === 'win' ? 'wins' : 'losses'] += 1;
  }
  return { runs, gates, stages, spent, steers, voided, refits, hints };
}

/** What the numbers say, as CHRONICLE.md's Commentary does: computed, never invented. */
function notesFrom(events) {
  const facts = factsOf(events);
  const notes = [];
  const finished = facts.gates.filter((gate) => gate.ok !== null);
  if (finished.length === 1 && finished[0].ok) notes.push('She passed the gate first try.');
  if (finished.length > 1) {
    const passes = finished.filter((gate) => gate.ok).length;
    notes.push(passes ? `She took ${finished.length} gate runs to pass.` : `${plural(finished.length, 'gate run')}, and no pass.`);
    const counts = new Map();
    for (const gate of finished) for (const step of gate.failed) counts.set(step, (counts.get(step) ?? 0) + 1);
    const worst = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (worst) notes.push(`The step that failed most was ${worst[0]}, ${plural(worst[1], 'time')}.`);
  }
  const byRole = new Map();
  for (const run of facts.runs.values()) byRole.set(run.role, (byRole.get(run.role) ?? 0) + run.costUsd);
  const dearest = [...byRole].sort((a, b) => b[1] - a[1])[0];
  if (dearest && facts.spent > 0) {
    notes.push(`The ${TERM[dearest[0]]?.plain.toLowerCase() ?? dearest[0]} took ${Math.round((dearest[1] / facts.spent) * 100)}% of the ${usd(facts.spent)} spent.`);
  }
  const stays = facts.stages.map((stage, index) => ({ state: stage.state, ms: (facts.stages[index + 1]?.ts ?? stage.ts) - stage.ts }));
  const longest = stays.sort((a, b) => b.ms - a.ms)[0];
  if (longest?.ms > 0) notes.push(`The longest stretch was ${longest.state.replaceAll('_', ' ')}, at ${span(longest.ms)}.`);
  if (facts.steers) notes.push(`You steered her ${plural(facts.steers, 'time')} while she ran.`);
  if (facts.hints.used) notes.push(`${plural(facts.hints.used, 'hint')} from past runs went in: ${plural(facts.hints.wins, 'win')}, ${facts.hints.losses} ${facts.hints.losses === 1 ? 'loss' : 'losses'}.`);
  if (facts.voided) notes.push(`${plural(facts.voided, 'receipt')} voided.`);
  if (facts.refits) notes.push(`Refit ${plural(facts.refits, 'time')}.`);
  return notes;
}

function glossFor(event, firstGate) {
  const { type, data } = event;
  if (type === 'gate.finished') return data.ok ? (firstGate ? GLOSS['gate.first'] : null) : GLOSS['gate.failed'];
  if (type === 'review.finished') return data.verdict === 'accepted' ? null : GLOSS['review.changes'];
  return GLOSS[type] ?? null;
}

export function createChronicleTab(ctx) {
  const { store, log } = ctx;
  let depth = 'simple';
  let ship = null;
  let events = [];
  let stops = [];

  const segments = DEPTHS.map(([id, name]) => h('button', {
    type: 'button', role: 'radio', class: 'seg', text: name, data: { depth: id },
    onclick: () => {
      depth = id;
      redraw();
      list.parentElement.scrollTop = 0;
    },
  }));
  const bar = h('div', { class: 'segs chron-depths', role: 'radiogroup', 'aria-label': 'Depth' }, segments);
  const notes = h('ul', { class: 'chron-notes', hidden: true });
  const list = h('ol', { class: 'chron', 'aria-label': 'Chronicle' });
  const more = h('p', { class: 'chron-more', hidden: true });
  const body = h('div', { class: 'tab-body' }, notes, list, more);

  /* ------------------------------------------------------------------------ the scrubber */

  const ruler = h('canvas', { class: 'scrub-ruler', 'aria-hidden': 'true' });
  const range = h('input', {
    type: 'range', class: 'scrub-range', min: 0, max: 0, step: 1, value: 0, 'aria-label': 'Move through this project\'s log',
    oninput: () => scrubTo(Number(range.value)),
  });
  const reading = h('p', { class: 'scrub-reading' });
  const rewind = h('button', { type: 'button', class: 'act act-now', text: 'Rewind here', onclick: () => doRewind() });
  const back = h('button', { type: 'button', class: 'act', text: 'Back to now', onclick: () => store.seek(null) });
  const say = h('p', { class: 'scrub-say', hidden: true });
  const scrub = h('section', { class: 'scrub', 'aria-label': 'Log scrubber' },
    h('div', { class: 'scrub-track' }, ruler, range),
    h('div', { class: 'scrub-row' }, reading, h('div', { class: 'scrub-acts' }, back, rewind)), say);

  const el = h('div', { class: 'tab tab-chronicle', role: 'tabpanel' }, bar, body, scrub);

  let wanted = null;
  let frame = 0;
  function scrubTo(index) {
    wanted = index;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stop = stops[wanted];
      // The far right is now. Only that returns to live, so a scrub cannot end in a false now.
      store.seek(wanted >= stops.length - 1 || !stop ? null : stop.seq);
    });
  }

  async function doRewind() {
    const past = store.getState().ships[ship.id];
    const checkpoint = past?.checkpoints.at(-1);
    if (!checkpoint?.uuid) return;
    const name = ship.name;
    const result = await store.send(cmd.rewind(ship.id, checkpoint.uuid));
    if (!result.ok) {
      store.notify(result.error, { title: 'Not rewound' });
      return;
    }
    await store.seek(null);
    store.notify(`${name} forked from that checkpoint. Nothing was lost.`, { title: 'Rewound' });
    if (result.id) store.view.set({ selectedShip: result.id });
  }

  function paintRuler() {
    const width = ruler.clientWidth;
    const height = ruler.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (ruler.width !== Math.round(width * ratio)) {
      ruler.width = Math.round(width * ratio);
      ruler.height = Math.round(height * ratio);
    }
    const c = ruler.getContext('2d');
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, width, height);
    const ink = token('--ink-muted');
    const mid = height - 1;
    const last = Math.max(1, stops.length - 1);
    const pad = 9;
    const x = (index) => pad + (index / last) * (width - pad * 2);
    c.strokeStyle = ink;
    c.lineWidth = 0.75;
    c.beginPath();
    c.moveTo(pad, mid);
    c.lineTo(width - pad, mid);
    c.stroke();
    // Fine graduations first, as on an engraved rule, then the moments that matter on top.
    const every = Math.max(1, Math.ceil(stops.length / (width / 3)));
    c.globalAlpha = 0.5;
    c.beginPath();
    for (let index = 0; index < stops.length; index += every) {
      c.moveTo(x(index), mid);
      c.lineTo(x(index), mid - 4);
    }
    c.stroke();
    c.globalAlpha = 1;
    const marks = [
      ['checkpoint', token('--verdigris-ink'), 8, 1],
      ['pass', token('--gold-deep'), 14, 2],
      ['fail', token('--vermilion-ink'), 14, 2],
    ];
    for (const [kind, colour, tall, weight] of marks) {
      c.strokeStyle = colour;
      c.lineWidth = weight;
      c.beginPath();
      stops.forEach((stop, index) => {
        if (stop.mark !== kind) return;
        c.moveTo(x(index), mid);
        c.lineTo(x(index), mid - tall);
      });
      c.stroke();
    }
  }

  function drawScrub() {
    const timeline = store.timeline();
    const atIndex = timeline.live ? stops.length - 1 : Math.max(0, stops.findLastIndex((stop) => stop.seq <= timeline.at));
    range.max = Math.max(0, stops.length - 1);
    if (document.activeElement !== range || timeline.live) range.value = atIndex;
    range.disabled = stops.length < 2;
    const stop = stops[atIndex];
    const when = stop ? clockSeconds(stop.ts) : '';
    range.setAttribute('aria-valuetext', timeline.live ? 'Now' : `${when}, ${stop ? technicalLine(stop) : ''}`);
    scrub.classList.toggle('in-past', !timeline.live);
    back.hidden = timeline.live;
    rewind.hidden = timeline.live;
    say.hidden = timeline.live;
    if (timeline.live) {
      setText(reading, `Now. ${plural(stops.length, 'moment')} in her log`);
      return;
    }
    setText(reading, `${when}  ${stop ? technicalLine(stop) : ''}`);
    const past = store.getState().ships[ship?.id];
    const checkpoint = past?.checkpoints.at(-1);
    rewind.disabled = !checkpoint;
    setText(say, checkpoint
      ? `Rewind forks a new hull from the last checkpoint before here, on a new branch. ${ship.name} stops. Nothing is lost.`
      : 'There is no checkpoint before this moment, so nothing to rewind to. Scrub further on.');
  }

  /* ------------------------------------------------------------------------------ the log */

  function lineNode() {
    return h('li', {}, h('time'), h('span', { class: 'chron-text' }));
  }

  function drawList() {
    const plain = store.view.get().plain;
    const name = ship.name ?? 'She';
    const cursor = store.timeline();
    let rows;
    if (depth === 'technical') {
      const all = events.filter((event) => !QUIET.has(event.type));
      rows = all.slice(-TECH_LIMIT).reverse().map((event) => ({ event, text: technicalLine(event) }));
      more.hidden = all.length <= TECH_LIMIT;
      setText(more, `Showing the last ${TECH_LIMIT} of ${all.length}. The rest is in the export.`);
    } else {
      more.hidden = true;
      let gates = 0;
      rows = [];
      for (const event of events) {
        const firstGate = event.type === 'gate.finished' && ++gates === 1;
        const decision = event.type === 'decision.resolved' ? store.getState().decisions[event.data.id] : null;
        const text = simpleLine({ ...event, decision }, plain, ship);
        if (!text) continue;
        const gloss = depth === 'commentary' ? glossFor(event, firstGate) : null;
        if (depth === 'simple' || gloss) rows.push({ event, text, name, gloss });
      }
      rows.reverse();
    }

    syncList(list, rows, (row) => `${depth}-${row.event.seq}`, lineNode, (node, row) => {
      const { event } = row;
      node.className = `chron-${depth}`;
      node.classList.toggle('after', !cursor.live && event.seq > cursor.at);
      node.classList.toggle('bad', (event.type === 'gate.finished' && !event.data.ok) || event.type === 'publish.rolledback' || event.type === 'receipt.voided');
      const [time, text] = node.children;
      setText(time, depth === 'technical' ? clockSeconds(event.ts) : clock(event.ts));
      const key = `${row.name ?? ''}|${row.text}|${row.gloss ?? ''}`;
      if (text.dataset.key === key) return;
      text.dataset.key = key;
      text.replaceChildren(...(row.name ? [h('b', { text: row.name }), ` ${row.text}`] : [row.text]));
      if (row.gloss) text.append(h('span', { class: 'gloss', text: row.gloss }));
    });

    const commentary = depth === 'commentary';
    notes.hidden = !commentary;
    if (commentary) {
      const lines = notesFrom(events);
      if (lines.length === 0) lines.push('Nothing unusual has happened yet.');
      syncList(notes, lines, (line) => line, (line) => h('li', { text: line }));
    }
  }

  function redraw() {
    if (!ship) return;
    for (const button of segments) button.setAttribute('aria-checked', button.dataset.depth === depth);
    drawList();
    drawScrub();
  }

  function update(current) {
    const changedShip = ship?.id !== current.id;
    ship = current;
    events = log.events(ship.id);
    const nextStops = events.filter((event) => !QUIET.has(event.type)).map((event) => {
      let mark = null;
      if (event.type === 'worker.activity' && event.data.kind === 'checkpoint') mark = 'checkpoint';
      else if (event.type === 'gate.finished') mark = event.data.ok ? 'pass' : 'fail';
      return { ...event, mark };
    });
    const grew = nextStops.length !== stops.length || changedShip;
    stops = nextStops;
    redraw();
    if (grew) paintRuler();
    if (changedShip) body.scrollTop = 0;
  }

  const watcher = new ResizeObserver(paintRuler);
  watcher.observe(ruler);

  return {
    el,
    update,
    setDepth(id) {
      depth = id;
      redraw();
    },
    destroy() {
      watcher.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

