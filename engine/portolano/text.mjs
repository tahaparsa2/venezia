// Small text helpers for memory and docs. Most of what passes through here started as
// yard-authored text, which is untrusted, so these keep it on one line and inert.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Roughly how many tokens a string costs. Four characters a token is the usual rule for
 * English, and rounding up keeps a budget on the safe side.
 * @param {string} text
 */
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

/** Control and invisible characters. Line breaks are whitespace, so they become spaces first. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Make untrusted text safe to place in a document or a prompt: one line, no control
 * characters, and no angle brackets, so it cannot close a block or open a comment.
 * @param {unknown} text
 * @param {number} [max] cut to this many characters
 */
export function oneLine(text, max) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .trim();
  return max !== undefined && flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The same, safe for a Markdown table cell. */
export const tableCell = (text, max) => oneLine(text, max).replaceAll('|', '\\|');

/** Words too common to tell one lesson from another. */
const STOPWORDS = new Set(`a an and are as at be but by can do does for from get go has have how i if in into is it its
 just like make me my need no not of on one or our so some than that the their them then there these they this to too
 up us use want was we what when where which who why will with would you your app thing something`.split(/\s+/));

/**
 * The words of a text worth searching for.
 * @param {string} text
 * @returns {string[]}
 */
export function keywords(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
}

/** Credential shapes. Lessons are mirrored into a folder committed to git. */
const SECRETS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}/,
];

/** @param {string} text */
export const hasSecret = (text) => SECRETS.some((pattern) => pattern.test(text));

/**
 * Text that tries to steer a worker past its doctrine or its confinement. Lessons only
 * ever inform guidance, so one of these is refused. This stops careless or copied text;
 * the real defence is that a lesson reaches only the labelled notes block, never a setting.
 */
const OVERRIDES = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(instructions?|rules?|doctrine|contract|system prompt)\b/i,
  /\b(bypass|disable|turn off|skip)\b.{0,30}\b(sandbox|permissions?|gate|hooks?|checks?)\b/i,
  /--dangerously|bypassPermissions|allowedTools|--tools\b|--settings\b/i,
];

/** @param {string} text */
export const isOverride = (text) => OVERRIDES.some((pattern) => pattern.test(text));

/**
 * A file name for an id. Ids reach this from events, so it must stay in its folder.
 * @param {string} id
 */
export function fileSlug(id) {
  const slug = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot name a file after "${id}"`);
  return slug;
}

/**
 * Write a file whole or not at all, and leave it alone if nothing changed.
 * @param {string} file
 * @param {string} text
 * @returns {boolean} whether the file changed
 */
export function writeIfChanged(file, text) {
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
  return true;
}

/** @param {number} ts */
export const isoDate = (ts) => new Date(ts).toISOString().slice(0, 10);
/** @param {number} ts */
export const isoMinute = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')}Z`;
