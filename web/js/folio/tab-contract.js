// Contract: what "done" means. Each criterion ticks twice: built, in verdigris, because that is
// only a worker's word, then proven, in gold, because the host saw it. Gold only where proven.

import { h, plural, setText, shortHash, syncList } from '/js/folio/dom.js';
import { readContract } from '/js/folio/evidence.js';

const MARKS = {
  open: 'Not built yet',
  active: 'Being built',
  built: 'Built, not yet proven',
  failed: 'Built, but a check failed',
  proven: 'Checked by Venezia',
  not_met: 'The reviewer says this is not met',
  unproven: 'The reviewer could not confirm this',
};

/** The promises as they were put to you, on the newest contract card. A small hull has no card. */
function cardFor(state, shipId) {
  let found = null;
  for (const decision of Object.values(state.decisions)) {
    if (decision.shipId !== shipId || decision.kind !== 'contract' || !Array.isArray(decision.detail?.acceptance)) continue;
    if (!found || decision.createdAt >= found.createdAt) found = decision;
  }
  return found?.detail ?? null;
}

/** How the host will prove one promise, from what the contract names against it. */
function proofOf(criterion) {
  const parts = [];
  if (criterion.tests?.length) parts.push(plural(criterion.tests.length, 'locked test'));
  if (criterion.smoke?.length) parts.push(plural(criterion.smoke.length, 'browser step'));
  if (criterion.golden?.length) parts.push(plural(criterion.golden.length, 'expected output'));
  return parts.join(', ');
}

export function createContractTab(ctx) {
  const lead = h('p', { class: 'tab-lead' });
  const list = h('ol', { class: 'criteria', 'aria-label': 'Acceptance criteria' });
  const legend = h('p', { class: 'contract-legend' });
  const scope = h('div', { class: 'contract-scope', hidden: true }, h('h3', { class: 'rub', text: 'Out of scope' }), h('ul'));
  const seal = h('dl', { class: 'fact-list contract-seal' });
  const sealHead = h('h3', { class: 'rub', text: 'Locked' });
  const el = h('div', { class: 'tab tab-contract', role: 'tabpanel' },
    h('div', { class: 'tab-body' }, lead, list, legend, scope, sealHead, seal));

  /** A voided receipt means the proof was for code that is no longer the code. */
  const stands = (ship) => ship.gate.status === 'passed' && !ship.receipt?.voided;

  /** Contracts read from the host, by hash, so each is asked for once. */
  const locked = new Map();

  /**
   * The contract to show: the card when it is the locked one, otherwise the host's copy. Until
   * that answers, and if it never does, the work items are the closest true list.
   */
  function contractOf(ship, state) {
    const card = cardFor(state, ship.id);
    const hash = ship.artifacts.contract?.hash;
    if (!hash || (card && (card.hash ?? hash) === hash)) return card;
    if (!locked.has(hash)) {
      locked.set(hash, null);
      readContract(ctx.store, ship.id).then((contract) => {
        locked.set(hash, contract);
        if (contract) ctx.redraw();
      });
    }
    return locked.get(hash) ?? card;
  }

  function markOf(ship, status, verdict) {
    if (verdict === 'not_met' || verdict === 'unproven') return verdict;
    if (stands(ship) && (status === 'done' || status === undefined)) return 'proven';
    if (status === 'active') return 'active';
    if (status !== 'done') return 'open';
    return ship.gate.status === 'failed' ? 'failed' : 'built';
  }

  function update(ship, state) {
    const contract = contractOf(ship, state);
    const judged = new Map((ship.review?.criteria ?? []).map((entry) => [entry.id, entry]));
    const items = contract
      ? contract.acceptance.map((criterion) => {
        const doers = ship.items.filter((item) => item.acceptance?.includes(criterion.id));
        const status = doers.length === 0 ? undefined
          : doers.every((item) => item.status === 'done') ? 'done'
            : doers.some((item) => item.status === 'active') ? 'active' : 'planned';
        return { id: criterion.id, title: criterion.text, status, how: proofOf(criterion) || criterion.check };
      })
      : ship.items;
    const hasContract = Boolean(ship.artifacts.contract);
    const marks = items.map((item) => markOf(ship, item.status, judged.get(item.id)?.status));
    const proven = marks.filter((mark) => mark === 'proven').length;

    if (items.length === 0) {
      setText(lead, hasContract ? 'The contract is written. Its work items are coming.' : 'The planner has not written the contract yet. It says what done means, before any code.');
    } else {
      setText(lead, proven === items.length
        ? `All ${items.length} proven by Venezia itself, not by an AI's word.`
        : `${proven} of ${items.length} proven. A tick only turns gold when Venezia has seen it work.`);
    }

    syncList(list, items.map((item, index) => ({ ...item, mark: marks[index] })), (item) => item.id, () => h('li', {},
      h('span', { class: 'tick', 'aria-hidden': 'true' }),
      h('span', { class: 'criterion' }, h('span', { class: 'criterion-text' }), h('span', { class: 'criterion-state' }))), (node, item) => {
      node.dataset.mark = item.mark;
      const [text, status] = node.lastChild.children;
      setText(text, item.title ?? item.id);
      const said = judged.get(item.id)?.note;
      const check = item.how && item.mark !== 'proven' ? `. Check: ${item.how}` : '';
      setText(status, `${MARKS[item.mark]}${item.mark === 'not_met' || item.mark === 'unproven' ? (said ? `: ${said}` : '') : check}`);
    });

    legend.hidden = true;
    const out = contract?.outOfScope ?? [];
    scope.hidden = out.length === 0;
    syncList(scope.lastChild, out, (line) => line, (line) => h('li', { text: line }));

    const artifact = ship.artifacts.contract;
    // Nothing is locked until a person or the rules have let it through.
    const draft = !artifact || ['contracting', 'awaiting_contract', 'intake', 'awaiting_answers'].includes(ship.state);
    setText(sealHead, draft ? 'Draft' : 'Locked');
    const rows = artifact
      ? [['Version', `${ship.contractVersion}`], ['Hash', shortHash(artifact.hash)],
        draft ? ['Status', 'A draft. It is locked once it is approved.'] : ['Held', 'Outside the yard, so no worker can edit it']]
      : [['Version', `${ship.contractVersion}`], ['Status', 'Not written yet']];
    syncList(seal, rows.flatMap(([term, value]) => [{ key: `t${term}`, tag: 'dt', text: term }, { key: `d${term}`, tag: 'dd', text: value }]),
      (row) => row.key, (row) => h(row.tag), (node, row) => setText(node, row.text));
  }

  return { el, update };
}
