# Venezia: system specification

This is the contract every module is built against. If code and this file disagree, fix the code, or change this file on purpose in the same change.

Research behind each decision: `docs/research/01..05`. Protocol facts are in `03-claude-protocol.md` and were verified against Claude Code 2.1.318.

## 1. What it is

Venezia is a local-first agentic factory for one person. You bring an idea by voice or text. It is contracted, built, proven and launched, and the factory remembers what it learned.

The world is the historic Arsenale of Venice. A hull is towed down a street of water, and each window hands it one typed artifact. **A hull cannot pass a closed window.** That single rule is both the fiction and the dependability model.

You are the Doge. Agents do the work. You steer, approve and hold the ring.

### The five promises

These answer "it is hard to keep Claude steerable and dependable".

1. **No model decides "done".** Plain Node owns state. A hull only moves when the host has mechanical evidence: exit codes, HTTP responses, browser events, pixels, hashes.
2. **Steerable at every moment.** Nudge, queue, stop, rewind and refit work on a live run, from any surface, and none of them lose progress.
3. **Bounded.** Every run has a budget, a turn cap and a confinement. Blocked means zero spend. Silence never approves.
4. **It learns and writes itself down.** Every run leaves a chronicle and lessons. Lessons are used as hints on their own and measured against outcomes. Only you turn one into law.
5. **The game is the real state.** Nothing on screen is decoration about the system. Weather is your rate limit, gold is verified results, lamps are real attention.

### Fiction rules

- Decision cards and anything that affects a choice speak plain English. Fiction lives in the world, sound and naming, never in a sentence you must act on.
- Every fiction term has a plain twin (section 3). "Plain mode" turns the fiction words off everywhere.
- History in the UI must follow the accuracy traps in `docs/research/04-surfaces.md` section 8. "Traditionally 1104", "thousands", "moving fitting-out line".

## 2. Hard constraints

- Stay inside this folder at runtime. Yards, data and memory all live here. Yards must never be under `/tmp`.
- Node 25, ES modules, no build step, no TypeScript, no framework on the front end. Runtime deps only: `ws`, `playwright-core`, `qrcode-generator`. Anything else needs a reason in this file.
- SQLite through `node:sqlite`, with FTS5.
- 8 GB RAM. At most 3 active workers, and headless Chrome holds an exclusive browser slot.
- The Claude subscription window is the real limit, so work is serial by default. Model choice is not cut to save usage: opus for planning, building, repair and review, sonnet for basic tasks, haiku only for very basic explore and classify tasks.
- Everything runs on the existing `claude` login. No API keys needed. Pin to `2.1.318`; `vz doctor` warns on any other version and runs a protocol smoke test.
- Server binds `127.0.0.1` by default. LAN access is opt-in, HTTPS only, and needs pairing.
- Builders never hold publish credentials. Only the publish broker touches `gh`.

## 3. Vocabulary

Defined once in `shared/vocabulary.mjs`, with `{id, fiction, plain, blurb}` for each entry.

| Id | Fiction | Plain | Meaning |
|---|---|---|---|
| ship | Hull | Project | One idea moving through the factory |
| bocca | Bocca | Intake | Lion's-mouth slot. Idea goes in, gaps are named |
| disegno | Disegno | Contract | What "done" means, written before any code |
| cantiere | Cantiere | Build | Workers build, one work item at a time |
| collaudo | Collaudo | Prove | Host-run gate, repair loop, independent review |
| varo | Varo | Launch | Prototype running, publish decision |
| portolano | Portolano | Learn | Chronicle, lessons, memory |
| gondola | Gondola | Sketch | Well-defined tiny idea. Skips human contract review |
| galley | Galley | Build | Normal project |
| galleass | Galleass | Platform | Larger, several contract milestones |
| proto | Proto | Planner | Writes contract and locked tests. Never builds |
| marangone | Marangone | Builder | Implements one work item |
| calafato | Calafato | Repairer | Stops leaks: fixes a failing gate, fresh context |
| provveditore | Provveditore | Reviewer | Independent acceptance reviewer. Never the builder |
| scrivano | Scrivano | Scribe | Docs, retrospectives, lesson drafts |
| lamp | Lamp | Slot | One of six attention slots |
| mariegola | Mariegola | Rulebook | Lessons you confirmed as law |
| receipt | Bollo | Receipt | Host-signed proof that a commit passed the gate |
| tessera | Tessera | Verified result | Gold tile. Only ever earned by host evidence |
| sensa | Sensa | Publish ceremony | Hold the ring to put something on the public web |

## 4. Repository layout

```
bin/vz.mjs              headless CLI, every UI action
shared/                 isomorphic, imported by engine AND browser. No Node imports.
  vocabulary.mjs        terms, stations, states, lamp colours, bells
  commands.mjs          command catalog and validators
  reducer.mjs           pure (state, event) => state
  names.mjs             deterministic Venetian hull names
  sim.mjs               scripted fleet: yields timed events, no I/O
engine/
  index.mjs             createEngine(config): wires everything, used by server and tests
  config.mjs            paths, defaults, model map
  store.mjs             SQLite, append-only events, projections, ledger
  bus.mjs               in-process pub/sub on committed events
  worker.mjs            one claude process: stream-json, control protocol, reaping
  scheduler.mjs         worker slots, browser lock, session single-writer lock
  pipeline.mjs          deterministic ship state machine
  decisions.mjs         decision inbox, tiers, approval tokens
  mcp.mjs               `vz mcp`, a thin surface over a running server
  sim-engine.mjs        the scripted fleet behind the real server
  stations/             intake, contract, build, prove, review, launch, learn, plus yard, bells
  doctrine/             role system prompts and stack guidance (markdown)
  gate/                 evidence gate, host simulator and preview servers
  publish/              broker and adapters
  portolano/            memory: recall, record, promote, mirror to markdown
  scribe/               chronicle (mechanical) and docs (agent)
  voice/                STT helper (Swift), TTS for `/api/say`, intent grammar
  net/                  http, ws, auth, LAN, certificates, mDNS
web/                    PWA, no build step
test/                   node --test; fake-claude fixture
docs/                   this file, research, prototypes, guides
portolano/              human-readable memory (local and yours to edit; git tracks only the seed README and empty Mariegola)
yards/  data/           runtime, gitignored
```

## 5. Ship lifecycle

### 5.1 States

`shared/vocabulary.mjs` exports `STATES`, each with its `station`.

| State | Station | Who acts | Next |
|---|---|---|---|
| `intake` | bocca | Proto (read-only, structured) | `awaiting_answers` or `contracting` |
| `awaiting_answers` | bocca | You | `intake` |
| `contracting` | disegno | Proto | `awaiting_contract` or `building` |
| `awaiting_contract` | disegno | You | `building`, or `contracting` with notes |
| `building` | cantiere | Marangone per item | `proving` |
| `proving` | collaudo | Host gate, no model | `reviewing` or `repairing` |
| `repairing` | collaudo | Calafato | `proving`, or `blocked` after `maxRepairs` |
| `reviewing` | collaudo | Provveditore | `ready` or `repairing`, or `proving` if the tree moved after the gate, or `blocked` on a gap or after `maxRepairs` |
| `ready` | varo | Local preview is live, receipt issued | `publishing`, `learning` |
| `publishing` | varo | Broker, no model | `launched`, `ready` on failure |
| `launched` | varo | Live check passed | `learning` |
| `learning` | portolano | Scrivano | `done` |
| `done` | portolano | Terminal, keeps its prototype while the receipt holds, can be refit | `contracting` via refit |
| `paused` | same | You | previous state |
| `blocked` | same | You | previous state or `failed` |
| `failed` | same | Terminal, can retry or fork | `learning` then stays `failed` |
| `scuttled` | same | Terminal | |

`blocked` always carries `blockReason`: `human_needed`, `rate_limited`, `budget`, `gap`, `repair_exhausted`, `worker_crashed`, `permission_denied`.

Sizing asks one question first: is the intent well defined? Well defined and tiny is a gondola. Anything else asks up to three questions, each with options and a recommended default, and never guesses at a gap. A size you chose stands. Otherwise the planner's size goes on the log as `ship.sized`. Questions get two rounds: a planner that still has questions after your answers blocks with `gap`.

`failed` keeps the state it failed from in `resumeState`, and `ship.retry` returns there. A ship that failed out of `repairing` therefore gets one more repair and then the whole gate, never a bare rerun of the gate on unchanged code. `blocked` carries a card with `retry` and `stop`, except `rate_limited`, which clears by itself. After `maxRepairs`, each "try again" allows exactly one more repair.

### 5.2 Artifacts: what each window hands the hull

| Window | Artifact | Location | Checked by host |
|---|---|---|---|
| Bocca | `brief.json` | `yards/<id>/.venezia/` | Schema |
| Disegno | `venezia.contract.json`, locked tests, `workitems.json` | yard root, hash in DB, copy in `data/contracts/<id>/v<n>.json` | Schema, every acceptance criterion maps to a smoke step or test, no check names a fixed port, hash locked outside the yard |
| Cantiere | Commit per item | yard git | Checks of this item and of every finished item rerun by host. Locked tests for unbuilt items fail by design, so the full suite belongs to the gate |
| Collaudo | `evidence.json`, screenshots, logs. `evidence.json` lists the run's pictures in `screenshots` | `data/evidence/<id>/<run>/` | The gate itself |
| Collaudo | `review.json`. Each criterion's `id`, `status` and `note` also go on `review.finished` | same | Schema, must cite evidence |
| Varo | Receipt, preview URL, publish receipt | DB | Commit, contract hash, clean tree, payload hash |
| Portolano | `CHRONICLE.md`, `README.md`, lessons | yard and `portolano/` | Schema |

`.venezia/` is host-owned. Workers read it, and any write there voids the receipt. The host copies evidence into `.venezia/evidence` for repairers and reviewers, because a read outside the yard would raise a card each time.

A gondola can skip the contract card, so surfaces read what was promised from `GET /api/ships/:id/contract`, which serves the copy kept outside the yard. The criterion ticks come from that and from `review.finished`: `not_met` or `unproven` takes the gold off that criterion even when the gate passed.

The contract also carries `schema`, `title` and `acceptance`. `locked` is mandatory, and `externalHosts` and `installScripts` are optional and each widen what the gate allows. `checkContract` requires scripts locked through npm, so Python projects are out of contracts for v1.

The gate's verdict is `PASS`, `FAIL` or `ERROR`. `ERROR` means the host itself failed. It says nothing about the project, sets no tile and uses no repair.

### 5.3 Reset rules

- Briefs, never chat history. Every worker starts fresh from artifacts.
- Failures never get fixed in place during review: a repair is a new commit, and the whole gate runs again.
- A receipt names `{commit, contractHash, evidenceHash}`, plus a hash of `.venezia/`. Any later change to the tree voids it, except `CHRONICLE.md`, `README.md` and `RETROSPECTIVE.md`, which the scribe writes after the receipt. Voiding is an event and it dims the gold.
- `refit` adds a contract version and re-enters at `contracting` on the same yard. This is how you iterate on a shipped thing.
- Only the human changes a contract after it is accepted.

### 5.4 Restart

A driver holds nothing a restart could lose: entering a state again works out from the log what is left to do. On start the host:

1. withdraws tool and network cards, since the worker that asked is gone. Nothing is allowed by that.
2. stops any worker left over from a dead host, from its note in `data/runs/`, checking the start time so a reused PID is left alone.
3. closes runs and gates the log says were open. A closed gate is `ERROR`, never a failure.
4. blocks with `worker_crashed` any ship whose worker died with the host. Its work may be half done, so you choose to carry on or stop. Carrying on resumes the session if it has a checkpoint, and otherwise starts fresh.
5. picks every other ship up from its state, with a bell saying so. A cut-off gate runs whole again, and a cut-off publish finishes through the broker's journal and never applies twice. `paused` stays paused, and open cards stay open.

A worker killed before its first message has no session worth resuming, so it starts fresh.

## 6. Workers

`engine/worker.mjs` drives one long-lived `claude` process. The verified invocation:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-hook-events --replay-user-messages --include-partial-messages
  --model <m> --effort <e>
  --setting-sources "" --strict-mcp-config --disable-slash-commands --no-chrome
  --tools <role tools>
  --permission-mode acceptEdits --permission-prompt-tool stdio
  --settings <host-owned worker.json>
  --append-system-prompt-file <host-owned doctrine, generated per run>
  --max-turns <n> --max-budget-usd <x> --session-id <uuid>
```

`--tools` is mandatory. Never pass bare `Read`, `Write` or `Bash` allow rules, since they remove the working-directory boundary. `worker.json` contains `autoMemoryEnabled:false`, the sandbox block with `failIfUnavailable`, `allowUnsandboxedCommands:false`, `denyRead` for `~/.ssh ~/.claude ~/.config/gh ~/.aws` and `data/publish` (the approval key and journal), `allowWrite` for the npm cache, the network allowlist, and deny rules for `gh`, `git push`, `vercel`, `wrangler`, `curl`, `wget` and the publishing verbs of npm, pnpm and yarn. `denyRead` also closes everything private in `data/` and every other yard. Deny rules cannot carry exceptions, so every `curl` and `wget` is denied, not only those off the allowlist. npm cache is `data/npm-cache`, passed by env. The spawn env is an allowlist, so `CLAUDE*` variables and any new secret stay behind. `GH_CONFIG_DIR` points at an empty dir, `npm_config_userconfig` at an empty file, and `GIT_CONFIG_GLOBAL` at `/dev/null`, because the sandbox refuses `~/.gitconfig` and git treats a refused read as fatal.

Node's `fetch` ignores the sandbox proxy, so a worker's `fetch` to the network fails, with no `network` card. The sandbox also refuses `listen` on every port, loopback included, on purpose: a worker cannot run a server, and the host runs `start` and every check in a jail of its own with one open port given as `$PORT`.

Role table (defaults in `config.mjs`, all overridable):

| Role | Model | Effort | Tools | Turns |
|---|---|---|---|---|
| proto (intake) | sonnet | medium | Read,Glob,Grep | 8 |
| proto (contract) | opus | high | Read,Write,Edit,Bash,Glob,Grep | 40 |
| marangone | opus | medium | Read,Write,Edit,Bash,Glob,Grep | 80 |
| calafato | opus | medium | Read,Write,Edit,Bash,Glob,Grep | 50 |
| provveditore | opus | medium | Read,Glob,Grep,Bash | 25 |
| scrivano | sonnet | low | Read,Write,Glob,Grep | 20 |

Never use plan mode. It silently swaps the model. Read-only roles use `--tools`.

Public shape:

```js
const w = spawnWorker({ shipId, role, cwd, prompt, schema?, model, effort, tools, doctrinePath,
  maxTurns, maxBudgetUsd, sessionId?, resumeSessionAt?, forkFrom?, onPermission, onStopGate? })
w.steer(text, {priority})   // undefined | 'later' | 'now'; returns uuid, lifecycle becomes events
w.interrupt({cancelQueued})
w.setModel(alias)
w.contextUsage()
await w.done                // { outcome, costUsd, usage, sessionId, structured, denials, checkpoints }
await w.kill()              // interrupt, SIGTERM, grace, snapshot descendants by ps, kill by PID, SIGKILL
```

Rules from the spike:

- Classify with `is_error`, `terminal_reason`, `permission_denials`, and presence of `structured_output`. Never by `subtype`. `outcome` is one of `completed, budget, max_turns, interrupted, denied, schema_missing, api_error, crashed`.
- Tolerate unknown message types. `system/init` fires per turn.
- Keep own ledger. `--max-budget-usd` is per run and `total_cost_usd` is cumulative per process and list price. Treat it as a relative meter.
- `rate_limit_event` feeds the Treasury. When 5h or 7d utilization is above `0.9`, new workers wait and the state shows as `blocked: rate_limited`.
- Record every assistant `uuid` as a checkpoint for `--resume-session-at` with `--fork-session`.
- Steer through user messages only, never through deny messages.
- If `updatedInput` rewrites anything, tell the model in a user message. That note is a `steer.sent` with verb `host`.
- Single writer per session: `scheduler.mjs` holds a lock.
- Stop gate: host callback through `initialize` hooks with a retry cap of 2 held by the host. It filters the misleading `stop-hook-error` notification.
- Long `sleep` in Bash is refused by the tool. Doctrine must say so.
- A heredoc or `node -e` with braces and quotes, `rm -r` or `rm -rf`, and `$?` in a command raise a `tool` card, because Claude Code's safety check fires inside a sandbox too. Doctrine forbids them, and scratch work goes in a git-ignored `.scratch/` in the yard.
- A standing deny rule that refused a call does not stop a worker that still reached its report. Nobody decided anything, so the station's own checks and the report's gap say what happens (`workedRound`). A refusal from a person or the permission route always blocks with `permission_denied`.

Permission routing: `can_use_tool` goes to `decisions.mjs`. Policy table, in order: sandbox-network to allowlisted hosts auto-allow; `SandboxNetworkAccess` to other hosts raises a `network` decision; writes outside the yard deny and raise a `gap`; anything else raises a `tool` decision, held with no timeout. "Always" is offered through `updatedPermissions` with `destination:"session"` only.

These cards come from Claude Code's own prompts and are the same at every autonomy level. A dial never widens what a confined worker may do, so Wind can still stop on a tool card, and Tiller does not prompt for edits inside the yard, which `acceptEdits` allows.

## 7. Decisions

There is one inbox, ordered by urgency. Home shows one card at a time.

```js
Decision {
  id, shipId, kind,         // questions | contract | tool | network | publish | budget | gap | lesson
  tier,                     // 0..4, section 9
  title, plain,             // plain English only
  detail,                   // diff, command, manifest, questions
  options,                  // [{id, label, recommended?, danger?}]
  payloadHash?,             // approval binds to this
  voiceAllowed,             // false for tier >= 3
  holdMs,                   // 0, or 2000 for tier 3, 3000 for tier 4
  createdAt, resolvedAt?, resolution?   // {optionId, note, answers, actor, via?}
}
```

Silence never approves. No timeouts auto-resolve anything. A worker held on a decision uses no tokens.

`resolution.via` names the surface: `web`, `cli`, `mcp` or `voice`. The host closes a card nobody can act on any more with `optionId:'withdrawn'`, and that allows nothing.

## 8. Steering

Every surface issues the same commands.

| Verb | Mechanism | Feel |
|---|---|---|
| **Nudge** | default priority message, folds in at next tool boundary | "Also make it dark" |
| **Next** | `priority:"later"` | "When you finish, add a footer" |
| **Now** | `priority:"now"` | "Change course" |
| **Stop** | `interrupt`, ship goes `paused` | Big red |
| **Rewind** | fork a new hull from a checkpoint: a new yard reset to that point on branch `rewind/<id>`, and the session forked. The source is paused and keeps what it had | Scrub the log, press Rewind |
| **Refit** | new contract version | "Now add sharing" |
| **Boost** | `setModel`, or the dial changes effort for the next worker | Dial |

Every steering message is an event, and is material for lessons. Any steer that overrides a default counts as a preference signal.

Voice in the web surfaces is transcribe-only: the socket opens as `/ws/voice?mode=transcribe`, the server's grammar reads the words, and nothing runs. Steers land on a chip offering Nudge, Next and Now, and other commands on a chip with one button. A mishearing costs one tap, and a confident reading waits for the same tap as an unsure one. Without the mode the socket keeps the older behaviour, where a confident command runs at once and the frame reports it in `result`. Questions are answered either way, and a briefing marks the project as seen.

## 9. Publish

`engine/publish/` holds a broker and adapters with `probe / plan / dryRun / apply / verify / rollback`. Details in research 05 sections 7 and 8, which are binding.

| Tier | Meaning | Default |
|---|---|---|
| 0 | This machine: preview, tarball | Automatic after gate pass |
| 1 | Remote and private: private repo | Automatic after gate and secret scan, then notify |
| 2 | Unlisted or expiring: secret gist | Approve once per target |
| 3 | Public and durable: GitHub Pages via `venezia-sites` | One approval per plan, hold 2 s, tap or key required, voice can request but not approve |
| 4 | Irreversible | Always explicit, hold 3 s, never standing |

Default public path: source in a private repo, built output only in one public `<user>/venezia-sites` repo on `gh-pages`. Adapters in v1: `local`, `tarball`, `github-private`, `github-pages`, `gist-secret`. `vercel` and `cloudflare` exist as probes that report what setup is needed.

`apply` refuses without a pass for that exact artifact hash. Approval is an HMAC over `plan.hash` with expiry. Post-publish `verify` runs the browser checks live. A failed verify rolls back automatically. Preview servers run on a separate port per ship (a separate origin) and the UI frames them with a sandboxed iframe.

Prototypes. A ship in `ready`, `launched` or `done` with a valid receipt has a prototype you can open, and `preview.open` starts it or finds it running. Reaching `done` stops nothing.

- It serves what the gate kept for the receipted commit, never the working tree. The receipt names the evidence by hash, and the evidence names the commit and the hash of the kept output, and all of it is checked on every open. A static site runs on the host simulator. Anything else runs the locked contract's start command in the jail, on a copy of the kept tree.
- `preview.open` checks the receipt first, so a tree that moved voids it there and nothing comes up. A voided receipt stops a running prototype at once, in any state. A failed or scuttled ship, a ship in refit and a ship that has not passed the gate are refused.
- Previews do not survive the host. A start writes `preview.down` for anything the log still calls up, and starts nothing by itself, on a `ready` ship as on any other: reaching `ready` brings a receipt's first preview up, once. Opening brings it back, at the same address while the engine runs.
- `maxPreviews` in the config caps how many run at once, 3 by default. Starts run one at a time, and a start past the cap first stops the least recently opened, with `preview.down`. Opening one that is running counts as use. A stopped one comes back on demand.
- The folio's Preview tab sends `preview.open` when it is opened, and shows Open prototype with the real address. After that it waits for you, so a preview the cap stopped stays stopped until you ask.

Who can say yes. A surface asks the server for a token and sends it with `decision.resolve`. The host decides from what it saw itself:

| Surface | Tier 0 to 2 | Tier 3 and 4 |
|---|---|---|
| Web, deck, keyboard, gamepad | Yes | `POST /api/decisions/:id/hold` at the press and `POST /api/decisions/:id/approval` with that `holdId` at the end. The host times the hold on its own clock, with 250 ms of slack for the network. A hold counts once |
| CLI | Yes | `vz approve --confirm` |
| Voice | Yes | No. It can request |
| MCP | Yes | No. It can request, and it can see the card |

A command read from speech and then tapped on the chip is a web command, so it is recorded as `via: web`. That does not widen voice: the grammar never offers a yes on a card with `voiceAllowed:false`, and a tier 3 or 4 yes still needs the hold.

The `dry-run` step of preflight is the adapter's own rehearsal. It runs inside `preflight`, and every step's result goes on the card as `detail.preflight`, so `decision.opened` is its log entry. No event of its own is written.

Surfaces identify themselves with `X-Venezia-Surface`. Only a plain local caller can claim `cli` or `mcp`: a request with an `Origin`, or anything from the LAN, is `web`, which is the strictest case. A token cannot cross this line, because `decision.resolve` refuses a yes from voice or MCP whatever it carries. Below tier 3 there is no hold to prove, so the host signs for you. Saying no never needs a token. A token dies with the process, and the card stays open.

## 10. Memory: Portolano

Table `lessons`, mirrored to `portolano/lessons/*.md` and an append-only `portolano/mariegola.md`.

```js
Lesson { id, kind,        // hazard | shoal | technique | preference
  text, why, howToApply, tags[], status,   // candidate | law | burned
  sourceShipId, evidence, uses, wins, losses, createdAt, confirmedAt }
```

Loop: signals (gate failures, repairs, steers, denials, ratings, publish outcomes) feed the Scrivano's structured retrospective, which yields candidate lessons. Candidates are recalled automatically as hints on later runs, labelled as unconfirmed. Outcome tracking counts a win if the ship passes the gate on first try with the hint injected. After 3 scored uses with a win rate above 0.66 the card "make this law?" appears. A candidate below 0.34 after 3 scored uses burns itself. A use is scored once its ship reaches a gate result. Law is only made by you. Laws are appended to the Mariegola with the date, never edited in place.

Recall: FTS5 over text and tags with the idea and the role, then a token budget (800 tokens per worker). Doctrine for a run is generated into `data/doctrine/<run>.md`: role doctrine, stack guidance, laws, hints, and a statement that these are prior notes rather than user instructions.

Yard-authored text is untrusted. Lesson drafts come from the Scrivano through a schema, are capped at 280 characters, and a lesson only ever affects guidance, never tools or permissions.

Chronicle: `CHRONICLE.md` in each yard is generated mechanically from events, so it cannot be wrong about what happened. The Scrivano writes the `README.md` and narrative retrospective on top. `portolano/ATLAS.md` is regenerated as an index of all ships. `GET /llms.txt`, and `GET /api/ships/:id.md` export it all for agents. Every doc has three depths where it matters: Simple, Technical, Commentary.

## 11. Event log and protocol

Everything is an append-only event. State is a pure reduction of events, in `shared/reducer.mjs`, which runs in the engine and the browser, so the UI can scrub through history and the sim can use the real renderer.

```js
Event { seq, ts, type, shipId|null, actor, data }
```

Event types (the reducer must handle all, and ignore unknown ones):

```
ship.created ship.state ship.named ship.sized ship.dial ship.refit ship.forked
ship.read ship.rated lamp.assigned
ship.artifact            {kind, path, hash}
work.planned             {items}
work.started work.finished {itemId, status}
worker.started worker.stopped {runId, role, model, outcome, costUsd}   stopped adds ranModels: what Claude reports running, since `model` is only the alias asked for
worker.activity          {runId, kind, tool?, summary}   compact feed
worker.text              {runId, text}                   sampled, not every delta
worker.context           {runId, used, max}
steer.sent steer.state   {uuid, verb, text, state}    verb is a steering verb, or `host`
decision.opened decision.resolved                    resolved carries {id, optionId, note?, answers?, via?}
gate.started gate.step gate.finished  {step, ok, ms, detail}
receipt.issued receipt.voided
review.finished          {verdict, findings, summary?, criteria?}
preview.up preview.down  {url}
publish.planned publish.applied publish.verified publish.rolledback
lesson.drafted lesson.used lesson.promoted lesson.burned lesson.scored
doc.written              {path}
treasury.updated         {fiveHour, sevenDay, resetsAt, spentUsd}
tessera.set              {kind, shipId}    only emitted from gate, receipt, publish, lesson-law code paths
renown.changed           {delta, total, reason}
bell.rung                {bell, reason}
```

Reduced state:

```js
{ seq, ships: {[id]: Ship}, lamps: [shipId|null ×6], decisions: {[id]: Decision},
  treasury, renown: {total, rank}, tesserae: [...], lessons: {...}, feed: [last 200] }
```

Lamp colour derives from ship state: white idle, blue working, green finished unread, amber needs you, red failed.

### HTTP and WS

- `GET /api/state` returns snapshot plus `seq`. `GET /api/health` and `GET /api/commands` describe the server. `alarm` on the health answer is `{message, since}` or null: what is wrong with the host. No event can say so while the log refuses writes, so the web asks every 30 seconds and shows it on the top ribbon.
- `GET /ws?since=<seq>` streams `{t:'event',e}`, falling back to `GET /sse?since=` then `GET /api/events?since=`. Surfaces use a shared client in `web/js/transport.js`. A client more than 5000 events behind, or ahead of the log, gets `{t:'reset'}` and refetches the snapshot.
- `GET /api/history?since=&limit=` returns one page of the log, `{seq, events, more}`, at most 1000 events. It never resets, so a client can page back to the first event to scrub history.
- `POST /api/command` takes `{type, ...args}` from `shared/commands.mjs`, returns `{ok, id?, url?, error?}`. `url` is the address `preview.open` opened. All surfaces use only this, plus the two approval steps in section 9.
- `GET /api/ships/:id`, `/api/ships/:id/events`, `/api/ships/:id/contract`, `/api/ships/:id.md`, `/api/lessons`, `/llms.txt`. `/contract` returns `{version, hash, title, acceptance, outOfScope}`, or 404 before there is a contract.
- `GET /shared/*` serves `shared/` to the browser. `GET /sim/preview/:id/` serves a sim preview.
- LAN only, HTTPS on port 8443: `/pair`, `/pair/ca.crt`, `/pair/venezia.mobileconfig`, `POST /api/pair/claim`. This machine only: `POST /api/pair/start`, `GET /api/devices`, `POST /api/devices/revoke`.
- `GET /evidence/<ship>/<run>/<file>`: read-only, path-checked.
- `GET /api/say?text=` returns AAC by way of `say` and `afconvert`.
- `/ws/voice` takes 16 kHz Int16 PCM frames and returns partials, then a final `{t:'intent'}` frame. `?mode=transcribe` runs nothing and leaves `result` off that frame (section 8).

### Commands

```
ship.create {idea, size?, autonomy?}   ship.answer {decisionId, answers}
decision.resolve {id, optionId, note?, token?}
steer {shipId, verb, text}             ship.stop {shipId}
ship.pause / ship.resume / ship.scuttle / ship.retry {shipId}
ship.rewind {shipId, checkpoint}       ship.refit {shipId, text}
publish.request {shipId, target}       ship.rate {shipId, score, note?}
lesson.promote / lesson.burn {id}      dial.set {shipId?, key, value}
lamp.assign {slot, shipId}             ship.read {shipId}
preview.open {shipId}
```

`autonomy` is 0 Tiller (approve each contract, sketches included), 1 Sail (default: contracts for galleys and larger, publishing), 2 Wind (only publishing needs you, so questions take their recommended answers, on the log with the actor `host`). Tool cards are the same at every level, as section 6 says. Public publishing always asks unless a standing policy exists for that target.

## 12. Surfaces

All surfaces are clients of section 11.

- **Web PWA** at `/`. Mobile first, works from 360 px to ultrawide.
- **Deck** at `/deck`: the phone or tablet alone as a physical panel, next to any screen showing the world.
- **Keyboard**: `1-6` lamps, `Y` approve, `N` reject, `Space` hold to talk, `S` steer, `[ ]` dial, arrow keys for the eight-wind stick.
- **Gamepad**: mapping from research 04 section 6.3.
- **CLI** `vz`: `serve, new, status, watch, steer, stop, approve, reject, publish, open, lessons, doctor, pair`, each with `--json`, plus `vz do <command>` for anything in the catalog. `approve` needs `--confirm` at tier 3 and above.
- **MCP server** `vz mcp`: stdio, plain JSON-RPC, exposing the same commands, so any Claude session can run the factory. It will not answer a decision that needs a hold, yes or no.
- **Voice**: hold to talk, double tap to latch. Hull names are addressable ("tell Aurora to use a darker theme"). Grammar first, haiku classifier only as a fallback. Spoken briefing on request and on finish. Voice leaves tier 3 and above alone entirely, including saying no, and it cannot scuttle. The classifier can never answer a decision.

## 13. Reward system, all real

| Game thing | Real thing |
|---|---|
| Hull position on the water street | Pipeline state |
| Hull fills out with masts, rigging, oars | Work items done |
| Windows opening | Artifacts handed over |
| Fog over a hull | Open questions |
| Leak and pitch-smoke | Gate failed, Calafato working |
| Weather | Rate limit: clear below 50%, wind to 75%, storm above 90% of the window |
| Treasury (ducats) | Budget remaining in windows, spent ledger |
| Gold tessera | One verified result. Set on gate pass, receipt, live verify, law confirmed |
| Dark tessera | A failed gate is recorded too, honestly, as a dull glass tile |
| Mosaic | Your lifetime wall of tiles, per hull |
| Renown | Only from tesserae: first-pass gate, launch, law. Not from activity |
| Rank | Apprendista, Marangone, Proto, Provveditore, Ammiraglio, Doge. Thresholds in vocabulary |
| Five bells | Five notification classes (research 04 7.3), each with its own sound and interrupt rule |
| Sensa | Publish ceremony. Hold the ring, it drops, rings spread across the lagoon |
| Fair of the Sensa | Gallery of everything launched |
| Galileo benchmark | Tafur's ten galleys in six hours, as a throughput readout |

## 14. Testing

- `node --test`. All engine tests run on `test/fixtures/fake-claude.mjs`, selected by `VENEZIA_CLAUDE_BIN`. It speaks the stream-json protocol from research 03 and is scriptable per test.
- Real-claude smoke tests are behind `VENEZIA_E2E=1`.
- `shared/` must be tested in both Node and the browser.
- UI checks with `playwright-core` through system Chrome (`channel:'chrome'`) at 390x844 and 1440x900, against the sim.

## 15. Non-goals for v1

Multi-user, cloud workers, importing existing repos, native apps, parallel builders within a ship, physical macro-pad driver (documented only).
