// JSON schemas for every typed artifact (SPEC 5.2), a small checker for them, and the
// rules a schema cannot state. The schemas are passed to `--json-schema` as they are, so
// they stay plain: no `$ref`, nothing outside the keywords `validate` understands.
//
// Every check returns a list of plain-English problems. An empty list is a pass.

import { LESSON_KINDS, LESSON_TEXT_MAX, SIZES } from '../../shared/vocabulary.mjs';

const str = (extra = {}) => ({ type: 'string', minLength: 1, ...extra });
const list = (items, extra = {}) => ({ type: 'array', items, ...extra });
const strings = (extra = {}) => list(str(), extra);
const object = (properties, required = Object.keys(properties), extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
const SHA256 = '^[0-9a-f]{64}$';
const ITEM_ID = '^[A-Za-z0-9][A-Za-z0-9_-]*$';

export const BRIEF = object({
  schema: { const: 1 },
  title: str({ maxLength: 80 }),
  summary: str({ maxLength: 400 }),
  wellDefined: { type: 'boolean' },
  size: { enum: [...SIZES] },
  kind: { enum: ['web', 'cli', 'library'] },
  audience: str(),
  doneWhen: strings({ minItems: 1 }),
  mustNotChange: strings(),
  outOfScope: strings(),
  constraints: strings(),
  questions: list(object({
    id: str(),
    text: str({ maxLength: 240 }),
    why: str({ maxLength: 240 }),
    options: list(object({
      id: str(),
      label: str({ maxLength: 120 }),
      recommended: { type: 'boolean' },
    }, ['id', 'label']), { minItems: 2, maxItems: 4 }),
  }), { maxItems: 3 }),
});

const smokeSteps = [
  object({ click: str() }),
  object({ fill: str(), value: { type: 'string' } }),
  object({ press: str() }),
  object({ expectText: str() }),
  object({ expectCount: str(), n: { type: 'integer', minimum: 0 } }),
];

export const CONTRACT = {
  type: 'object',
  required: ['schema', 'title', 'kind', 'acceptance', 'test', 'minTests', 'locked'],
  // Open at the top level: host profiles and gate options can be added without a schema change.
  properties: {
    schema: { const: 1 },
    title: str(),
    kind: { enum: ['web', 'cli', 'library'] },
    static: { type: 'boolean' },
    outDir: str(),
    build: str(),
    install: str(),
    pack: str(),
    start: str(),
    test: str(),
    minTests: { type: 'integer', minimum: 1 },
    health: str({ pattern: '^/' }),
    acceptance: list(object({
      id: str({ pattern: ITEM_ID }),
      text: str(),
      smoke: list({ type: 'integer', minimum: 0 }),
      tests: strings(),
      golden: list({ type: 'integer', minimum: 0 }),
    }, ['id', 'text']), { minItems: 1 }),
    smoke: list({ anyOf: smokeSteps }),
    golden: list(object({
      run: str(),
      stdout: { type: 'string' },
      exit: { type: 'integer' },
    }, ['run'])),
    outOfScope: strings(),
    locked: object({
      files: { type: 'object', additionalProperties: str({ pattern: SHA256 }) },
      scripts: { type: 'object', additionalProperties: str() },
    }),
  },
};

export const WORKITEMS = object({
  schema: { const: 1 },
  items: list(object({
    id: str({ pattern: ITEM_ID }),
    title: str({ maxLength: 80 }),
    type: { enum: ['code', 'docs'] },
    size: { enum: ['small', 'medium', 'large'] },
    summary: str({ maxLength: 200 }),
    spec: object({
      files: strings({ minItems: 1 }),
      interfaces: strings(),
      notes: { type: 'string' },
    }),
    dependsOn: strings(),
    acceptance: strings(),
    checks: strings({ minItems: 1 }),
  }), { minItems: 1 }),
});

/** One pointer at something the host can check exists. */
const citation = object({
  kind: { enum: ['step', 'screenshot', 'log', 'file'] },
  ref: str(),
}, ['kind', 'ref']);

export const REVIEW = object({
  schema: { const: 1 },
  verdict: { enum: ['accepted', 'rejected', 'gap'] },
  summary: str({ maxLength: 600 }),
  criteria: list(object({
    id: str(),
    status: { enum: ['met', 'not_met', 'unproven'] },
    note: { type: 'string' },
    evidence: list(citation, { minItems: 1 }),
  }), { minItems: 1 }),
  findings: list(object({
    severity: { enum: ['blocker', 'major', 'minor'] },
    claim: str(),
    expected: str(),
    criterion: { type: 'string' },
    evidence: list(citation, { minItems: 1 }),
  }, ['severity', 'claim', 'expected', 'evidence'])),
});

/** A draft lesson as the Scrivano returns it. `evidence` holds signal numbers from its brief. */
export const LESSON_DRAFT = object({
  kind: { enum: [...LESSON_KINDS] },
  text: str({ maxLength: LESSON_TEXT_MAX }),
  why: str({ maxLength: LESSON_TEXT_MAX }),
  howToApply: str({ maxLength: LESSON_TEXT_MAX }),
  tags: strings({ minItems: 1, maxItems: 8 }),
  evidence: list({ type: 'integer', minimum: 1 }, { minItems: 1 }),
});

export const RETRO = object({
  schema: { const: 1 },
  simple: str({ maxLength: 1500 }),
  technical: str({ maxLength: 4000 }),
  commentary: str({ maxLength: 4000 }),
  worked: strings(),
  hurt: strings(),
  lessons: list(LESSON_DRAFT, { maxItems: 5 }),
});

/**
 * What a builder or repairer returns. Host checks decide the outcome, so `status: 'done'` is
 * a claim and moves nothing. `status: 'gap'` is taken at its word, since stopping is safe.
 */
export const REPORT = object({
  schema: { const: 1 },
  status: { enum: ['done', 'gap'] },
  summary: str({ maxLength: 600 }),
  gap: { type: 'string' },
  commands: list(object({ run: str(), output: { type: 'string' } })),
  noticed: strings(),
}, ['schema', 'status', 'summary', 'commands']);

export const SCHEMAS = Object.freeze({
  brief: BRIEF, contract: CONTRACT, workitems: WORKITEMS, review: REVIEW, retro: RETRO, report: REPORT,
});

function matchesType(type, value) {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'null': return value === null;
    default: return typeof value === type;
  }
}

/**
 * Check a value against a schema, using the subset of JSON Schema above.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [where] the path to the value, for messages
 * @returns {string[]}
 */
export function validate(schema, value, where = 'value') {
  if ('const' in schema && value !== schema.const) return [`${where} must be ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${where} must be one of: ${schema.enum.join(', ')}`];
  if (schema.anyOf) {
    return schema.anyOf.some((option) => validate(option, value, where).length === 0)
      ? [] : [`${where} does not match any allowed form`];
  }
  if (schema.type && !matchesType(schema.type, value)) return [`${where} must be of type ${schema.type}`];

  const problems = [];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) problems.push(`${where} cannot be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${where} is too long (limit ${schema.maxLength} characters)`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${where} has the wrong form`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${where} must be at least ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${where} needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${where} can have at most ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => problems.push(...validate(schema.items, item, `${where}[${index}]`)));
  }
  if (matchesType('object', value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) problems.push(`${where}.${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (Object.hasOwn(properties, name)) problems.push(...validate(properties[name], item, `${where}.${name}`));
      else if (schema.additionalProperties === false) problems.push(`${where}.${name} is not allowed`);
      else if (typeof schema.additionalProperties === 'object') problems.push(...validate(schema.additionalProperties, item, `${where}.${name}`));
    }
  }
  return problems;
}

/* Guess language: these words mark a guess, and a guess is not a finding. */

const GUESS_PATTERN = /\b(appears? to|appeared to|seems?|seemed|likely|unlikely|probably|presumably|perhaps|might|should work|should pass|should be fine|i think|i believe|i assume|i suspect|looks like|as far as i can tell)\b/gi;

/**
 * @param {string} text
 * @returns {string[]} the guess phrases found, lower case, without repeats
 */
export function findGuessLanguage(text) {
  return [...new Set((String(text).match(GUESS_PATTERN) ?? []).map((phrase) => phrase.toLowerCase()))];
}

/* Rules beyond the schemas. */

/** @param {object} brief */
export function checkBrief(brief) {
  const problems = validate(BRIEF, brief, 'brief');
  if (problems.length) return problems;
  if (brief.size === 'gondola' && !brief.wellDefined) problems.push('A sketch must be well defined. Size it up or ask a question');
  if (brief.size === 'gondola' && brief.questions.length) problems.push('A sketch asks no questions');
  if (!brief.wellDefined && brief.questions.length === 0) problems.push('The intent is not well defined, so at least one question is needed');
  brief.questions.forEach((question) => {
    if (question.options.filter((option) => option.recommended).length !== 1) {
      problems.push(`Question ${question.id} needs exactly one recommended option`);
    }
  });
  const ids = brief.questions.map((question) => question.id);
  if (new Set(ids).size !== ids.length) problems.push('Question ids must be different');
  return problems;
}

const isExpectation = (step) => step && ('expectText' in step || 'expectCount' in step);

/** Commands that exit 0 whatever the code does. */
const HOLLOW_SCRIPT = /^\s*(exit\s+0|true|:|echo\b.*)\s*(;|$)/;

function checkAcceptance(contract, problems) {
  const lockedFiles = contract.locked.files;
  const smoke = contract.smoke ?? [];
  const golden = contract.golden ?? [];
  const seen = new Set();
  for (const criterion of contract.acceptance) {
    if (seen.has(criterion.id)) problems.push(`Criterion ${criterion.id} appears twice`);
    seen.add(criterion.id);
    const steps = criterion.smoke ?? [];
    const tests = criterion.tests ?? [];
    const goldens = criterion.golden ?? [];
    if (!steps.length && !tests.length && !goldens.length) {
      problems.push(`Criterion ${criterion.id} maps to no smoke step, test or golden command, so nothing proves it`);
    }
    for (const index of steps) if (!smoke[index]) problems.push(`Criterion ${criterion.id} names smoke step ${index}, which does not exist`);
    for (const index of goldens) if (!golden[index]) problems.push(`Criterion ${criterion.id} names golden command ${index}, which does not exist`);
    if (steps.length && !steps.some((index) => isExpectation(smoke[index]))) {
      problems.push(`Criterion ${criterion.id} has smoke steps but none of them asserts anything`);
    }
    for (const test of tests) {
      if (!Object.hasOwn(lockedFiles, test)) problems.push(`Criterion ${criterion.id} names ${test}, which is not a locked test`);
    }
  }
}

function checkWebContract(contract, problems) {
  const scripts = contract.locked.scripts;
  if (!contract.smoke?.length) problems.push('A web contract needs smoke steps');
  if (!contract.start) problems.push('A web contract needs a start command');
  if (contract.static && !contract.outDir) problems.push('A static contract needs outDir');
  for (const name of ['build', 'start']) {
    if (!scripts[name]) problems.push(`The ${name} script must be locked`);
  }
  const typed = (contract.smoke ?? []).filter((step) => 'fill' in step);
  if (typed.length && !typed.some((step) => step.value.includes('$NONCE'))) {
    problems.push('A step that types input must use $NONCE, so the app cannot hard-code the answer');
  }
  if (typed.some((step) => step.value.includes('$NONCE'))
    && !(contract.smoke ?? []).some((step) => step.expectText?.includes('$NONCE'))) {
    problems.push('Typed $NONCE input needs an expectText that looks for $NONCE');
  }
}

/** Is every path a plain relative path inside the project? */
const isInsideProject = (file) => !file.startsWith('/') && !file.split(/[\\/]/).includes('..');

/**
 * The host's check of a contract (SPEC 5.2): the schema, and that every acceptance
 * criterion is proved by something a machine runs.
 * @param {object} contract
 */
export function checkContract(contract) {
  const problems = validate(CONTRACT, contract, 'contract');
  if (problems.length) return problems;

  checkAcceptance(contract, problems);
  if (contract.kind === 'web') checkWebContract(contract, problems);
  else if (!contract.golden?.length) problems.push('A command or library contract needs golden commands');

  const { files, scripts } = contract.locked;
  if (Object.keys(files).length === 0) problems.push('At least one test file must be locked');
  for (const file of Object.keys(files)) {
    if (!isInsideProject(file)) problems.push(`Locked file ${file} must be a path inside the project`);
  }
  if (!scripts.test) problems.push('The test script must be locked');
  else if (HOLLOW_SCRIPT.test(scripts.test)) problems.push('The test script does not run any tests');
  else if (/\bnode\b.*--test\b/.test(scripts.test) && !/--test-reporter[= ]tap/.test(scripts.test)) {
    problems.push('The test script must use --test-reporter=tap, because the gate counts passing tests from TAP output');
  }
  return problems;
}

/** A check that binds or calls a fixed port, which the jail keeps shut. `${PORT:-4173}` is fine. */
const FIXED_PORT = /\bPORT\b['"]?\s*[:=]\s*['"]?\d|(?:127\.0\.0\.1|localhost):\d/;

/**
 * The work items, against each other and against the contract.
 * @param {object} workitems
 * @param {object} [contract]
 */
export function checkWorkitems(workitems, contract) {
  const problems = validate(WORKITEMS, workitems, 'workitems');
  if (problems.length) return problems;

  const ids = new Set();
  for (const item of workitems.items) {
    if (ids.has(item.id)) problems.push(`Work item ${item.id} appears twice`);
    ids.add(item.id);
  }
  for (const item of workitems.items) {
    for (const check of item.checks ?? []) {
      if (FIXED_PORT.test(check)) problems.push(`A check on ${item.id} names a port number, but only $PORT is open to it: ${check.slice(0, 120)}`);
    }
  }
  const byId = new Map(workitems.items.map((item) => [item.id, item]));
  for (const item of workitems.items) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) problems.push(`Work item ${item.id} depends on ${dependency}, which does not exist`);
    }
  }

  const finished = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (finished.has(id) || !byId.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const loop = byId.get(id).dependsOn.some(visit);
    visiting.delete(id);
    finished.add(id);
    return loop;
  };
  for (const id of byId.keys()) {
    if (visit(id)) problems.push(`Work item ${id} is part of a dependency loop`);
  }

  if (contract) {
    const criteria = new Set(contract.acceptance.map((criterion) => criterion.id));
    const covered = new Set(workitems.items.flatMap((item) => item.acceptance));
    for (const id of covered) if (!criteria.has(id)) problems.push(`A work item names criterion ${id}, which is not in the contract`);
    for (const id of criteria) if (!covered.has(id)) problems.push(`No work item delivers criterion ${id}`);
  }
  return problems;
}

/**
 * The host's check of a review (SPEC 5.2): the schema, citations that really exist, no
 * guesses, and a verdict the details support. A file citation needs only an `exists`
 * answer, so a caller decides how far to look.
 * @param {object} review
 * @param {{contract?: object, steps?: string[], files?: string[], exists?: (path: string) => boolean}} [context]
 *   `steps`: step ids in evidence.json. `files`: file names in the evidence folder.
 *   `exists`: whether a project path exists. Left out, that kind of citation is not checked.
 */
export function checkReview(review, { contract, steps, files, exists } = {}) {
  const problems = validate(REVIEW, review, 'review');
  if (problems.length) return problems;

  const checkCitation = (owner, { kind, ref }) => {
    const known = kind === 'step' ? steps : (kind === 'screenshot' || kind === 'log') ? files : null;
    if (known && !known.includes(ref)) problems.push(`${owner} cites ${kind} ${ref}, which is not in the evidence`);
    if (kind === 'file' && exists && !exists(ref.replace(/:\d+(-\d+)?$/, ''))) {
      problems.push(`${owner} cites file ${ref}, which does not exist`);
    }
  };
  const checkWords = (owner, text) => {
    const guesses = findGuessLanguage(text);
    if (guesses.length) problems.push(`${owner} uses guess language: ${guesses.join(', ')}`);
  };

  checkWords('The summary', review.summary);
  for (const criterion of review.criteria) {
    checkWords(`Criterion ${criterion.id}`, criterion.note);
    criterion.evidence.forEach((item) => checkCitation(`Criterion ${criterion.id}`, item));
  }
  review.findings.forEach((finding, index) => {
    const owner = `Finding ${index + 1}`;
    checkWords(owner, `${finding.claim} ${finding.expected}`);
    finding.evidence.forEach((item) => checkCitation(owner, item));
  });

  if (contract) {
    const judged = review.criteria.map((criterion) => criterion.id);
    for (const { id } of contract.acceptance) {
      if (!judged.includes(id)) problems.push(`Criterion ${id} was not judged`);
    }
    for (const id of judged) {
      if (!contract.acceptance.some((criterion) => criterion.id === id)) problems.push(`Criterion ${id} is not in the contract`);
    }
  }

  const unmet = review.criteria.filter((criterion) => criterion.status !== 'met');
  const blockers = review.findings.filter((finding) => finding.severity === 'blocker');
  if (review.verdict === 'accepted' && (unmet.length || blockers.length)) {
    problems.push('The verdict is accepted, but a criterion is not met or a blocker is open');
  }
  if (review.verdict === 'rejected' && !unmet.length && !blockers.length) {
    problems.push('The verdict is rejected, but no criterion failed and no blocker is open');
  }
  return problems;
}

/** @param {object} retro */
export function checkRetro(retro) {
  return validate(RETRO, retro, 'retro');
}
