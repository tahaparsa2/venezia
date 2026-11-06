// Now: what she is doing this minute, and the field that steers her. SPEC 8. The verbs are one
// row under one field, so a thought can be typed first and aimed after.

import { cmd } from '/js/commands.js';
import { STATE } from '/shared/vocabulary.mjs';
import { clock, h, setText, syncList, usd } from '/js/folio/dom.js';
import { TARGET, readable, roleWord, stateSentence, livePlaces } from '/js/folio/words.js';
import { shortAddress } from '/js/places.js';

const VERB_TIP = {
  nudge: 'Nudge: applied at its next step. "Also make it dark."',
  next: 'Next: waits until this step ends. "When you finish, add a footer."',
  now: 'Now: stops what it is doing and changes course. "Stop that, do this."',
};
const EMPTY_TIP = 'Type a message, then pick when it lands: Nudge at its next step, Next when this step ends, Now straight away.';
const ACTIVITY_WORDS = (line) => readable(line).replace(/\bFolding in:/, 'Taking in your message:');
const STEER_MARK = { sent: 'sent', queued: 'waiting', started: 'folding in', completed: 'taken', cancelled: 'dropped' };

export function createNowTab(ctx) {
  const { store } = ctx;
  const say = h('p', { class: 'now-say' });
  const facts = h('dl', { class: 'fact-list' });
  const worker = h('div', { class: 'now-worker', hidden: true },
    h('p', { class: 'now-worker-who' }),
    h('div', { class: 'gauge', role: 'img' }, h('i')),
    h('p', { class: 'now-speech' }));
  const feed = h('ol', { class: 'now-feed', 'aria-label': 'Recent activity' });
  const publishFailed = h('p', { class: 'now-failed', role: 'status', hidden: true });
  const liveRow = h('p', { class: 'now-live', hidden: true },
    h('span', { class: 'now-live-say', text: 'Live at ' }),
    h('a', { class: 'link now-live-link', target: '_blank', rel: 'noopener' }));

  const field = h('textarea', {
    class: 'steer-field', rows: 1, maxLength: 20000, placeholder: 'Tell her something', 'aria-label': 'A message for the running project',
    oninput: () => { fit(); draw(); },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send('nudge');
      }
    },
    onfocus: () => steer.classList.add('is-open'),
    onblur: () => {
      if (!field.value.trim()) setTimeout(() => {
        if (!steer.contains(document.activeElement)) steer.classList.remove('is-open');
      }, 120);
    },
  });
  const verbs = Object.fromEntries(['nudge', 'next', 'now'].map((verb) => [verb, h('button', {
    type: 'button', class: `act act-verb act-verb-${verb}`, text: verb[0].toUpperCase() + verb.slice(1), onclick: () => send(verb),
    onpointerenter: () => tip(verb), onfocus: () => tip(verb), onpointerleave: () => tip(null), onblur: () => tip(null),
  })]));
  const stop = h('button', { type: 'button', class: 'act act-stop', text: 'Stop', onclick: () => act(cmd.stop(ctx.shipId()), 'Stopped. It is paused.') });
  const hint = h('p', { class: 'steer-hint', 'aria-live': 'polite' });
  const steer = h('form', { class: 'steer', onsubmit: (event) => event.preventDefault() }, field,
    h('div', { class: 'verbs' }, verbs.nudge, verbs.next, verbs.now, stop), hint);

  const closedSay = h('p', { class: 'steer-closed' });
  const closedAct = h('button', { type: 'button', class: 'act act-now' });
  const closed = h('div', { class: 'steer steer-shut', hidden: true }, closedSay, closedAct);

  const body = h('div', { class: 'tab-body' }, say, publishFailed, liveRow, worker, facts, h('h3', { class: 'rub', text: 'Activity' }), feed);
  const el = h('div', { class: 'tab tab-now', role: 'tabpanel' }, body, steer, closed);

  let ship = null;
  let hoverVerb = null;

  function fit() {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  }

  function tip(verb) {
    hoverVerb = verb;
    setText(hint, verb ? VERB_TIP[verb] : (field.value.trim() ? 'Enter sends a nudge. Shift and Enter for a new line.' : EMPTY_TIP));
  }

  async function act(command, done) {
    const result = await store.send(command);
    if (!result.ok) store.notify(result.error, { title: 'Not sent' });
    else if (done) store.announce(done);
    return result;
  }

  async function send(verb) {
    const text = field.value.trim();
    if (!ship || !text) return;
    const result = await act(cmd.steer(ship.id, verb, text));
    if (result.ok) {
      field.value = '';
      fit();
      store.announce(`${verb} sent`);
      draw();
    }
  }

  function draw() {
    if (!ship) return;
    const empty = field.value.trim() === '';
    const past = store.timeline().live === false;
    for (const button of Object.values(verbs)) button.disabled = empty || past;
    field.disabled = past;
    field.placeholder = past ? 'You are looking at the past' : `Tell ${ship.name ?? 'her'} something`;
    stop.disabled = past;
    if (!hoverVerb) tip(null);
  }

  function drawClosed() {
    const { state } = ship;
    const terminal = STATE[state]?.terminal;
    const paused = state === 'paused';
    const failed = state === 'failed';
    const shut = terminal || paused;
    steer.hidden = shut;
    closed.hidden = !shut;
    if (!shut) return;
    closedAct.hidden = !(paused || failed);
    if (paused) {
      setText(closedSay, 'Paused. It spends nothing until you resume.');
      setText(closedAct, 'Resume');
      closedAct.onclick = () => act(cmd.resume(ship.id), 'Resumed');
    } else if (failed) {
      setText(closedSay, ship.gate.status === 'failed'
        ? 'Retry makes one more repair, then runs every check again.'
        : 'It stopped here. A retry starts from the same place.');
      setText(closedAct, 'Retry');
      closedAct.onclick = () => act(cmd.retry(ship.id), 'Retrying');
    } else {
      setText(closedSay, state === 'scuttled' ? 'Abandoned. Nothing more can be sent.' : 'Finished. Press Change it to reopen it.');
    }
  }

  /** Publishing's obvious next thought is "open it", and a failed one has to say why. */
  function drawLive() {
    const place = livePlaces(ship).at(-1);
    const failed = Object.entries(ship.publishes ?? {}).find(([, entry]) => entry.status === 'rolledback' && !entry.live);
    publishFailed.hidden = !failed || Boolean(place);
    if (failed) setText(publishFailed, `The last publish did not go out, and nothing is public. ${failed[1].reason ?? ''} Press Publish to try again.`);
    liveRow.hidden = !place;
    if (!place) return;
    const [where, link] = liveRow.children;
    setText(where, `Live on ${TARGET[place.target]?.name ?? place.target}: `);
    link.href = place.url;
    setText(link, shortAddress(place.url));
  }

  function update(current) {
    ship = current;
    const plain = store.view.get().plain;
    const events = ctx.log.events(ship.id);
    const pausedBy = ship.state === 'paused' ? events.findLast((event) => event.type === 'ship.state' && event.data.state === 'paused')?.actor : null;
    setText(say, stateSentence(ship, plain, pausedBy));
    say.classList.toggle('needs', ship.lamp === 'amber');

    const runId = ship.activeRuns.at(-1);
    const run = runId ? ship.runs[runId] : null;
    worker.hidden = !run;
    if (run) {
      const [who, gauge, speech] = worker.children;
      setText(who, `${roleWord(run.role, true)} working`);
      who.title = `Model ${run.model}${run.effort ? `, ${run.effort} effort` : ''}`;
      const used = run.context ? run.context.used / run.context.max : 0;
      gauge.firstChild.style.width = `${Math.min(100, used * 100).toFixed(1)}%`;
      gauge.setAttribute('aria-label', `${Math.round(used * 100)}% of context used`);
      gauge.title = `${Math.round(used * 100)}% of context used`;
      setText(speech, run.text);
      speech.hidden = !run.text;
    }

    drawLive();
    const { done, total } = ship.hull;
    const rows = [
      ['Idea', ship.idea],
      total > 0 && ['Work items', `${done} of ${total}`],
      ship.receipt && !ship.receipt.voided
        ? ['Evidence', `Gate passed, receipt ${ship.receipt.commit.slice(0, 7)}`]
        : ship.gate.attempts > 0 && ['Evidence', ship.gate.status === 'failed' ? `Gate failed, try ${ship.gate.attempts}` : `Gate ${ship.gate.status}`],
      ['Spent', `${usd(ship.spentUsd)} at list price`],
    ].filter(Boolean);
    syncList(facts, rows.flatMap(([term, value]) => [{ key: `t-${term}`, tag: 'dt', text: term }, { key: `d-${term}`, tag: 'dd', text: value }]),
      (row) => row.key, (row) => h(row.tag), (node, row) => setText(node, row.text));

    const steers = Object.values(ship.steers).map((entry) => ({ key: `s${entry.uuid}`, ts: entry.ts, steer: entry }));
    const lines = ship.activity.map((entry) => ({ key: `a${entry.seq}`, ts: entry.ts, line: entry }));
    const merged = [...steers, ...lines].sort((a, b) => b.ts - a.ts).slice(0, 24);
    syncList(feed, merged, (row) => row.key, (row) => {
      const node = h('li', { class: row.steer ? 'feed-you' : '' }, h('time'), h('span', { class: 'feed-text' }));
      return node;
    }, (node, row) => {
      const [time, text] = node.children;
      setText(time, clock(row.ts));
      if (row.steer) {
        const scripted = events.find((event) => event.type === 'steer.sent' && event.data.uuid === row.steer.uuid)?.actor === 'sim';
        setText(text, `${scripted ? 'The demo said' : 'You said'}: ${row.steer.text}`);
        node.dataset.mark = STEER_MARK[row.steer.state] ?? row.steer.state;
      } else {
        const { tool, summary, kind } = row.line;
        setText(text, ACTIVITY_WORDS(summary || tool || kind));
      }
    });
    drawClosed();
    draw();
  }

  return {
    el,
    update,
    /** `S` puts the cursor in the field. */
    focusSteer() {
      field.focus();
    },
  };
}
