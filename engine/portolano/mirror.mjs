// Human-readable memory (SPEC 10). The database decides what workers see, and these files
// are a mirror of it: one file per lesson, plus the Mariegola, which is only ever appended to.

import fs from 'node:fs';
import path from 'node:path';

import { fileSlug, isoDate, oneLine, writeIfChanged } from './text.mjs';

const NOTES_MARK = '<!-- Your notes: anything below this line is kept when this file is rewritten. -->';

const MARIEGOLA_HEADER = `# Mariegola

The rulebook of this factory. A rule is a lesson you confirmed as law, and every worker is given it from then on.

Entries are added at the end with their date, and are never edited in place. When a rule is withdrawn, a later entry says so and the original stays.
`;

const yaml = (value) => JSON.stringify(value ?? null);

function lessonFile(lesson) {
  const front = [
    '---',
    `id: ${yaml(lesson.id)}`,
    `kind: ${yaml(lesson.kind)}`,
    `status: ${yaml(lesson.status)}`,
    `tags: ${yaml(lesson.tags)}`,
    `source: ${yaml(lesson.sourceShipId)}`,
    `uses: ${lesson.uses}`,
    `wins: ${lesson.wins}`,
    `losses: ${lesson.losses}`,
    `created: ${yaml(isoDate(lesson.createdAt))}`,
    `confirmed: ${yaml(lesson.confirmedAt === null ? null : isoDate(lesson.confirmedAt))}`,
    '---',
  ].join('\n');
  const lines = [front, '', `# ${oneLine(lesson.text)}`, ''];
  if (lesson.why) lines.push(`**Why:** ${oneLine(lesson.why)}`, '');
  if (lesson.howToApply) lines.push(`**How to apply:** ${oneLine(lesson.howToApply)}`, '');
  return `${lines.join('\n')}${NOTES_MARK}\n`;
}

/** @param {string} dir the `portolano/` folder */
export function createMirror(dir) {
  const lessonsDir = path.join(dir, 'lessons');
  const mariegola = path.join(dir, 'mariegola.md');

  function readMariegola() {
    try {
      return fs.readFileSync(mariegola, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mariegola, MARIEGOLA_HEADER, { flag: 'wx' });
      return MARIEGOLA_HEADER;
    }
  }

  /** Append an entry once. The marker makes this safe to repeat after a crash. */
  function appendOnce(marker, entry) {
    const current = readMariegola();
    if (current.includes(marker)) return false;
    const gap = current.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(mariegola, `${gap}${entry}`);
    return true;
  }

  /** Mirror one lesson, keeping anything the owner wrote under the notes line. */
  function writeLesson(lesson) {
    const file = path.join(lessonsDir, `${fileSlug(lesson.id)}.md`);
    let notes = '';
    try {
      const current = fs.readFileSync(file, 'utf8');
      const at = current.indexOf(NOTES_MARK);
      if (at >= 0) notes = current.slice(at + NOTES_MARK.length + 1);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return writeIfChanged(file, `${lessonFile(lesson)}${notes}`);
  }

  function appendLaw(lesson) {
    const marker = `<!-- law:${fileSlug(lesson.id)} -->`;
    const lines = [`## ${isoDate(lesson.confirmedAt)}: ${oneLine(lesson.text)}`, marker, ''];
    if (lesson.why) lines.push(`Why: ${oneLine(lesson.why)}`, '');
    if (lesson.howToApply) lines.push(`How to apply: ${oneLine(lesson.howToApply)}`, '');
    const source = lesson.sourceShipId ? `Learned on ${oneLine(lesson.sourceShipId)}. ` : '';
    lines.push(`${source}Record when confirmed: ${lesson.wins} wins, ${lesson.losses} losses.`, '');
    return appendOnce(marker, lines.join('\n'));
  }

  function appendWithdrawal(lesson, ts) {
    const marker = `<!-- withdrawn:${fileSlug(lesson.id)} -->`;
    const entry = `## ${isoDate(ts)}: Withdrawn\n${marker}\n\nThis rule no longer applies: ${oneLine(lesson.text)}\n`;
    return appendOnce(marker, entry);
  }

  /**
   * Bring the mirror up to date with one lesson.
   * @param {object} lesson
   * @param {number} [burnedAt] when it burned, if it did
   */
  function sync(lesson, burnedAt) {
    writeLesson(lesson);
    if (lesson.confirmedAt === null) return;
    appendLaw(lesson);
    if (lesson.status === 'burned') appendWithdrawal(lesson, burnedAt ?? lesson.confirmedAt);
  }

  return { sync, readMariegola, path: mariegola, lessonsDir };
}
