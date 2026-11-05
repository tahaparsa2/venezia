// `./vz mcp`: a stdio MCP server, plain newline-delimited JSON-RPC, so any Claude session can run
// the factory (SPEC 12). It is a thin surface over a running server: it sends the same commands
// as every other surface, and nothing else.
//
// One line it will not cross: a model may ask to publish in public, but not approve it. Like
// voice, this surface cannot answer a decision that needs a hold (SPEC 9).

import readline from 'node:readline';

import { COMMAND_TYPES, COMMANDS, commandSchema } from '../shared/commands.mjs';

const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const DESTRUCTIVE = new Set(['ship.scuttle', 'lesson.burn', 'ship.rewind']);

const SHIP_ARGUMENT = {
  type: 'object',
  properties: { shipId: { type: 'string', description: 'The project id' } },
  required: ['shipId'],
  additionalProperties: false,
};

/** Tools that only read. Everything else is a command from the catalog. */
const READ_TOOLS = Object.freeze({
  factory_status: {
    description: 'See every project, what is waiting for you, and how much of the rate limit is left',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => {
      const state = await client.state();
      return {
        seq: state.seq,
        treasury: state.treasury,
        waiting: state.inbox.map((id) => {
          const { kind, tier, title, plain, options, shipId } = state.decisions[id];
          return { id, kind, tier, title, plain, shipId, options };
        }),
        ships: Object.values(state.ships).map(({ id, name, idea, state: shipState, blockReason, hull, lamp }) => ({
          id, name, idea, state: shipState, blockReason, hull, lamp,
        })),
      };
    },
  },
  ship_detail: {
    description: 'Read everything known about one project',
    inputSchema: SHIP_ARGUMENT,
    run: (client, { shipId }) => client.ship(shipId),
  },
  lessons_list: {
    description: 'Read lessons, optionally searching them or filtering by status',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Words to search for' },
        status: { type: 'string', enum: ['candidate', 'law', 'burned'], description: 'Only lessons with this status' },
      },
      additionalProperties: false,
    },
    run: (client, args) => client.lessons(args),
  },
  events_since: {
    description: 'Read events after a sequence number',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: 'Last sequence number you have seen' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Most events to return' },
      },
      required: ['since'],
      additionalProperties: false,
    },
    run: (client, { since, limit }) => client.events({ since, limit, wait: 0 }),
  },
});

const toolName = (type) => type.replaceAll('.', '_');
const COMMAND_BY_TOOL = Object.freeze(Object.fromEntries(COMMAND_TYPES.map((type) => [toolName(type), type])));

function toolList() {
  const reads = Object.entries(READ_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true },
  }));
  const commands = COMMAND_TYPES.map((type) => ({
    name: toolName(type),
    description: COMMANDS[type].plain,
    inputSchema: commandSchema(type),
    annotations: { readOnlyHint: false, destructiveHint: DESTRUCTIVE.has(type) },
  }));
  return [...reads, ...commands];
}

const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The JSON-RPC methods.
 * @param {{client: ReturnType<typeof import('./net/client.mjs').createClient>, version?: string}} options
 */
export function createMcpHandler({ client, version = '0.1.0' }) {
  async function callCommand(type, args) {
    if (type === 'decision.resolve') {
      const state = await client.state();
      const decision = state.decisions[args?.id];
      if (decision && decision.voiceAllowed === false) {
        return toolResult(`"${decision.title}" needs a person to hold the control, so it cannot be approved from here. Ask them to approve it on the deck or with ./vz approve.`, true);
      }
    }
    const result = await client.command({ type, ...args });
    return toolResult(result, result.ok === false);
  }

  async function callTool({ name, arguments: args = {} } = {}) {
    if (typeof args !== 'object' || args === null) throw new RpcError(INVALID_PARAMS, 'Tool arguments must be an object');
    const read = Object.hasOwn(READ_TOOLS, name) ? READ_TOOLS[name] : null;
    const command = Object.hasOwn(COMMAND_BY_TOOL, name) ? COMMAND_BY_TOOL[name] : null;
    if (!read && !command) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    try {
      return read ? toolResult(await read.run(client, args)) : await callCommand(command, args);
    } catch (error) {
      return toolResult(error.message, true);
    }
  }

  const METHODS = {
    initialize: ({ protocolVersion } = {}) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'venezia', version },
      instructions: 'Venezia is a factory: call factory_status first. Use plain English with the person. Public publishing needs their own approval.',
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: toolList() }),
    'tools/call': callTool,
  };

  /**
   * Answer one parsed message.
   * @param {any} message
   * @returns {Promise<object|null>} the response, or null for a notification
   */
  async function handle(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 request' } };
    }
    const { id, method, params } = message;
    const notification = id === undefined;
    if (typeof method !== 'string') {
      return notification ? null : { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'A method is required' } };
    }
    if (notification) return null;
    if (!Object.hasOwn(METHODS, method)) {
      return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${method}` } };
    }
    try {
      return { jsonrpc: '2.0', id, result: await METHODS[method](params) };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: error.code ?? INTERNAL_ERROR, message: error.message } };
    }
  }

  return { handle };
}

/**
 * Serve on a pair of streams until the input closes. Answers in order, and only JSON-RPC
 * ever reaches the output.
 * @param {{client: any, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, version?: string}} options
 */
export async function runMcpServer({ client, input = process.stdin, output = process.stdout, version }) {
  const { handle } = createMcpHandler({ client, version });
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'That line is not valid JSON' } });
      continue;
    }
    const replies = (await Promise.all((Array.isArray(message) ? message : [message]).map(handle))).filter(Boolean);
    if (Array.isArray(message)) {
      if (replies.length > 0) send(replies);
    } else if (replies[0]) {
      send(replies[0]);
    }
  }
}
