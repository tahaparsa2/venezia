// What a secret looks like, and how to keep one out of anything the host writes down. Logs,
// step details and events are read by later workers and paired devices, so nothing command
// output says reaches them unredacted.

export const SECRET_PATTERNS = Object.freeze([
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'anthropic'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'github'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, 'github'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'google'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'pem'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'openai-like'],
  [/\b[sr]k_live_[0-9A-Za-z]{16,}/, 'stripe'],
  [/\bxox[baprs]-[0-9A-Za-z-]{20,}/, 'slack'],
]);

const REPLACERS = SECRET_PATTERNS.map(([pattern, type]) => [new RegExp(pattern.source, 'g'), `[${type} secret removed]`]);

/** Text with every secret replaced by its kind. */
export function redact(text) {
  let clean = String(text ?? '');
  for (const [pattern, label] of REPLACERS) clean = clean.replace(pattern, label);
  return clean;
}

/** The same for every string inside a value. Keys and shapes stay as they are. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}
