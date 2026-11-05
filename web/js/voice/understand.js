// A small reading of what was said, for when the server's grammar is not on the line (the demo,
// and Web Speech). It only finds a hull name and a steering verb. The real grammar and its
// decision rules are in engine/voice/intent.mjs, and nothing here can answer a decision.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LEADING = [
  [/^(?:right now|immediately|now|change course)[:,]?\s+(?:and\s+)?/i, 'now'],
  [/^(?:when you(?:'re| are)? (?:finish(?:ed)?|done)|once you(?:'re| are)? done|next|after that|afterwards)[:,]?\s+/i, 'next'],
];
const TRAILING = [
  [/[,\s]+(?:right now|immediately)[.!]?$/i, 'now'],
  [/[,\s]+(?:when you(?:'re| are)? (?:finish(?:ed)?|done)|after that|next)[.!]?$/i, 'next'],
];

const sentence = (text) => {
  const trimmed = text.trim().replace(/[.!]+$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

/**
 * @param {string} said
 * @param {{ships: Record<string, any>}} state
 * @returns {{shipId: string|null, verb: 'nudge'|'next'|'now', text: string}}
 */
export function understand(said, state) {
  let body = said.trim();
  let shipId = null;

  const ships = Object.values(state.ships)
    .filter((ship) => ship.name && ship.state !== 'scuttled')
    .sort((a, b) => b.name.length - a.name.length);
  for (const ship of ships) {
    const name = escape(ship.name);
    const match = new RegExp(`^(?:(?:hey|ok|okay),?\\s+)?(?:(?:tell|ask|have|get)\\s+${name}\\s+(?:to\\s+)?|${name}[,:]?\\s+)(.+)$`, 'i').exec(body);
    if (match) {
      shipId = ship.id;
      [, body] = match;
      break;
    }
  }

  let verb = 'nudge';
  for (const [pattern, name] of [...LEADING, ...TRAILING]) {
    if (!pattern.test(body)) continue;
    verb = name;
    body = body.replace(pattern, '');
    break;
  }
  return { shipId, verb, text: sentence(body) };
}
