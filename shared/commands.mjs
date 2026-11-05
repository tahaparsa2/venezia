// The command catalog: the one set of verbs every surface sends (SPEC 11).
// Runs in Node and the browser: no Node imports.

import {
  DIALS, LAMP_SLOTS, PUBLISH_TARGETS, SIZES, STEER_VERBS,
} from './vocabulary.mjs';

/**
 * @typedef {object} Field
 * @property {'string'|'integer'|'number'|'boolean'|'object'|'array'|'any'} type
 * @property {boolean} [required]
 * @property {boolean} [nullable]
 * @property {readonly any[]} [oneOf]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]
 * @property {string} [plain] one line of plain English, shown by the CLI and MCP surfaces
 */

const TEXT_MAX = 20000;
const ID_MAX = 200;

/** Small field builders, shared with the event catalog in reducer.mjs. */
export const field = {
  id: (plain, extra = {}) => ({ type: 'string', required: true, maxLength: ID_MAX, plain, ...extra }),
  text: (plain, extra = {}) => ({ type: 'string', required: true, maxLength: TEXT_MAX, plain, ...extra }),
  str: (plain, extra = {}) => ({ type: 'string', required: true, plain, ...extra }),
  oneOf: (values, plain, extra = {}) => ({ type: 'any', required: true, oneOf: values, plain, ...extra }),
  int: (min, max, plain, extra = {}) => ({ type: 'integer', required: true, min, max, plain, ...extra }),
  num: (plain, extra = {}) => ({ type: 'number', required: true, plain, ...extra }),
  bool: (plain, extra = {}) => ({ type: 'boolean', required: true, plain, ...extra }),
  obj: (plain, extra = {}) => ({ type: 'object', required: true, plain, ...extra }),
  list: (plain, extra = {}) => ({ type: 'array', required: true, plain, ...extra }),
  any: (plain, extra = {}) => ({ type: 'any', required: true, plain, ...extra }),
};
const optional = (spec) => ({ ...spec, required: false });

/** @returns {string|null} what is wrong with the value, in plain English */
function checkValue(name, spec, value) {
  if (value === null) return spec.nullable ? null : `${name} cannot be empty`;
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be text`;
      if (spec.required && !spec.nullable && value.trim() === '') return `${name} cannot be empty`;
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return `${name} is too long (limit ${spec.maxLength} characters)`;
      }
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number`;
      if (spec.type === 'integer' && !Number.isInteger(value)) return `${name} must be a whole number`;
      if (spec.min !== undefined && value < spec.min) return `${name} must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `${name} must be at most ${spec.max}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${name} must be true or false`;
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) return `${name} must be an object`;
      break;
    case 'array':
      if (!Array.isArray(value)) return `${name} must be a list`;
      break;
    default:
      break;
  }
  if (spec.oneOf && !spec.oneOf.includes(value)) return `${name} must be one of: ${spec.oneOf.join(', ')}`;
  return null;
}

/**
 * Check an object against a field table.
 * @param {Record<string, any>} value
 * @param {Record<string, Field>} fields
 * @param {{strict?: boolean}} [options] strict refuses fields the table does not name
 * @returns {string|null} the first problem, or null
 */
export function checkFields(value, fields, { strict = false } = {}) {
  for (const [name, spec] of Object.entries(fields)) {
    const present = value[name] !== undefined;
    if (!present) {
      if (spec.required) return `${name} is required`;
      continue;
    }
    const problem = checkValue(name, spec, value[name]);
    if (problem) return problem;
  }
  if (strict) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(fields, name)) return `${name} is not a field of this command`;
    }
  }
  return null;
}

const shipId = field.id('The project id');
const shipOnly = { shipId };

/**
 * Every command in SPEC 11. `plain` is what a person is told the command does.
 * @type {Readonly<Record<string, {plain: string, fields: Record<string, Field>, check?: (c: any) => string|null}>>}
 */
export const COMMANDS = Object.freeze({
  'ship.create': {
    plain: 'Start a new project from an idea',
    fields: {
      idea: field.text('The idea, in your own words'),
      size: optional(field.oneOf(SIZES, 'Project size. Left out, intake decides')),
      autonomy: optional(field.int(0, 2, 'How often to ask you: 0 often, 1 big things, 2 only publishing')),
    },
  },
  'ship.answer': {
    plain: 'Answer the open questions on a project',
    fields: {
      decisionId: field.id('The questions decision'),
      answers: field.any('Your answers, keyed by question id or listed in order'),
    },
    check: (command) => (typeof command.answers === 'object' && command.answers !== null
      ? null : 'answers must be an object or a list'),
  },
  'decision.resolve': {
    plain: 'Choose an option on a decision',
    fields: {
      id: field.id('The decision id'),
      optionId: field.id('The option you chose'),
      note: optional(field.text('A note for the record')),
      token: optional(field.str('The approval token for a decision bound to a payload')),
    },
  },
  steer: {
    plain: 'Send a message to a running project',
    fields: {
      shipId,
      verb: field.oneOf(STEER_VERBS.map((verb) => verb.id), 'nudge folds in, next waits for the turn to end, now changes course'),
      text: field.text('What you want changed'),
    },
  },
  'ship.stop': { plain: 'Interrupt the running worker and pause the project', fields: shipOnly },
  'ship.pause': { plain: 'Pause the project', fields: shipOnly },
  'ship.resume': { plain: 'Resume a paused project', fields: shipOnly },
  'ship.scuttle': { plain: 'Abandon the project for good', fields: shipOnly },
  'ship.retry': { plain: 'Try a failed project again', fields: shipOnly },
  'ship.rewind': {
    plain: 'Go back to a checkpoint on a new branch',
    fields: { shipId, checkpoint: field.id('The checkpoint to go back to') },
  },
  'ship.refit': {
    plain: 'Start a new contract version on a finished project',
    fields: { shipId, text: field.text('What should change') },
  },
  'publish.request': {
    plain: 'Ask to publish a project',
    fields: { shipId, target: field.oneOf(PUBLISH_TARGETS, 'Where to publish') },
  },
  'ship.rate': {
    plain: 'Rate a project',
    fields: {
      shipId,
      score: field.int(1, 5, 'Score from 1 to 5'),
      note: optional(field.text('A note for the record')),
    },
  },
  'lesson.promote': { plain: 'Make a lesson law', fields: { id: field.id('The lesson id') } },
  'lesson.burn': { plain: 'Throw a lesson away', fields: { id: field.id('The lesson id') } },
  'dial.set': {
    plain: 'Change a setting for one project, or the factory default',
    fields: {
      shipId: optional(shipId),
      key: field.oneOf(Object.keys(DIALS), 'The setting'),
      value: field.any('The new value'),
    },
    check: (command) => (DIALS[command.key].includes(command.value)
      ? null : `${command.key} must be one of: ${DIALS[command.key].join(', ')}`),
  },
  'lamp.assign': {
    plain: 'Put a project on a lamp, or clear the lamp',
    fields: {
      slot: field.int(0, LAMP_SLOTS - 1, 'Lamp number, from 0 to 5'),
      shipId: { ...shipId, nullable: true, plain: 'The project id, or null to clear the lamp' },
    },
  },
  'ship.read': { plain: 'Mark a project as seen', fields: shipOnly },
  'preview.open': { plain: 'Open the prototype of a project that passed the gate, starting it if it has stopped', fields: shipOnly },
});

export const COMMAND_TYPES = Object.freeze(Object.keys(COMMANDS));

/**
 * Validate a command as sent to `POST /api/command`.
 * @param {any} input `{type, ...args}`
 * @returns {{ok: true, command: Record<string, any>} | {ok: false, error: string}}
 */
export function validateCommand(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'A command must be an object with a type' };
  }
  const { type, ...args } = input;
  if (typeof type !== 'string' || !Object.hasOwn(COMMANDS, type)) {
    return { ok: false, error: `Unknown command: ${String(type)}` };
  }
  const spec = COMMANDS[type];
  const problem = checkFields(args, spec.fields, { strict: true }) ?? spec.check?.(args) ?? null;
  if (problem) return { ok: false, error: `${type}: ${problem}` };
  return { ok: true, command: { type, ...args } };
}

/**
 * The JSON Schema of a command's arguments, for the MCP surface and the CLI help.
 * @param {string} type
 */
export function commandSchema(type) {
  const spec = COMMANDS[type];
  if (!spec) throw new Error(`Unknown command: ${type}`);
  const properties = {};
  const required = [];
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    const schema = { description: fieldSpec.plain };
    if (fieldSpec.type !== 'any') schema.type = fieldSpec.nullable ? [fieldSpec.type, 'null'] : fieldSpec.type;
    if (fieldSpec.oneOf) schema.enum = [...fieldSpec.oneOf];
    if (fieldSpec.min !== undefined) schema.minimum = fieldSpec.min;
    if (fieldSpec.max !== undefined) schema.maximum = fieldSpec.max;
    if (fieldSpec.maxLength !== undefined) schema.maxLength = fieldSpec.maxLength;
    properties[name] = schema;
    if (fieldSpec.required) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

