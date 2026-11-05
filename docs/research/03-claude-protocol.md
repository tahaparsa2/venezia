# 03. Claude Code CLI as a programmable worker

Spike date 2026-11-04, Claude Code 2.1.318, macOS arm64, 8 GB RAM, subscription login (`apiKeySource: "none"`).
All experiments used `--model haiku` (resolved to `claude-haiku-5-5`) unless noted.

The spike ran in a temporary folder, called `$SP` below. Its scripts are kept in `docs/prototypes/spike/`: `driver.mjs` is the stream-json harness, `approve-mcp.mjs` the MCP gate, `hook.mjs` the hook guard and `rss.mjs` the memory bench. The raw captures (`out/`) and driver scenarios (`scen/`) were temporary and are not in this repository.

## How to read this

- **Verified**: I ran it and saw the result in this spike.
- **Failed**: I ran it and it does not work, or does not do what we would need.
- **Not tested**: no run. The reason is given.
- **Secondhand**: read in the docs or the SDK type file, not run here. These are marked inline and collected in section 13.

## Scorecard

| # | Item | Status |
|---|------|--------|
| 1 | stream-json message shapes | Verified (about 20 type/subtype pairs seen; others from SDK types are Secondhand) |
| 2 | `--include-partial-messages` | Verified |
| 3 | Mid-run steering, interrupt, control channel | Verified |
| 4a | `--permission-prompt-tool` with MCP | Verified, including `updatedInput` and a 660 s hold |
| 4b | `--permission-prompt-tool stdio` (control channel) | Verified, 620 s hold |
| 4c | `--permission-prompts host/none`, `dontAsk` | Verified |
| 5 | `--json-schema` | Verified, with one trap |
| 6 | `--resume`, `--session-id`, `--fork-session` | Verified, plus hidden `--resume-session-at` |
| 7 | `--max-budget-usd` on subscription | Verified: honoured, per run, notional list price |
| 8 | Hooks via `--settings`, `--include-hook-events` | Verified, plus host-side hook callbacks with no subprocess |
| 9 | Confinement and leak control | Verified. A bare cwd is not a jail. `--bare` Failed (no API key) |
| 10 | RSS and startup latency | Verified |

The single best result: **the whole Agent SDK control protocol is reachable from plain Node over stdin/stdout, with no SDK dependency.** Live steering, interrupt, approvals, hook callbacks, model and mode changes and context inspection all work on one long-lived process.

---

## 1. Stream-json output: Verified

Flags: `claude -p --output-format stream-json --verbose`. `--verbose` is required for stream-json. Output is newline-delimited JSON on stdout.

Observed order for a one-tool turn: `system/init`, `assistant` (tool_use), `rate_limit_event`, `user` (tool_result), `assistant` (text), `result`.

### system/init (verbatim, lists trimmed)

```json
{"type":"system","subtype":"init","cwd":"$SP/yard","session_id":"809dd801-...",
 "tools":["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","ListAgents","Monitor","NotebookEdit","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","TaskStop","ToolSearch","WebSearch","Write"],
 "mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","slash_commands":[],"apiKeySource":"none",
 "claude_code_version":"2.1.318","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup","web-fetch"],
 "skills":[],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"}],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","interrupt_send_now_v1","interrupt_requeue_taken_v1","msg_lifecycle_v1","request_marker_lists_v1","ask_user_question_unanswered_v1","lifecycle_wakeup_source_v1","sdk_mcp_tools_list_changed","sdk_mcp_manifests","mcp_read_resource_v1","mcp_tool_ui_meta_v1","ui_surface_v1","mcp_call_result_not_for_model_v1"],
 "analytics_disabled":false,"product_feedback_disabled":false,"uuid":"60cf6157-...",
 "memory_paths":{"auto":"~/.claude/projects/<slug>/memory/"},"original_cwd":"$SP/yard","additional_directories":[],
 "messaging_socket_path":"/tmp/cc-socks/65360.sock","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "per_turn_effort_active":true,"ultrathink_available":false,"ultrathink_typed_raises":false,"view_mode":"default"}
```

In streaming-input mode `system/init` is emitted once **per turn**, not once per process. Do not treat it as a process-start signal.

### assistant (verbatim)

```json
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_...","type":"message","role":"assistant",
 "content":[{"type":"tool_use","id":"toolu_...","name":"Bash","input":{"command":"echo hi","description":"Print hi"},"caller":{"type":"direct"}}],
 "container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,
 "usage":{"input_tokens":2,"cache_creation_input_tokens":4751,"cache_read_input_tokens":8451,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4751},"output_tokens":16,"service_tier":"standard","inference_geo":"global","speed":"standard"},
 "input_transformations":[],"diagnostics":null,"context_management":null},
 "parent_tool_use_id":null,"session_id":"809dd801-...","uuid":"0e956f91-...","timestamp":"2026-11-05T00:09:44.745Z","request_id":"req_...",
 "wire_tool_inputs":{"toolu_...":{"command":"echo hi","description":"Print hi"}}}
```

`stop_reason` is `null` on these messages. Read it from `result`. Each content block arrives as its own `assistant` message, so one API response can produce several (a `thinking` block then a `text` block).

### user/tool_result (verbatim)

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_...","type":"tool_result","content":"hi","is_error":false}]},
 "parent_tool_use_id":null,"session_id":"809dd801-...","uuid":"b47a0300-...","timestamp":"2026-11-05T00:09:44.910Z",
 "tool_use_result":{"stdout":"hi","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},
 "tool_result_meta":[{"id":"toolu_...","permission_decision":{"decision":"accept","source":"config","reason_type":"rule"}}]}
```

`tool_result_meta[].permission_decision` is a free audit trail. Sources seen: `config`, `hook`, `user_temporary`, `user_reject`. `reason_type` values seen: `rule`, `mode`, `hook`, `subcommandResults`, `other`. A rejected call also carries `non_execution_kind` (`permission-rule`, `user-rejected`).

### result (verbatim, success)

```json
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":3264,"duration_api_ms":2822,"ttft_ms":1964,
 "num_turns":2,"result":"The command printed `hi`. Done.","stop_reason":"end_turn","terminal_reason":"completed",
 "session_id":"809dd801-...","total_cost_usd":0.00123213,
 "usage":{"input_tokens":4,"cache_creation_input_tokens":4856,"cache_read_input_tokens":21653,"output_tokens":88,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":4856,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"...":"..."}],"speed":"standard","fallback_credit":null},
 "modelUsage":{"claude-haiku-5-5":{"inputTokens":4,"outputTokens":88,"cacheReadInputTokens":21653,"cacheCreationInputTokens":4856,"webSearchRequests":0,"costUSD":0.00123213,"contextWindow":1000000,"maxOutputTokens":128000,"thinkingTokens":0,"cacheCreationEphemeral5mInputTokens":0,"cacheCreationEphemeral1hInputTokens":4856,"canonicalModel":"claude-haiku-5-5","provider":"firstParty","costBasis":"list"}},
 "permission_denials":[],"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},
 "safety_stops":0,"uuid":"0983647b-..."}
```

Other `result` fields seen: `errors` (failure only), `structured_output`, `result_index`, `queued_turn_count`, `model_usage_since_last_result`, `user_message_uuid(s)`, `credential_expires_at`, `first_content_frame_ms`, `ttft_stream_ms`, `time_to_request_ms`, `request_sent_wall_ms`, `first_request_input_tokens`.

**How to classify a run. Never rely on `subtype` alone.**

| Scenario | subtype | is_error | terminal_reason | exit | result |
|---|---|---|---|---|---|
| Normal | `success` | false | `completed` | 0 | text |
| Not logged in | `success` | **true** | `api_error` | not recorded | `"Not logged in · Please run /login"` |
| Interrupt | `error_during_execution` | true | `aborted_tools` or `aborted_streaming` | process lives on | null |
| `priority:"now"` preempts | `success` | false | `aborted_tools` | process lives on | `""` |
| Budget hit | `error_max_budget_usd` | true | `budget_exhausted` | 1 | null |
| Budget hit on the final turn | `error_max_budget_usd` | true | `budget_exhausted`, `stop_reason:"end_turn"` | 1 | null, though the work finished |
| Max turns | `error_max_turns` | true | `max_turns` | 1 | null |
| Schema impossible | `success` | false | `completed` | 0 | prose, **no `structured_output`** |
| Permission denied | `success` | false | `completed` | 0 | model's explanation, plus `permission_denials[]` |

`success` means the agent loop ended cleanly. It does not mean the task was done. `permission_denials` is the only structured signal that a run was blocked.

Full `TerminalReason` union (Secondhand, sdk.d.ts): `blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error, malformed_tool_use_exhausted, aborted_streaming, aborted_tools, stop_hook_prevented, hook_stopped, tool_deferred, max_turns, background_requested, completed, budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed`.

### Other types seen

Field lists are from a census over all captures in `$SP/out`.

| type / subtype | Fields beyond type, session_id, uuid |
|---|---|
| `rate_limit_event` | `rate_limit_info` |
| `system/status` | `status` (`"requesting"`, null), `permissionMode` |
| `system/thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta`, `user_message_uuid` |
| `system/task_started` | `task_id, run_id, tool_use_id, description, task_type (local_bash, local_agent), is_backgrounded, subagent_type, spawn_depth, prompt` |
| `system/task_updated` | `task_id, run_id, patch` |
| `system/task_notification` | `task_id, run_id, tool_use_id, status, summary, output_file, usage{total_tokens,tool_uses,duration_ms}` |
| `system/permission_denied` | `tool_name, tool_use_id, message, decision_reason, decision_reason_type` |
| `system/notification` | `key, text, priority` |
| `system/hook_started` | `hook_id, hook_name, hook_event` |
| `system/hook_response` | `hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome` |
| `command_lifecycle` | `command_uuid, state` (`queued, started, completed, cancelled`) |
| `control_request` | `request_id, request` |
| `control_response` | `response{subtype,request_id,response or error}` |
| `stream_event` | `event, parent_tool_use_id, api_message_id, ttft_ms, thinking_display` |

**Rate limits are live telemetry, and useful for a HUD** (values replaced with placeholders):

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":<epoch>,"rateLimitType":"five_hour","overageStatus":"<status>","overageDisabledReason":"<reason>","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":<0 to 1>,"resetsAt":<epoch>,"status":"allowed"},"seven_day":{"utilization":<0 to 1>,"resetsAt":<epoch>,"status":"allowed"}}},"uuid":"...","session_id":"..."}
```

For Venezia this budget is the binding constraint, more than RAM.

Subagents: the stream shows `tool_use` named **`Agent`**, while `init.tools` lists **`Task`**. `--allowedTools Task` authorised it. Messages inside the subagent carry `parent_tool_use_id` set to the Agent call. Text is hidden unless `--forward-subagent-text` is passed (Secondhand: headless docs).

The `Bash` tool itself refuses long sleeps. `sleep 31 ; echo slept` returned `<tool_use_error>Blocked: sleep 31 followed by: echo slept. To wait for a condition, use Monitor...`. `sleep 8` was allowed. Any Venezia test or wait script that does long sleeps through a worker must use another mechanism.

Secondhand types not seen here (sdk.d.ts): `api_retry, compact_boundary, session_state_changed, tool_progress, tool_use_summary, memory_recall, informational, session_writes_lost, worker_shutting_down, model_refusal_fallback, prompt_suggestion, files_persisted, conversation_reset`. The host parser must ignore unknown types without failing. `session_state_changed` (`idle/running/requires_action`) would be the ideal HUD signal, but it never appeared in these runs.

---

## 2. --include-partial-messages: Verified

Requires `--print` and stream-json. Adds `stream_event` wrappers around raw Messages API streaming events (`$SP/out/03a.jsonl`):

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha"}},
 "session_id":"debbb339-...","parent_tool_use_id":null,"uuid":"4a574403-...","api_message_id":"msg_..."}
```

Order seen: `message_start`, `content_block_start`, `content_block_delta`..., then `assistant` (full), then `content_block_stop`, `message_delta`, `message_stop`, then `result`. The complete `assistant` message arrives **before** `content_block_stop`. Render from deltas for feel and reconcile on the `assistant` message. `--replay-user-messages` echoes each accepted prompt as `{"type":"user","isReplay":true,...}`, which arrives when the turn actually starts.

---

## 3. Streaming input and mid-run steering: Verified

Flags: `--input-format stream-json --output-format stream-json --verbose`. No `initialize` is required. The process stays alive until stdin closes.

**stdin format (one JSON per line):**

```json
{"type":"user","message":{"role":"user","content":"Reply with exactly: alpha"},"parent_tool_use_id":null}
{"type":"user","uuid":"2e9d8b69-...","priority":"later","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
```

Supply a `uuid` so you get `command_lifecycle` frames. `content` can also be a blocks array (Secondhand: images, documents).

**Between turns:** a second message on the same process works and keeps context (asked for the prior word, got `alpha beta`). `total_cost_usd` is cumulative across turns on one process (0.00104, then 0.00150). Spawn to `system/init` was 216 to 615 ms.

**During a turn:** all three runs sent a message 1.5 s into an 8 s Bash call.

| `priority` | Behaviour observed | Results |
|---|---|---|
| omitted (default) | **Folded into the running turn** at the next tool boundary. Model replied `FIRSTDONE\n\nPINEAPPLE`. | 1 |
| `"later"` | Queued. First turn finished unaware. Ran as its own turn. | 2 |
| `"now"` | Tool ran to completion, was **not** killed. Turn aborted at the boundary (`terminal_reason:"aborted_tools"`, `result:""`, `subtype:"success"`), then a new turn ran. | 2 |

This is the core steering primitive. Default priority gives "hey, also do X" without losing progress. Lifecycle frames tell the UI where the steer stands:

```json
{"type":"command_lifecycle","command_uuid":"2e9d8b69-...","state":"queued"}
{"type":"command_lifecycle","command_uuid":"2e9d8b69-...","state":"started"}
{"type":"command_lifecycle","command_uuid":"2e9d8b69-...","state":"completed"}
```

**Interrupt control message:**

```json
{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt","cancel_queued":true}}
```

Receipts:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":["0210b5df-..."]}}}
{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[],"cancelled":["73b8815a-..."]}}}
```

Results of a real test against a running `python3 ... time.sleep(31.5)`:

- The tool process tree was dead within about 20 ms of the request (two matching processes before, zero after).
- `result` was `error_during_execution`, `is_error:true`, `terminal_reason:"aborted_tools"`.
- The process stayed alive. A following user message ran normally on the same session.
- A plain interrupt leaves `later` messages queued, and they run. `cancel_queued:true` kills them too.
- With no tool running, `terminal_reason` is `aborted_streaming`.

Drop one queued message without interrupting:

```json
{"type":"control_request","request_id":"cam-1","request":{"subtype":"cancel_async_message","message_uuid":"b07375fe-..."}}
```

which returned `{"cancelled":true}` and a `cancelled` lifecycle frame.

**Other control requests that worked:**

| subtype | Payload | Response |
|---|---|---|
| `initialize` | `{}` or `{hooks:...}` | `commands, agents, models, account{email,organization,subscriptionType,apiProvider}, pid, session_state, capabilities, ...`. Works before any user message, **zero API cost**. Spawn to response 190 to 320 ms. |
| `get_context_usage` | none | `categories[], totalTokens, maxTokens, memoryFiles[], autoCompactThreshold...`. Worked before any user message, so usable as a zero-cost pre-flight. |
| `get_session_cost` | none | `{text:"Total cost: $0.0006\n..."}` |
| `set_permission_mode` | `{mode:"plan"}` | `{mode:"plan"}` and a `system/status` frame |
| `set_model` | `{model:"haiku"}` | `{model:"claude-haiku-5-5"}` |
| `mcp_status` | none | `{mcpServers:[{name,status}]}` |
| unknown | | `{"subtype":"error","request_id":"bad-1","error":"Unsupported control request subtype: does_not_exist"}` |

Secondhand, not run: `stop_task, rewind_files, seed_read_state, mcp_call, mcp_set_servers, update_settings, apply_flag_settings, get_usage, read_file`. `mcp_call` runs MCP tools with no model turn and no permission check. `control_cancel_request` was never observed from the CLI, even after interrupting with a prompt pending.

**Exit behaviour:**

- Closing stdin during a turn: the turn finishes (`FIRSTDONE`), then exit 0.
- Closing stdin with a prompt pending: the tool errors `Tool permission request failed: AbortError: Tool permission stream closed before response received`, the model retries, gets `Stream closed`, then the run ends `success`. Host crash is safe (no silent allow).
- SIGTERM mid-tool: tool recorded as `Exit code 137`, process exit 143, **no result message**.
- SIGKILL: no output, and **the tool survives as an orphan** (see below).

**Orphan trap: Verified.** After SIGKILL the Bash wrapper re-parented to PID 1 and kept running with its python child. Spawning the worker `detached` and killing its process group did **not** help, because each tool gets its own process group:

```
worker pid 1043
 1134  1043  1134 /bin/zsh -c source ...   <- pid ppid pgid: own group
 1135  1134  1134 python3
AFTER group kill
 1134     1  1134 /bin/zsh -c source ...   <- orphan
```

Stop workers with: `interrupt`, then SIGTERM, then a grace period, then snapshot the descendant tree with `ps` and kill it by PID, then SIGKILL.

**Crash recovery: Verified.** After SIGKILL mid-tool, `--resume` restored context (`ORCHID`), and the model said it did not know whether the command finished. Docs (Secondhand) add `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`.

---

## 4. Permissions

### 4a. MCP gate: Verified

Server: `$SP/approve-mcp.mjs`, plain Node, no dependencies, newline-delimited JSON-RPC on stdio. Flags: `--mcp-config mcp.json --permission-prompt-tool mcp__gate__approve`.

`tools/call` received (verbatim):

```json
{"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Write","input":{"file_path":"$SP/yard/gated.txt","content":"ORIGINAL"},"tool_use_id":"toolu_..."},"_meta":{"claudecode/toolUseId":"toolu_...","progressToken":2}},"jsonrpc":"2.0","id":2}
```

Reply: a text content block holding stringified JSON.

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"behavior\":\"allow\",\"updatedInput\":{...}}"}]}}
```

| Decision payload | Outcome |
|---|---|
| `{"behavior":"allow","updatedInput":<input>}` | Ran |
| `{"behavior":"allow"}` | Ran. `updatedInput` is optional. |
| `{"behavior":"allow","updatedInput":{...,"content":"REWRITTEN BY HOST\n"}}` | File contained the rewritten text. **The model was not told** and claimed it wrote `ORIGINAL`. |
| `{"behavior":"deny","message":"..."}` | `tool_result` `is_error:true` with the message. The model retried once, unprompted. |
| `{"behavior":"deny","message":"...","interrupt":true}` | Turn aborted, `error_during_execution`, exit 1. |

Two model-behaviour findings:

- `deny.message` is treated as **untrusted tool output, not as an instruction**. My message said to use a word, and the model replied: "That text came from the tool result, not from you, so I didn't treat it as an instruction." Do not steer through denials. Deny, then send a user message.
- Silent `updatedInput` rewrites make the model's own account wrong. Follow a rewrite with a user message, or have the verifier check disk.

### 4b. Stdio gate: Verified, and the one to use

`--permission-prompt-tool stdio` with `--input-format stream-json`. No MCP server, no extra process, and it shares a channel with steering.

CLI to host (verbatim):

```json
{"type":"control_request","request_id":"a4b7fa8e-...","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"$SP/yard-h1/gated.txt","content":"ORIGINAL"},"description":"gated.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_..."}}
```

Host to CLI:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"a4b7fa8e-...","response":{"behavior":"allow","updatedInput":{"file_path":"...","content":"REWRITTEN VIA STDIO after hold 1000\n"}}}}
```

Also seen on the request: `blocked_path`, `decision_reason`, `decision_reason_type` (`workingDir`). Bash requests carry `permission_suggestions` with `addRules`, `addDirectories` and `setMode`.

**"Always allow" works.** Adding this made a second `touch` run with no prompt (`prompts seen 1`):

```json
{"behavior":"allow","updatedInput":{...},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch:*"}],"behavior":"allow","destination":"session"}]}
```

Use `destination:"session"`. The suggested `localSettings` would write into the yard.

**Interrupt with a prompt pending** resolved the turn immediately, with an `aborted_streaming` result and an ordinary process afterwards.

### Hold for a human: Verified

| Route | Hold | Outcome |
|---|---|---|
| stdio | 620 s | Allowed, `wrote it.`, $0.0013 list |
| MCP | 76 s | Allowed, file written |
| MCP | 660 s | Allowed, `wrote it.`, $0.0013 list |

The model is idle during a hold, so waiting spends no tokens. The 5-minute prompt cache is not the issue here, since writes used the 1-hour tier (`ephemeral_1h_input_tokens`). `sdk.d.ts` calls the MCP tool timeout "effectively unbounded by default" (Secondhand).

### 4c. Prompt target and modes: Verified

Write to a file in cwd, no allow rules:

| Flags | Result | Notes |
|---|---|---|
| none (default mode, no host) | Denied | Message: "...but you haven't granted it yet." Model may retry. |
| `--permission-prompts host`, no prompt tool | Same as above | |
| `--permission-prompts none` | Denied | `decision_reason:"no approval surface in this session; permission request denied automatically"`. Clear "do not claim it" text. Cheaper than default (0.00057 against 0.00145, one sample each). |
| `dontAsk --allowedTools Read` | Write denied | Message says "You *may* attempt to accomplish this action using other tools". That invites workarounds, so `--permission-prompts none` is a better denial. |
| `dontAsk --allowedTools Write` | Write allowed | |
| `dontAsk --allowedTools 'Bash(echo *)'`, `touch z.txt` | Denied | |
| `dontAsk --allowedTools 'Bash(echo *)'`, `ls -1 .` | **Allowed** | Read-only commands bypass the allowlist. |
| `acceptEdits --permission-prompts none`, Write in cwd | Allowed | |
| `acceptEdits --permission-prompts none`, `ls` | Allowed | Read-only set |

All of these runs end with exit 0 and `subtype:"success"`, denied or not. Only `permission_denials[]` tells you a call was blocked.

**Plan mode swaps the model. Verified twice.** `--model haiku --permission-mode plan`, and `set_permission_mode plan` mid-session, both ran on `claude-sonnet-5-5`. One turn cost $0.0635 list, 40 times the haiku turn before it, with `cache_read_input_tokens:0`. Do not use plan mode as a cheap read-only mode. Use `--tools Read,Glob,Grep`.

---

## 5. --json-schema: Verified

```json
{"subtype":"success","is_error":false,"num_turns":3,"result":"{\"color\":\"teal\",\"n\":2}","structured_output":{"color":"teal","n":2},"terminal_reason":"completed"}
```

The object is in **`result.structured_output`**, and `result` holds its stringified form.

Mechanism, visible in stream-json: a `StructuredOutput` tool is added to `init.tools`. Here the model first answered in prose, and the CLI injected a user message `[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.` So expect an extra round trip (3 turns for a trivial ask).

Validation is real: an impossible schema (`minimum:5, maximum:1`) got `/n: must be >= 5` back as a tool rejection.

**Trap:** with no valid output the run still ended `subtype:"success"`, `is_error:false`, exit 0, and **no `structured_output` key**, with apologetic prose in `result`. `error_max_structured_output_retries` exists in the types but did not fire in this case. Always check for the key. Docs agree (Secondhand).

---

## 6. Session continuity: Verified

| Action | Result |
|---|---|
| `--session-id <uuid>` new | Uses that id |
| `--session-id` reused | `Error: Session ID ... is already in use.` |
| `--resume <id>` | Same `session_id`, context kept. `total_cost_usd` is the conversation total, not this run. |
| `--resume <id> --fork-session` | New `session_id`. Branches diverged: fork said PEAR, original still FIG. |
| `--resume <id> --fork-session --session-id <v>` | Fork under a chosen id. Transcript file `<v>.jsonl` was created. |
| `--resume <id>` from another cwd | Worked, found by id. Docs agree (Secondhand). |
| `--continue` | Most recent session in that cwd |
| `--resume <id> --fork-session --resume-session-at <assistant uuid>` | **Hidden flag, worked.** Forked from after turn 1 of 5: the model saw exactly 1 earlier prompt. |

`--resume-session-at` gives **true checkpoints**: record the `uuid` of each `assistant` message from the stream, then branch from any of them. `--rewind-files` is also a hidden flag (and `rewind_files` a control request), not tested. Hidden flags can change without notice, so pin the CLI version.

Transcripts are JSONL in `~/.claude/projects/<cwd-slug>/<session>.jsonl` (`user`, `assistant`, `attachment`, `queue-operation`, `last-prompt`, `cost-state`, `api-request`, `api-request-blob`, `session-owner`, `mode`...). About 126 KB after only one or two tiny turns, as they store API request blobs. Each message has `uuid`/`parentUuid`.

**No session lock. Verified.** While a live stream process held a session open, a second `claude -p --resume <same id>` ran and returned 0 on the same `session_id`, and the holder then ran another turn. Nothing errors. Venezia must enforce a single writer per session itself.

---

## 7. --max-budget-usd on subscription: Verified, honoured

| Budget | Outcome |
|---|---|
| none | Complete, `$0.00155` |
| 0.0002 | Stopped after turn 1, `$0.00049`, exit 1 |
| 0.001 | Finished all the work, then `error_max_budget_usd`, `$0.00105`, `result:null` |

- `errors:["Reached maximum budget ($0.0002)"]`.
- Checked **after** each API response, so it overshoots by one call.
- A run that crosses the line on its final turn is reported as failed even though the work is done. The text is still in the last `assistant` message.
- **Per run, not per conversation.** A resume with `--max-budget-usd 0.002` on a session already totalling $0.0021 ran normally and reported `$0.00224`. Venezia must keep its own ledger.
- `--max-turns` works but is **absent from `--help`**. `--max-turns 2` gave `error_max_turns`, `num_turns:3`, exit 1.

**Cost figure:** `total_cost_usd` is a client-side estimate at **list price** (`modelUsage.*.costBasis:"list"`). No money moves on subscription. It works as a relative meter, and the real limiter is `rate_limit_event`. Docs call it a client-side estimate (Secondhand).

---

## 8. Hooks: Verified

`--settings <file-or-json>` delivers hooks even with `--setting-sources ""`. Same-shaped hooks load from a host-owned file, so a yard cannot alter them.

```json
{"hooks":{
 "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node $SP/hook.mjs"}]}],
 "PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node $SP/hook.mjs"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"node $SP/hook.mjs"}]}]}}
```

Stdin to the hook (verbatim, trimmed):

```json
{"session_id":"...","transcript_path":"...","cwd":"...","prompt_id":"ae7136cb-...","permission_mode":"dontAsk","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo forbidden","description":"..."},"tool_use_id":"toolu_..."}
{"...":"...","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{...},"tool_response":{"stdout":"rewritten-by-hook","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},"tool_use_id":"...","duration_ms":136}
{"...":"...","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"...","background_tasks":[],"session_crons":[]}
```

| Output | Effect | Status |
|---|---|---|
| stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` | Blocked, even though `--allowedTools Bash`. Model sees `PreToolUse:Bash hook error: <reason>` | Verified |
| exit 2 with stderr | Blocked. Model sees the hook's command path too, so prefer JSON. | Verified |
| `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...}}}` | Command replaced. `PostToolUse.tool_input` shows the rewritten form. | Verified |
| `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}` | Reached the model. | Verified |
| Stop: `{"decision":"block","reason":"..."}` | **Forced continuation.** Reason delivered as a synthetic user message `Stop hook feedback:\n...`. Model continued, `result:"MANGO"`. | Verified |
| Deny under `--dangerously-skip-permissions` | | Not tested. The session's permission classifier blocked that launch. I dropped it rather than work around it. The task did not ask for it. |

**A `PreToolUse` callback can force a prompt. Verified on 2.1.318 with a sandboxed worker under `acceptEdits`, on real haiku:**

| Hook answer | Call | What happened |
|---|---|---|
| `permissionDecision:"ask"` | Write, Read and Bash in the yard, `rm -rf`, a heredoc | `can_use_tool` with `decision_reason_type:"hook"`, the hook's reason as `decision_reason`, and no `permission_suggestions` |
| `ask` | `gh --version` | No prompt. The deny rule wins: `Permission to use Bash with command gh --version has been denied.` |
| `{}` | Write, Read and Bash in the yard, `rm -rf`, a heredoc | Ran with no prompt |
| `{}` | Write to `.git/hooks/post-commit` in the yard | `can_use_tool` with `decision_reason_type:"safetyCheck"`, and if allowed, it is written. So `.git` is the host's to guard |
| `{}` | Read or Write outside the yard | `can_use_tool` with `decision_reason_type:"workingDir"` |
| either | `echo x > ../outside.txt` in Bash, allowed | Refused by the OS sandbox: `operation not permitted`. With `{}` no prompt is raised, so the host must read the command to raise a gap |

The hook sees `tool_name`, `tool_input` and `tool_use_id`, and that id matches the later `can_use_tool` and `tool_result`.

**Stop has no built-in loop cap.** An always-blocking hook ran until `--max-turns 8` ended it, with `safety_stops:0`. The hook must honour `stop_hook_active:true` or count its own attempts. A blocked stop also emits a misleading `system/notification` `stop-hook-error`. Filter that from the UI.

`--include-hook-events` adds `hook_started`/`hook_response` for all events. Without it only `SessionStart` shows up. Note `hook_response.output` and `.stderr` then reach the stream, which is good for audit.

**Host-side hook callbacks: Verified, better than command hooks.** Register in `initialize`, answer on stdin, with no process spawn per tool call:

```json
{"type":"control_request","request_id":"init","request":{"subtype":"initialize","hooks":{"PreToolUse":[{"matcher":"Bash","hookCallbackIds":["guard1"]}],"Stop":[{"hookCallbackIds":["stop1"]}]}}}
{"type":"control_request","request_id":"3bab5f3d-...","request":{"subtype":"hook_callback","callback_id":"stop1","input":{...same as hook stdin...}}}
{"type":"control_response","response":{"subtype":"success","request_id":"3bab5f3d-...","response":{"decision":"block","reason":"Host stop gate: reply MANGO"}}}
```

The guard denied, the Stop gate forced continuation, the second callback answered `{}` and the run ended. A command hook adds a process per call. Callbacks do not. The trade-off is failure mode: if the host dies, a guard callback is gone, whereas a settings hook still runs. Use callbacks for gates and keep a small settings hook as the backstop for the most dangerous rule.

---

## 9. Confinement and leak control

### A cwd is not a jail: Verified

`--permission-mode dontAsk --allowedTools Read,Write,Edit,Bash` in `conf/yard`:

| Attempt | Result |
|---|---|
| Read tool `../outside/secret.txt` | **Succeeded**, printed the secret |
| Write tool `../outside/w1.txt` | **Succeeded**, and the model got the path wrong on its own, landing two levels higher than asked |
| Bash `cat ../outside/secret.txt` | **Succeeded** |
| Bash `echo X > ../outside/b1.txt` | **Succeeded** |

**A bare `Read`, `Write` or `Bash` allow rule removes the working-directory boundary.** Never pass them.

### What does confine

| Control | Covers | Result |
|---|---|---|
| `acceptEdits`, no allow rules | File tools, plus Bash path checks | Write in cwd allowed. Write, Read, `cat`, `echo >` outside all routed to the prompt target (denied under `none`). `decision_reason_type:"workingDir"` under stdio. |
| `--add-dir <dir>` | Adds a working directory | Read and Write there allowed under `acceptEdits` |
| `permissions.deny` | Tools, and Bash commands it can parse | Read, Write blocked. Bash `head` and glob `s*.txt` blocked by `Read()` deny (`subcommandResults`). `Bash(curl *)` caught in a pipe. |
| deny rules vs interpreter | | **Bypassed**: `python3 -c 'print(open(...).read())'` printed the secret. Deny rules are not a security boundary against Bash. |
| OS sandbox | Bash and children only | Below |
| `--restricted` | Removes Bash and friends unless named, confines file tools | Read outside denied: `--restricted: path outside the working directory` |
| `--tools` | The model's tool list | Exactly the list given: `["Bash","Edit","Glob","Grep","Read","Write"]`. Cut first-request context from 13.2k to 10.6k tokens. |

The default tool set includes `CronCreate, RemoteTrigger, PushNotification, SendMessage, ScheduleWakeup, DesignSync, EnterWorktree`. Workers should not have those, so `--tools` is required.

### OS sandbox: Verified, with one trap in my own test

```json
{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,
 "filesystem":{"denyRead":["~/.ssh","~/.claude","~/.config/gh","~/.aws"]},
 "network":{"allowedDomains":["registry.npmjs.org"]}}}
```

| Attempt (sandboxed Bash) | Result |
|---|---|
| Write in cwd | OK, with no prompt |
| Write sibling dir | `operation not permitted` |
| Write `~/probe.txt` | `operation not permitted` |
| python read of a `denyRead` dir | `PermissionError: [Errno 1] Operation not permitted`, so this **does** stop the interpreter bypass |
| `ls ~/.claude`, `ls ~/.config/gh` with denyRead | `Operation not permitted` |
| `ls ~/.claude` **without** denyRead | Succeeded (26 entries). Read scope is broad by default. |
| curl allowed domain | `200` |
| curl unlisted domain | `403 user denied`, `<sandbox_violations>deny network-outbound example.com:443</sandbox_violations>` |
| Bash with `dangerouslyDisableSandbox:true` | Model set it, command still got `operation not permitted` |

**Trap.** My first run seemed to show the sandbox failing: a write outside cwd succeeded. The cause was location. The sandbox's writable temp dir includes `/tmp/claude-<uid>`, where all spike yards lived. Re-run with both dirs under the Venezia folder, it blocked correctly. **Yards must never live under `/tmp`**, or they can write to each other.

An unlisted network host raises a **permission prompt**: `can_use_tool` with `tool_name:"SandboxNetworkAccess"`, `input:{"host":"example.com"}`. So "may this worker reach this host?" becomes a host decision like any other.

The sandbox does not cover Read, Write, Edit, MCP servers or hooks (Secondhand, sandboxing docs, consistent with `9e-tool-write`, which was stopped by `acceptEdits`, not the sandbox). So use **both** layers. A sandboxed run left an empty-looking `.claude/.cc-writes` in the yard.

### Self-escalation: Verified

Under `acceptEdits`, a worker **could not** write `.claude/settings.json` or `.git/hooks/pre-commit` (both routed to the prompt target). It **could** write `CLAUDE.md`. So a yard's `CLAUDE.md` is worker-writable, and must be treated as untrusted if loaded later.

### Leak matrix: Verified with zero API cost

Measured through `initialize` and `get_context_usage` in a dir seeded with a parent `CLAUDE.md`, yard `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `.claude/settings.json`, a skill and an agent.

| Flags | CLAUDE.md files | MCP | Yard agent | Commands | System prompt tokens |
|---|---|---|---|---|---|
| none | parent, yard, local | **attempted**, plus 7 claude.ai connectors | yes | 74 | 3302 |
| `--strict-mcp-config` | parent, yard, local | blocked | yes | 74 | 3302 |
| `--setting-sources ""` | none | yard blocked, **7 claude.ai connectors still attached** | no | 53 (built-ins remain) | 3302 |
| `--setting-sources ""` + `--strict-mcp-config` + `--disable-slash-commands` | none | blocked | no | 0 | 3253 |
| `--setting-sources project` + strict + disable | parent, yard | blocked | yes | 0 | 3253 |
| same + `claudeMdExcludes:[parent]` | yard only | blocked | yes | 0 | 3253 |
| `--safe-mode` alone | none | none | no | 55 | 2496 with strict + disable |
| `--restricted` alone | none | yard blocked, **connectors still attached** | no | 53 | 2545 |
| `--restricted` + strict | none | none | not measured | not measured | not measured |

- **`--strict-mcp-config` is mandatory.** Without it, an account's claude.ai connectors (such as Drive and Gmail) attach to the worker even under `--setting-sources ""` and `--restricted`. Two were `pending` and five `needs-auth`. A worker must never see the user's Drive or Gmail.
- `--setting-sources ""` drops CLAUDE.md, yard skills and agents. Note a zsh trap: an unquoted array drops the empty string, so the next flag is parsed as its value (`Invalid setting source: --strict-mcp-config`). In Node's `spawn` argv it is fine.
- **Auto memory survives `--setting-sources ""`.** The 750-token gap (3253 to 2496) is its instructions. Turn it off with `--settings '{"autoMemoryEnabled":false}'` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Both dropped the system prompt to 2496 tokens, and the end-to-end run with the setting had no `memory_paths` in `init`.
- `--disable-slash-commands` removes all skills and commands, leaving the 6 built-in agents.
- Under `--setting-sources project` a yard's `.claude/settings.json` applies, which a resumed worker may have shaped. Prefer `""` and inject doctrine with `--append-system-prompt-file`. Verified: the appended instruction was obeyed (`[YARD-OK]`).
- Built-in plugins still load (`cc-plugin-telemetry`, `cc-plugin-privacy`, and others). `analytics_disabled:false`.

### Auth: Failed

- `--bare` gives `Not logged in · Please run /login`. It cannot be used here, as stated in the brief.
- `CLAUDE_CONFIG_DIR=<scratch>` also gives `Not logged in`. The macOS Keychain entry is keyed to the config dir (Secondhand, confirmed by this failure). So per-yard config dirs do not work without a separate login or token. All workers share `~/.claude/projects` and `~/.claude.json`.
- Docs say **`--bare` "will become the default for `-p` in a future release"** (Secondhand), and bare mode does not read OAuth. That could break every Venezia worker on upgrade. **Pin the CLI version** and add a smoke test. `claude setup-token` produces `CLAUDE_CODE_OAUTH_TOKEN`, a possible future route that the docs say bare mode also ignores. Not tested: it needs a browser approval from the user.

### Recommended worker invocation: Verified end to end

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-hook-events --replay-user-messages [--include-partial-messages]
  --model <m> --effort <e>
  --setting-sources "" --strict-mcp-config --disable-slash-commands --no-chrome
  --tools Read,Write,Edit,Bash,Glob,Grep
  --permission-mode acceptEdits --permission-prompt-tool stdio
  --settings <host-owned worker.json>
  --append-system-prompt-file <host-owned doctrine.md>
  --max-turns <n> --max-budget-usd <x> --session-id <uuid>
```

Result of a five-step task (`$SP/out/golden.jsonl`, 7.3 s, $0.0034 list). `--include-partial-messages` was tested separately, not in this run.

| Step | Decided by | Outcome |
|---|---|---|
| Write in yard | `acceptEdits` | Ran, no prompt |
| `cat hello.txt` | Sandbox auto-allow | Ran, no prompt |
| curl unlisted host | `can_use_tool: SandboxNetworkAccess` | Host denied, 403 |
| Write outside yard | `can_use_tool`, `decision_reason_type:"workingDir"` | Host denied, no file |
| `gh auth status` | `deny` rule | Blocked, no prompt |

Strip inherited parent variables (`CLAUDE*`) in the spawn environment. A daemon started from a Claude Code session would pass them on. `$SP/env.sh` does this. Pass `< /dev/null` for text-prompt runs, or the CLI waits 3 s (`Warning: no stdin data received in 3s`).

---

## 10. Resources: Verified

Machine: 8 GiB, 8 cores, 34 to 37% free. RSS sampled with `ps` every 200 ms over the worker's process tree. Latency is spawn to `initialize` response.

| Workers | State | Settled RSS | Peak tree RSS | Per worker peak | Startup |
|---|---|---|---|---|---|
| 1 | idle, isolated | 149 to 201 MB | 210 to 213 MB | 213 MB | 247 to 319 ms |
| 1 | idle, default flags | 209 MB | 247 MB | 247 MB | 255 ms |
| 1 | tiny turn | 176 MB | 228 MB | 228 MB | 188 ms; first token 1.8 s; done 2.9 s |
| 4 | idle | 740 MB | 756 MB | 189 MB | 468 ms |
| 4 | tiny turn | 873 MB | 886 MB | 222 MB | 274 ms; done 2.8 to 3.1 s |
| 8 | idle | 1359 MB | 1517 MB | 190 MB | 491 to 575 ms |

System memory free was 37% after the 8-worker run. Real long-running sessions on this machine read 229 MB (2 h 31 m) and 264 MB (37 m), so growth over hours was modest in this one observation.

Caveats:

- RSS double-counts shared pages of the 320 MB binary, so summed totals are upper bounds. `footprint` gave me no usable number, so true unique memory is unmeasured.
- This excludes what workers run: `npm install`, test runners, dev servers, Chrome. Those dominate.
- Long heavy sessions were not measured.

Baseline context per first request: 10.6k tokens with the recommended flags, 13.2k with default tools, with cache writes on the first turn. Cost of a cold tiny turn is about $0.001 list on haiku. Spawn-per-step is cheap in latency (under 0.5 s) but each new process re-pays cache creation. Note 4 parallel identical workers each paid only $0.00029, which suggests the prompt cache is shared across processes with identical prefixes.

**Cap: 3 active workers, a 4th only with no browser or dev server running. Headless Chrome QA holds an exclusive slot.** Idle workers are cheap enough to keep several parked. In practice the Pro rate windows bind first, so default to one to two.

---

## 11. Decisions for Venezia

1. **Drive workers over raw stdin/stdout from Node.** No Agent SDK dependency, no MCP gate. One long-lived process per worker, using the control protocol.
2. **Use `--permission-prompt-tool stdio` for approvals.** Holds of 10+ minutes cost nothing, so a phone approval is viable. Offer session-scope "always" through `updatedPermissions`.
3. **Steering maps to three verbs:** default priority "nudge", `later` "next", interrupt "stop". Track each via `command_lifecycle`. Do not steer through deny messages.
4. **Layer confinement:** `acceptEdits` with no bare allow rules, the OS sandbox with `denyRead` on credentials, a `--tools` allowlist, and `--strict-mcp-config` so the user's connectors stay out. Yards live outside `/tmp`.
5. **Gates are host callbacks.** A Stop gate that forces continuation until tests pass is real, with a retry cap in Venezia's hands, not the CLI's.
6. **Run outcome comes from the host, never from `subtype`.** Combine `is_error`, `terminal_reason`, `permission_denials`, `structured_output` presence, and verification on disk.
7. **Venezia owns:** a cost ledger, the single-writer session lock, and reaping process trees.
8. **Checkpoints:** store each assistant `uuid` and use `--resume-session-at` with `--fork-session`.
9. **Pin the CLI to 2.1.318**, and run a protocol smoke test before any upgrade. Hidden flags and the `--bare` default risk are both real.
10. **The HUD reads `rate_limit_event`** for the real budget. Treat `total_cost_usd` as a relative meter.

---

## 12. Side effects and things that went wrong

- Spawned workers wrote transcripts under `~/.claude/projects`: 16 spike-related project dirs, plus entries in `~/.claude.json`. That is the CLI's normal behaviour, not a settings change, but it is outside the two allowed folders. `claude purge <path>` can remove them per project. I left them, as deleting them was not asked for.
- `~/.claude/settings.json` was not changed. Nothing was installed globally. No remote resource was created.
- `npm pack @anthropic-ai/claude-agent-sdk@0.3.318` downloaded a tarball into the scratchpad to read `sdk.d.ts`. It was never executed or installed.
- A temporary `.spike-tmp` under the Venezia folder held sandbox tests, and was removed.
- A permission classifier denied a batch containing `--dangerously-skip-permissions`. I removed that test. A safety check also blocked a glob `rm` in a scratch dir, and I dropped that cleanup, so `yard-m` keeps stale test files.

## 13. Not tested, and secondhand sources

**Not tested:** hooks under `bypassPermissions` (see section 8), `--rewind-files`, `--worktree`, `--brief`, `--permission-mode auto`, compaction and `compact_boundary` on long sessions, `api_retry` under real rate limiting, what happens when the 5-hour limit actually hits, `CLAUDE_CODE_OAUTH_TOKEN`, images in stdin, memory on long heavy sessions, `updatedInput` from hooks on tools other than Bash, whether context fully survives an interrupt (one echo turn only).

**Secondhand:**

- `@anthropic-ai/claude-agent-sdk@0.3.318`, `sdk.d.ts`, for control subtypes, `TerminalReason`, `PermissionUpdate`, `SDKRateLimitInfo`, MCP timeout wording: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Headless docs, for `--bare` becoming default, SIGTERM behaviour, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, structured output, `--forward-subagent-text`: https://code.claude.com/docs/en/headless
- Sandboxing docs, for scope and defaults: https://code.claude.com/docs/en/sandboxing
- Authentication docs, for Keychain keying, `setup-token`, precedence: https://code.claude.com/docs/en/authentication
- CLI `--help` output for 2.1.318 is saved at `$SP/help.txt`.
