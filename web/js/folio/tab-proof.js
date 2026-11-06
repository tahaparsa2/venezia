// Proof: the evidence, in the order a sceptic would ask for it. Why it failed comes first,
// in plain English, because that is the question. Then the steps, the pictures the gate took,
// and the receipt. The stamp is gold only while the receipt stands.

import { cmd } from '/js/commands.js';
import { clock, dayMonth, h, plural, setText, shortHash, syncList } from '/js/folio/dom.js';
import { evidenceFile, evidenceLink, evidenceRun, pictureName, picturesIn, readEvidence } from '/js/folio/evidence.js';
import { gateRuns } from '/js/folio/shiplog.js';
import { gateStep, roleWord, TARGET, livePlaces } from '/js/folio/words.js';

const seconds = (ms) => (!ms ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The round stamp, cut as an inline SVG so its lettering runs round the rim. */
function stampSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.className = 'seal';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `<svg xmlns="${ns}" viewBox="0 0 120 120">
    <defs><path id="stamp-rim" d="M60 60m-41 0a41 41 0 1 1 82 0a41 41 0 1 1 -82 0"/>
      <linearGradient id="stamp-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--gold-pale)"/><stop offset=".45" style="stop-color:var(--gold)"/><stop offset=".62" style="stop-color:var(--gold-light)"/><stop offset="1" style="stop-color:var(--gold-deep)"/></linearGradient></defs>
    <circle class="stamp-disc" cx="60" cy="60" r="56"/>
    <g class="stamp-teeth">${Array.from({ length: 48 }, (_, index) => `<rect x="59.2" y="1.5" width="1.6" height="5" transform="rotate(${index * 7.5} 60 60)"/>`).join('')}</g>
    <circle class="stamp-ring" cx="60" cy="60" r="50"/><circle class="stamp-ring" cx="60" cy="60" r="35"/>
    <text class="stamp-rim-text"><textPath href="#stamp-rim" startOffset="0">BOLLO · VERIFIED BY THE HOST · VENEZIA ·</textPath></text>
    <path class="stamp-tick" d="M43 61l12 13 24-29"/><path class="stamp-void" d="M30 90L90 30"/>
  </svg>`;
  return wrap;
}

export function createProofTab(ctx) {
  const { store, log } = ctx;
  const retry = h('button', {
    type: 'button', class: 'act act-now why-retry', text: 'Retry',
    onclick: async () => {
      const result = await store.send(cmd.retry(shipId));
      if (!result.ok) store.notify(result.error, { title: 'Not sent' });
    },
  });
  const why = h('section', { class: 'why', hidden: true }, h('h3', { class: 'why-head' }), h('p', { class: 'why-body' }), h('p', { class: 'why-detail' }), h('p', { class: 'why-next' }), retry);
  const liveLine = h('p', { class: 'now-live', hidden: true }, h('span'), h('a', { class: 'link now-live-link', target: '_blank', rel: 'noopener' }));
  const review = h('section', { class: 'findings', hidden: true }, h('h3', { class: 'rub', text: 'Reviewer' }), h('p', { class: 'findings-verdict' }), h('ul'));
  const lead = h('p', { class: 'tab-lead' });
  const earlier = h('p', { class: 'proof-earlier', hidden: true },
    h('span'), h('button', { type: 'button', class: 'link', text: 'Latest run', onclick: () => pin(null) }));
  const steps = h('ol', { class: 'gate-steps', 'aria-label': 'Gate steps' });
  const runsHead = h('h3', { class: 'rub', text: 'Every run', hidden: true });
  const runs = h('ol', { class: 'gate-runs', hidden: true });
  const shots = h('div', { class: 'shots', hidden: true }, h('h3', { class: 'rub', text: 'What Venezia saw' }), h('div', { class: 'shots-row' }));
  const links = h('p', { class: 'proof-links', hidden: true });

  const stamp = stampSvg();
  const receipt = h('section', { class: 'receipt', hidden: true },
    stamp,
    h('div', { class: 'receipt-text' },
      h('h3', { class: 'receipt-title' }),
      h('p', { class: 'receipt-say' }),
      h('dl', { class: 'receipt-hashes' })));

  const el = h('div', { class: 'tab tab-proof', role: 'tabpanel' },
    h('div', { class: 'tab-body' }, liveLine, why, earlier, lead, steps, review, receipt, shots, runsHead, runs, links));

  let shown = '';
  let pinned = null;
  let wantedTile = null;
  let shipId = null;
  const pictures = new Map();

  /** Look at one run rather than the latest. A tile opens the run that set it. */
  function pin(seq) {
    pinned = seq;
    wantedTile = null;
    ctx.redraw();
    el.querySelector('.tab-body').scrollTop = 0;
  }

  function drawShots(ship, run, isLatest) {
    const location = run ? evidenceRun(run.evidence ?? (isLatest ? ship.artifacts.evidence?.path : null)) : null;
    const key = location ? `${location.shipId}/${location.runId}` : '';
    if (key === shown) return;
    shown = key;
    const row = shots.lastChild;
    row.replaceChildren();
    links.replaceChildren();
    shots.hidden = !location;
    links.hidden = !location;
    if (!location) return;
    const logLink = evidenceLink(store, location, 'gate.log');
    const recordLink = evidenceLink(store, location, 'evidence.json');
    links.append(
      recordLink ? h('a', { href: recordLink, target: '_blank', rel: 'noopener', text: 'evidence.json' }) : '',
      logLink ? h('a', { href: logLink, target: '_blank', rel: 'noopener', text: 'gate.log' }) : '',
    );
    const paint = (files) => {
      if (shown !== key) return;
      row.replaceChildren(...files.map((file) => {
        const src = evidenceFile(store, location, file);
        return src ? h('a', { class: 'shot', href: evidenceLink(store, location, file), target: '_blank', rel: 'noopener', 'aria-label': `Screenshot ${file}, opens larger` },
          h('span', { class: 'shot-plate' }, h('img', { src, alt: `What Venezia saw: ${file}`, loading: 'lazy', onerror: (event) => event.currentTarget.closest('.shot').remove() })),
          h('span', { class: 'shot-caption', text: `${pictureName(file)}, ${clock(run.ts)}` })) : null;
      }).filter(Boolean));
      shots.hidden = row.children.length === 0;
    };
    if (pictures.has(key)) paint(pictures.get(key));
    else {
      readEvidence(store, location).then((record) => {
        const files = picturesIn(record);
        pictures.set(key, files);
        paint(files);
      });
    }
  }

  function drawWhy(ship, chosen) {
    const plain = store.view.get().plain;
    const failedStep = chosen
      ? chosen.steps.find((step) => !step.ok) ?? null
      : ship.gate.status === 'failed' ? ship.gate.steps.find((step) => !step.ok) : null;
    const changes = !chosen && ship.review?.verdict === 'changes' ? ship.review.findings[0] : null;
    const rolled = Object.values(ship.publishes).find((entry) => entry.status === 'rolledback');
    const [head, body, detail, next] = why.children;
    retry.hidden = Boolean(chosen) || ship.state !== 'failed';
    const repairing = ship.state === 'repairing';
    const nextWords = chosen ? '' : repairing
      ? `A ${roleWord('calafato', plain).toLowerCase()} is on it. The fix is a new commit, and the whole gate runs again.`
      : ship.state === 'blocked' ? 'It has stopped, and the card has your options.'
        : ship.state === 'failed' ? 'A retry runs one more repair, then the whole gate again.' : '';

    if (failedStep) {
      const step = gateStep(failedStep.step);
      why.hidden = false;
      setText(head, chosen ? 'Why this run failed' : `Why it failed, try ${ship.gate.attempts}`);
      setText(body, step.fail);
      setText(detail, failedStep.detail ?? '');
      detail.hidden = !failedStep.detail;
      setText(next, nextWords);
      next.hidden = !nextWords;
    } else if (changes) {
      why.hidden = false;
      setText(head, 'Why it came back');
      setText(body, 'The gate passed, but the independent reviewer found a problem.');
      setText(detail, changes.text ?? changes.claim ?? '');
      detail.hidden = false;
      setText(next, nextWords);
      next.hidden = !nextWords;
    } else if (!chosen && rolled && ship.state !== 'launched') {
      why.hidden = false;
      setText(head, 'Why it was rolled back');
      setText(body, `The live page on ${TARGET[rolled.target]?.name ?? rolled.target} did not pass the browser checks, so the publish was undone. ${rolled.stillOut ? 'An earlier version is still out there.' : 'Nothing is live.'}`);
      detail.hidden = !rolled.reason;
      setText(detail, rolled.reason ?? '');
      next.hidden = true;
    } else {
      why.hidden = true;
    }
  }

  /** The run to look at, or null for the latest, which the state itself keeps current. */
  function chosenRun(history) {
    if (wantedTile !== null && history.length) {
      const run = history.findLast((entry) => entry.seq < wantedTile) ?? null;
      pinned = run?.seq ?? null;
      wantedTile = null;
    }
    if (pinned === null || pinned === history.at(-1)?.seq) return null;
    return history.find((entry) => entry.seq === pinned) ?? null;
  }

  function update(ship) {
    if (ship.id !== shipId) {
      shipId = ship.id;
      pinned = null;
    }
    const place = livePlaces(ship).at(-1);
    liveLine.hidden = !place;
    if (place) {
      setText(liveLine.firstChild, `Live on ${TARGET[place.target]?.name ?? place.target}: `);
      liveLine.lastChild.href = place.url;
      setText(liveLine.lastChild, place.url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    }
    const history = gateRuns(log.events(ship.id));
    const lastRun = history.at(-1);
    const chosen = chosenRun(history);
    drawWhy(ship, chosen);

    const { status, attempts } = ship.gate;
    earlier.hidden = !chosen;
    lead.hidden = Boolean(chosen);
    if (chosen) {
      setText(earlier.firstChild, `An earlier run, ${dayMonth(chosen.ts)} at ${clock(chosen.ts)}. ${chosen.ok ? 'It passed.' : 'It failed, and is kept.'}`);
    }
    if (attempts === 0) {
      setText(lead, 'No checks have run yet. Venezia runs them itself, and no AI decides when it is done.');
    } else if (status === 'running') {
      setText(lead, `Checking, try ${attempts}. Venezia is doing this itself, no AI is involved.`);
    } else if (status === 'passed') {
      setText(lead, attempts === 1 ? 'Passed on the first try.' : `Passed on try ${attempts}.`);
    } else if (status === 'idle') {
      setText(lead, 'The last gate run did not finish. That says nothing about the project, and it runs again.');
    } else {
      setText(lead, `Failed on try ${attempts}.`);
    }

    const shownSteps = chosen ? chosen.steps : ship.gate.steps;
    syncList(steps, shownSteps, (step, index) => `${chosen?.seq ?? attempts}-${index}`, () => h('li', {},
      h('span', { class: 'gate-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'gate-name' }),
      h('span', { class: 'gate-ms' }),
      h('span', { class: 'gate-note' })), (node, step) => {
      node.dataset.ok = step.ok;
      const [, name, ms, note] = node.children;
      setText(name, gateStep(step.step).name);
      setText(ms, seconds(step.ms));
      setText(note, step.detail ?? '');
      node.children[0].textContent = step.ok ? '✓' : '×';
      name.setAttribute('aria-label', `${gateStep(step.step).name}: ${step.ok ? 'passed' : 'failed'}`);
    });

    const verdict = chosen ? null : ship.review;
    review.hidden = !verdict;
    if (verdict) {
      const [, words, list] = review.children;
      setText(words, verdict.verdict === 'accepted' ? 'Accepted. Never the same worker that built it.' : 'Asked for changes.');
      syncList(list, verdict.findings, (finding, index) => index, () => h('li'), (node, finding) => {
        const cited = [finding.evidence].flat().map((item) => (typeof item === 'string' ? item : item?.ref ?? item?.file ?? '')).filter(Boolean).join(', ');
        setText(node, `${finding.severity ? `${finding.severity}: ` : ''}${finding.text ?? finding.claim ?? ''}${cited ? ` (${cited})` : ''}`);
      });
    }

    const held = ship.receipt;
    receipt.hidden = !held || Boolean(chosen);
    if (held) {
      const voided = held.voided;
      receipt.classList.toggle('voided', voided);
      const [title, words, hashes] = receipt.lastChild.children;
      setText(title, voided ? 'Receipt voided' : 'Receipt');
      setText(words, voided
        ? `${(held.voidReason ?? 'The code changed after the gate').replace(/\.?$/, '.')} Proof no longer stands until the gate passes again.`
        : `Signed by Venezia on ${dayMonth(held.issuedAt)} at ${clock(held.issuedAt)}. Any later change to the code voids it.`);
      syncList(hashes, [['Commit', held.commit], ['Contract', held.contractHash], ['Evidence', held.evidenceHash]].flatMap(([term, value]) => [
        { key: `t${term}`, tag: 'dt', text: term },
        { key: `d${term}`, tag: 'dd', text: shortHash(value) },
      ]), (row) => row.key, (row) => h(row.tag), (node, row) => setText(node, row.text));
    }

    drawShots(ship, chosen ?? lastRun, !chosen);

    const finished = history.filter((run) => run.ok !== null);
    runsHead.hidden = finished.length < 2;
    runs.hidden = finished.length < 2;
    syncList(runs, finished, (run) => run.seq, (run) => h('li', {}, h('button', {
      type: 'button', class: 'gate-run', onclick: () => pin(run === lastRun ? null : run.seq),
    }, h('span', { class: 'gate-mark', 'aria-hidden': 'true' }), h('span'))), (node, run) => {
      node.dataset.ok = run.ok;
      const [mark, words] = node.firstChild.children;
      mark.textContent = run.ok ? '✓' : '×';
      const failed = run.steps.find((step) => !step.ok);
      setText(words, `${clock(run.ts)}  ${run.ok ? `Passed, ${plural(run.steps.length, 'step')}` : `Failed at ${gateStep(failed?.step ?? 'host').name.toLowerCase()}`}`);
      if (run.seq === (chosen ?? lastRun)?.seq) node.firstChild.setAttribute('aria-current', 'true');
      else node.firstChild.removeAttribute('aria-current');
    });
  }

  return {
    el,
    update,
    /** Open the run that a tile came from, or null for the latest. */
    openRun(tileSeq) {
      pinned = null;
      wantedTile = tileSeq ?? null;
    },
  };
}
