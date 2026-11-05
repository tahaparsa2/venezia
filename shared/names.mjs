// Deterministic Venetian hull names. Runs in Node and the browser: no Node imports.
// Names are one or two plain ASCII words, because voice addresses a ship by name.

export const HULL_NAMES = Object.freeze([
  // Virtues and hopes
  'Aurora', 'Fortuna', 'Vittoria', 'Speranza', 'Serena', 'Prudenza', 'Costanza', 'Clemenza',
  'Concordia', 'Giustizia', 'Fede', 'Pace', 'Gloria', 'Stella', 'Luna', 'Alba', 'Marea', 'Laguna',
  // The eight winds
  'Tramontana', 'Greco', 'Levante', 'Scirocco', 'Ostro', 'Libeccio', 'Ponente', 'Maestro',
  // The lagoon and the city
  'Rialto', 'Dogana', 'Zattere', 'Giudecca', 'Murano', 'Burano', 'Torcello', 'Lido', 'Malamocco',
  'Chioggia', 'Pellestrina', 'Mazzorbo', 'Cannaregio', 'Castello', 'Dorsoduro', 'San Polo', 'Altino',
  // Ports of the sea road
  'Zara', 'Corfu', 'Candia', 'Negroponte', 'Modone', 'Corone', 'Ragusa', 'Spalato', 'Cattaro',
  'Cerigo', 'Zante', 'Cefalonia', 'Famagosta',
  // Yard and water words
  'Bricola', 'Altana', 'Felze', 'Forcola', 'Squero', 'Campiello', 'Bucintoro', 'Traghetto',
  // Painters
  'Tiziano', 'Tintoretto', 'Veronese', 'Bellini', 'Carpaccio', 'Giorgione', 'Tiepolo', 'Canaletto',
]);

/** FNV-1a over UTF-16 code units: small, stable, and the same in every runtime. */
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

const NUMERALS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Lower case, no accents, no punctuation: the form used to compare spoken and written names. */
export function normaliseName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name for a seed, which is normally the ship id. The same seed and the same taken
 * names always give the same result. If every name is taken, a numeral is added.
 * @param {string} seed
 * @param {Iterable<string>} [taken] names already in use, compared after normalising
 */
export function hullName(seed, taken = []) {
  const used = new Set();
  for (const name of taken) used.add(normaliseName(name));
  const start = hash(String(seed)) % HULL_NAMES.length;
  const isFree = (name) => !used.has(normaliseName(name));
  for (const suffix of ['', ...NUMERALS]) {
    for (let i = 0; i < HULL_NAMES.length; i++) {
      const base = HULL_NAMES[(start + i) % HULL_NAMES.length];
      const name = suffix ? `${base} ${suffix}` : base;
      if (isFree(name)) return name;
    }
  }
  // Over 800 live names in one factory. Fall back to something unique and still speakable.
  return `${HULL_NAMES[start]} ${hash(`${seed}/${used.size}`) % 100000}`;
}
