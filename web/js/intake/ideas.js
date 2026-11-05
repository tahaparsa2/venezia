// The words of the mouth. Three starters, so a new person is never stuck, and a size hint that
// only ever hints: left alone, the planner decides, as `ship.create` allows.

export const STARTERS = Object.freeze([
  'A one-page menu for my favourite bacaro',
  'A tide table that warns of high water',
  'A packing list that remembers for me',
]);

const LARGE = /\b(platform|marketplace|multi[- ]?tenant|accounts?|logins?|sign[- ]?ups?|payments?|checkout|subscriptions?|admin|dashboard for|roles|permissions|inventory|stock|orders)\b/i;
const MIDDLE = /\b(calendar|booking|forms?|map|search|sync|upload|photos?|server|api|database|offline|chart|email|notifications?)\b/i;

/**
 * A guess at the size from the words alone. Only a hint: it says so, and it sends nothing.
 * @returns {'gondola'|'galley'|'galleass'|null}
 */
export function sizeHint(idea) {
  const text = idea.trim();
  if (text.length < 8) return null;
  const words = text.split(/\s+/).length;
  // The starters promise a written-down contract, so they take the path that has one.
  if (STARTERS.includes(text)) return 'galley';
  if (LARGE.test(text) || words > 45) return 'galleass';
  if (MIDDLE.test(text) || words > 18) return 'galley';
  return 'gondola';
}

/** Choosing a size is a choice, so it speaks plain English and always says what it costs. */
export const SIZE_WORDS = Object.freeze({
  gondola: { name: 'Sketch', says: 'Skips contract review' },
  galley: { name: 'Build', says: 'You approve a contract' },
  galleass: { name: 'Platform', says: 'Several contract milestones' },
});

export const SIZE_BLURB = Object.freeze({
  gondola: 'Small and well defined. No questions, and it skips contract review.',
  galley: 'A normal project. It asks what it needs to know, and you approve a contract.',
  galleass: 'Large, with several contract milestones to approve.',
});
