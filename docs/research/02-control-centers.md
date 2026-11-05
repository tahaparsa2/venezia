# 02. Agent control centers: what exists, what breaks, what is open

Track: centers. Date: 2026-11-04. Purpose: inform Venezia, a local-first personal agentic coding factory that drives the Claude Code CLI.

## How to read this report

Every claim carries one evidence tag.

| Tag | Meaning |
|---|---|
| **[V-local]** | I ran it on this machine (Claude Code 2.1.318). |
| **[V-raw]** | I downloaded the primary page with curl and checked the exact wording. |
| **[P]** | Read from a primary source through a fetch tool that returns a model summary of the page. The source is right, but the wording may be paraphrased. |
| **[S]** | Secondhand: blog, press, or search snippet. |
| **[U]** | User report: GitHub issue, Hacker News comment, or review site. It is real testimony, not measured fact, unless the row gives a method. |

I did not run any of these products except Claude Code. I never held a Codex Micro, and I did not open Mission Control or Devin Desktop. Everything about their feel is inferred from docs. Reddit was not read directly; those items are relayed by blogs. See the ledger in section 9.

## 1. Bottom line

1. **The category has converged.** Every center is now a list or board of sessions with a small state set, a peek-and-reply affordance, git worktree isolation, and a diff review step. Copying this is table stakes and does not differentiate Venezia.
2. **The two sharpest failures are false "done" and unbounded spend, and both are mechanical.** They are not primarily interface problems. One measured study found stale passes were 32 of 36 sampled unbacked "tests pass" claims, and 73% of test runs were piped through `tail` or `head`. Spend failures are about agents that keep running when blocked or looping.
3. **Factory's published architecture is the best public blueprint, and it is more serial than its marketing.** It writes a validation contract before features, gives each worker a fresh context, and uses independent validators. In its worked example validation took 37% of runtime and 34% of features were fixes.
4. **Claude Code already exposes what Venezia needs, with one hard fork.** `--max-budget-usd` works and trips cleanly on this machine, but only with `-p`. `--bg` cannot combine with `-p`. So a hard budget and agent view are mutually exclusive, and Venezia must run its own supervisor.
5. **Open ground exists.** I found no product with load-bearing game state, proof receipts invalidated by later edits, budget as a live steering object, a spoken decision loop for approvals, or a personal (rather than organizational) learning layer.

## 2. Teardowns

### 2.1 Factory (Droids, Missions, Mission Control)

Factory's domains moved: `factory.ai` and `docs.factory.ai` now 308-redirect to `factory.com` and `docs.factory.com` **[V-local]**.

**Positioning.** Factory 2.0 (2026-06-15) describes a closed loop in which signals are triaged, built, tested, reviewed, shipped, and monitored, and monitoring creates new signals. The autonomy spectrum is droids and skills, Automations, Droid Computers, Missions **[P]**. [Factory 2.0](https://factory.com/news/software-factory)

**Mission flow** **[P]**, from [Missions docs](https://docs.factory.com/cli/features/missions) and [Planning](https://docs.factory.com/docs/missions/planning):

1. `/missions` opens a planning conversation. Droid pushes back and asks questions.
2. The plan settles features, ordering, milestones, skills, and how work is validated.
3. On approval, the session enters Mission Control.
4. Sizing heuristic: about 1 to 500 features. Above that, split into several Missions.
5. Cost floor: `total runs ≈ #features + 2 × #milestones`. The docs say this is a floor, since the orchestrator can create fix features.

**Architecture** ([How Missions Work](https://factory.com/news/missions-architecture)):

- **[V-raw]** Two named failure modes: irrelevant context accumulates, and "adversarial context" accumulates, because an agent judges its own work worse than a fresh reviewer does.
- **[V-raw]** Workers iterate, then hand off, and an independent validator makes the final call on correctness. Validators surface problems and do not fix them.
- **[V-raw]** The orchestrator writes the **validation contract** before features: a finite checklist of testable assertions that define done.
- **[V-raw]** A programmatic runner walks the feature list and spawns one worker per feature, in order. Marketing says "parallel Droids" ([product page](https://factory.com/product/missions) **[P]**), and the docs list "whether parallel agents outperform sequential execution" as an open question **[P]**. Treat serial as the proven path.
- **[P]** Assertion IDs look like `VAL-AUTH-001`, each with a tool and evidence requirement. Two validator kinds exist: scrutiny (code and trajectory review) and user-testing (black-box exercise of the app).
- **[V-raw]** State is externalized in shared artifacts: the contract, the feature list, research notes, guidelines and a growing knowledge base.

**Worked example, a Slack clone** **[P]**, self-reported by Factory:

| Metric | Value |
|---|---|
| Runtime | 16.5 h: orchestration 2.3%, implementation 60.5%, validation 37.2% |
| Agent runs | 185 (63 workers, 27 validators, 82 validator subagents) |
| Tokens | 778.5M, of which 744.9M cache reads |
| Output | 38.8k lines, 52.5% tests, 89.25% statement coverage |
| Convergence | 6 milestones, 2 to 4 validation rounds each |
| Issues found | 81, of which 65 blocking |
| Fix features | 21 of 61 implementation features (34.4%) |

**Mission Control in the app** **[P]**, from [Running in the App](https://docs.factory.com/docs/missions/running-app):

- Top bar: elapsed time and credits used.
- Right sidebar: live log of workers and milestones, plus model dropdowns for orchestrator, worker, and validator.
- Main view: active milestone. Selecting a feature shows its validation criteria and commits.
- Left sidebar: active and completed workers. Selecting one shows terminal output, thought process, and subtasks.
- Steering: pause the orchestrator, have it re-assess or re-plan, resume.
- The CLI toggles the overlay with `Ctrl+T` **[S]**.

**Steering stance.** **[V-raw]** Factory says Missions are not fire-and-forget: the orchestrator is an agent, so you pause it, describe the problem in plain language and ask it to recover. [Overview](https://docs.factory.com/docs/missions/overview). Named trouble cases: frozen mission, slow worker, milestone stall, direction change, feature retry limit, failing validation.

**Readiness.** Missions need a single command that starts the full stack, logs on disk, and a scriptable driver (`tuistory`, `agent-browser`) **[P]**. Factory ships `/readiness-report` and `/readiness-fix`. Venezia controls its own project templates, so it can guarantee this at scaffold time.

**Statistics, with a date problem.** **[V-raw]** The [launch post](https://factory.com/news/missions) shows "February 26, 2025", the median Mission is about 2 hours, 14% exceed 24 hours, and the longest was 16 days. **[P]** A mission uses about 12x the tokens of a normal session at a similar burn rate. Factory's launch tweet ID decodes to 2026-02-26 **[V-local]**, so the page year looks like a typo. A search snippet said the longest Mission ran 40 days; I could not find that in any page I downloaded, so treat it as unverified.

**Mobile and voice.** The web and mobile product lets you watch progress, inspect tool calls, and unblock Droids; Droid Computers give remote persistence **[S]** ([web](https://factory.ai/product/web), [Droid Computers](https://factory.ai/news/droid-computers), [Remote Control](https://docs.factory.com/remote-control)). The only voice feature found is dictated answers in the October 2026 changelog **[S]**.

### 2.2 Cognition (Devin, Devin Desktop, Agent Command Center, Spaces)

**Timeline** **[P]**: [Windsurf 2.0](https://devin.ai/blog/windsurf-2-0) introduced the Agent Command Center and Spaces (2026-04-15). [Windsurf became Devin Desktop](https://devin.ai/blog/windsurf-is-now-devin-desktop) (2026-06-02). Refresh on 2026-10-23.

**Primitives** **[P]**:

- A Kanban view of local and cloud agents, by status: working, blocked, ready for review. Exact column names are not published.
- **Spaces** group sessions, PRs, files, and context for one task. New sessions inherit project context, and the view is restored on return. Example: "Onboarding Flow Redesign" with one local and two cloud sessions. Every session is a Space by default, and sharing is set by `devin.spaces.shareContext` **[S]**. Dragging a session onto a card creates a Space ([changelog-next](https://docs.devin.ai/desktop/changelog-next)) **[S]**.
- **Handoffs** in both directions: plan locally and send to Devin in one click; pull a Devin PR back to a local agent.
- **ACP** lets Codex, Claude Agent, and OpenCode appear in the same board as first-class sessions.
- Four surfaces: Desktop, Cloud, CLI, Review.

**October refresh** **[P]**, from the [changelog](https://docs.devin.ai/desktop/changelog), v3.11.212: the Agent Window runs the same interface as the Devin web app, Review, Automations, and Wiki live inside it, and you can drag sessions together to view up to 8 side by side. Earlier: agent inbox list with batch archive (v3.9.19), and a location picker of Local, Worktree, Cloud.

**A steering limit worth noting** **[V-raw]**: sessions "appear greyed out and are read-only until the agent finishes" ([Agent Command Center docs](https://docs.devin.ai/desktop/agent-command-center)). Queued messages can be edited **[P]**. OS notifications for finished or input-needed sessions are off by default **[P]**.

**Budget** **[S]**: `max_acu_limit` per session in the [v3 Create Session API](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions); [Automations](https://docs.devin.ai/product-guides/automations) stop when a per-session ACU budget is hit. This is one of the few real hard caps in the category.

### 2.3 OpenAI Codex app (now folded into the ChatGPT desktop app)

Docs moved: `developers.openai.com/codex/*` 308-redirects to `learn.chatgpt.com/docs/*`, and those pages now speak of "the ChatGPT desktop app" with Chat and Work modes **[V-local]** **[P]**.

- **Launch.** macOS 2026-02-02, Windows 2026-03-04 **[S]**.
- **Worktrees and automations.** Isolation per thread. Automations land in a review queue, and frequent ones create many worktrees **[S]**.
- **Goals** **[P]** ([Long-running work](https://learn.chatgpt.com/docs/long-running-work)): `/goal` text is both first prompt and completion criteria. `/plan` first refines it to measurable criteria. A progress row offers pause, resume, edit, clear. A side chat gives a recap without interrupting. The goal "pauses when it needs a decision." "ChatGPT decides when the work is complete." The page does not mention budgets or caps.
- **Voice** **[P]** ([Voice](https://learn.chatgpt.com/docs/features/voice)): two modes, dictation and live ChatGPT Voice. Voice can start tasks, check them, and send follow-ups, and you switch with "Let me talk to the task reviewing the tests." It follows the permissions of the tasks it directs. Only one voice chat at a time. "Take a look at this" captures an appshot of the front window. Also on iOS after pairing. Built on full-duplex GPT-Live, announced 2026-07-23 **[S]** ([VentureBeat](https://venturebeat.com/orchestration/agentic-coding-goes-hands-free-as-openai-brings-gpt-lives-full-duplex-voice-control-to-codex-and-chatgpt-on-the-desktop)).
- **Mobile** **[P]** ([Mobile](https://learn.chatgpt.com/docs/mobile)): pair by QR. Approval options are Approve, Always approve, Tell Codex what to do, Deny. That third option, an approval that doubles as a steering prompt, is worth copying.
- **Pets** **[P]** ([Pets](https://learn.chatgpt.com/docs/pets)): a floating companion showing Running, Needs input, Ready, or Blocked, which can also start a chat by typing or speaking. "Choosing a pet changes its appearance, not how ChatGPT completes tasks." Reduced-motion is honored with a still frame.
- **Sites** **[P]** ([Sites](https://learn.chatgpt.com/docs/sites)): build, host, and share a site by describing it. Hosting is free through 2026-12-31, with overages from 2027-01-01. This is the closest thing to idea-to-published in a major vendor product, and it is cloud-bound.

### 2.4 Codex Micro (exact hardware)

Primary sources: [OpenAI docs](https://learn.chatgpt.com/docs/features/codex-micro) (LED table, stick defaults, and 350 ms timing **[V-raw]**; other rows **[P]**) and the [Work Louder page](https://worklouder.cc/codex-micro) **[P]**.

**Layout.** 13 mechanical keys (POM/POK), 1 rotary dial, 1 planar joystick, 1 touch sensor, RGB through a unibody polycarbonate frame. USB-C or Bluetooth (three channels). Mac and Windows. No microphone; it uses the computer's **[P]**. Price $230. Marked sold out on the Work Louder page. Essentially a Creator Micro 2 **[S]** ([New Atlas](https://newatlas.com/computers/openai-codex-micro-keyboard/)), and the ChatGPT app also supports that device **[P]**.

**Six Agent Keys** (frosted). One press switches chat without raising the window; two presses within 350 ms also bring the window forward. Keys follow Most recent (default), Pinned, Priority, or Custom assignments. The selected chat's key pulses.

| Light | Status | Meaning |
|---|---|---|
| White | Idle | Chat is idle |
| Blue | Thinking | Working |
| Green | Complete | Completed with an unread update |
| Amber | Requires input | Needs your approval or response |
| Red | Error | Something went wrong |
| Off | No assigned chat | Key follows no chat |

**Green means unread, not merely finished.** The light is a to-do, which clears when you look.

**Command Keys, defaults:** Fast mode toggle, Approve, Decline, Continue in a new chat, Mic (wide key), Send.

**Push-to-talk.** Hold to speak, release to stop. Double-press within 350 ms for hands-free, press again to stop. Lighting: a sea-green light moves around the keyboard while recording, a moving white light while processing, and solid white when the prompt is ready.

**Joystick defaults:** Up toggles Plan mode. Right and Left go forward and back in app history. Down toggles the sidebar. Any direction can be assigned a command or skill. Work Louder describes it as holding "4 preset or custom skills" **[P]**.

**Dial modes:** Composer navigation (default), Reasoning only, Conversation scrolling, Custom. Press-and-hold opens settings. When a dial menu is open, the key to the right of the dial lights red and cancels.

**Details that show care:**

- Lights turn off after three minutes by default, and come back on use **or when an Agent Key's status changes**. Quiet until something needs you.
- Layer 1 is ChatGPT. Work Louder Input can configure five more layers.

**Secondhand claims the primary docs correct:**

| Common claim | Primary source |
|---|---|
| "The dial sets reasoning level" | That is one of four modes. Default is composer navigation. |
| "The joystick launches workflows" | Defaults are navigation and Plan toggle. Skills are optional assignments. |
| "The whole perimeter lights up" (Tom's Hardware snippet) | True of the RGB frame, but the docs tie the moving light to voice recording. Agent status is on the keys. |
| "Needs input is yellow" | Amber. |

**Hands-on verdict** **[U]** ([Kingy](https://kingy.ai/blog/codex-micro-review/)): Agent Keys are "genuinely useful", but six threads make it "a priority board, not a complete operations console." Agent Keys work only with the desktop app running **[S]** ([TechTimes](https://www.techtimes.com/articles/320670/20260716/openai-codex-micro-ships-today-agent-keys-only-work-chatgpt-desktop.htm)).

### 2.5 Claude Code (the engine Venezia drives)

**Agent view** **[P]** ([docs](https://code.claude.com/docs/en/agent-view)), research preview:

- **States:** Working, Needs input (yellow), Idle, Completed (green), Failed (red), Stopped (grey). Groups: Pinned, Ready for review, Needs input, Working, Completed.
- **Rows:** name, one-line summary written by a Haiku-class model, age, PR badge with colored state.
- **Peek:** `Space` opens the panel. Replies queue behind the current turn, except `/model`, `/effort`, `/rename`, `/usage`, which run immediately. A reply of exactly `/stop` stops the session.
- **Limit:** permission and sandbox dialogs cannot be answered from peek. You must attach.
- **Filters:** `s:blocked` lists everything waiting on you.
- **Attach:** Claude posts a recap of what happened while you were away.
- **Machine interface:** read state with `claude agents --json --all`, not with files under `~/.claude/jobs/`. `state` is `working`, `blocked`, `done`, `failed`, or `stopped`. `waitingFor` is `permission prompt`, `input needed`, `sandbox request`, `worker request`, or `dialog open`.
- **Worktrees:** dispatched sessions use `.claude/worktrees/`. Sessions commit, push their isolated branch, and open a draft PR, and never push to `main` or `master`.
- **Supervisor:** survives terminal close and sleep, not shutdown. Unattached finished sessions stop after about an hour. Low memory appears as `possibly low memory`.
- **Limitation, from the docs:** ten parallel agents use quota about ten times as fast as one.

**`/goal`** **[P]** ([docs](https://code.claude.com/docs/en/goal)): a small fast model checks the condition after each turn, so a fresh model, not the one doing the work, decides completion. **But it does not run commands or read files itself, so it judges only what Claude surfaced.** That is an independent judge with no independent evidence, and it cannot catch a stale pass by itself. Rate limits pause it, which is the behavior that Codex reporters asked for.

**Remote Control** **[P]** ([docs](https://code.claude.com/docs/en/remote-control)): session stays local; outbound HTTPS only, no inbound ports; subscription only, API keys unsupported; server mode with `--spawn worktree` and `--capacity`; two separate phone push toggles, for proactive updates and for actions required. Server mode exits after about 10 minutes of network outage. This may be a cheap route to phone alerts, but it is documented for interactive and server-mode sessions, and I did not confirm it works for `-p` runs.

**Auto mode** **[V-raw]** ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)): users "accept 93% of" manual prompts. On real overeager actions (n=52) the full pipeline has a 17% false-negative rate, which Anthropic calls "the honest number."

**Verified on this machine [V-local]:**

| Finding | Evidence |
|---|---|
| `claude agents --json` exists and needs no TTY | Help text, v2.1.318 |
| `--max-budget-usd` "only works with --print" | Help text |
| The cap works on this account, which has no API key per the project brief | Ran `claude -p --model haiku --max-budget-usd 0.000001`: exit 1, `subtype: error_max_budget_usd`, `terminal_reason: budget_exhausted` |
| The cap overshoots | Same run: `total_cost_usd` 0.000227 against a 0.000001 cap. It stopped after spend, not before. |
| `total_cost_usd` is reported on every `-p` run | Normal run: 0.0024 for one word, because cached context loads first |
| `--input-format stream-json`, `--include-hook-events`, `--permission-prompt-tool`, and `--permission-prompts host\|none` exist | Help text. I did not exercise them. |

The reported cost is an API-equivalent figure, which is not necessarily a subscription charge. The docs say `--bg` cannot combine with `-p` **[P]**.

### 2.6 Others

| Product | Status | Primitive worth taking | Evidence |
|---|---|---|---|
| **Conductor** | Mac app, Claude Code, Codex, Cursor, OpenCode | One workspace per task, with branch, files, terminal, diff, review path. A **Checks tab** as "last review pass before merge" collects git status, CI, deployments, review threads, and todos, and may block merge on open work | **[P]** [docs](https://www.conductor.build/docs), [Checks](https://www.conductor.build/docs/reference/checks) |
| **Vibe Kanban** | Sunset by Bloop 2026-04-10; open source, Apache-2.0, 28.6k stars | Diff comments sent back to the agent; browser preview with devtools. Stated reason for closure: mostly free users and no business model, not product failure | **[P]** [repo](https://github.com/BloopAI/vibe-kanban), **[S]** [shutdown](https://vibekanban.com/blog/shutdown) |
| **Amp** | Active | Modes (smart, rush, deep); an **Oracle** subagent for second opinions; `/handoff` starts a clean thread carrying context; shareable threads | **[S]** [manual](https://ampcode.com/manual) |
| **Jules** | Active | Plan-first, with a warning: "If you navigate away, Jules will eventually auto-approve the plan." The API has `requirePlanApproval` **[S]**. Suggested Tasks propose work for approval **[S]** | **[P]** [docs](https://jules.google/docs/review-plan/) |
| **Cursor** | 3.0 released 2026-04-02 **[S]** | Cloud agents test their own work and attach "artifacts (videos, screenshots, and logs)" to PRs | **[P]** [changelog](https://cursor.com/changelog/02-24-26) |
| **Google Antigravity** | 2.0 in May 2026 **[S]** | Comment directly on an artifact (plan, screenshot, recording); the agent absorbs it without stopping. Closest to non-blocking steering | **[S]** [Google](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/) |
| **GitHub Agent HQ** | Announced 2025-10-28 | Cross-vendor mission control; a governance posture | **[S]** [GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/) |
| **Gas Town** (Yegge) | Open source, early 2026 | Theatrical role names (Mayor, Polecats, Convoys, Witness, Refinery). The Mayor is the one agent you talk to and does not do the work | **[S]** [O'Reilly](https://www.oreilly.com/radar/steve-yegge-wants-you-to-stop-looking-at-your-code/) |
| **SKI, HeyZoku, AgentWire** | Small voice tools | AgentWire is push-to-talk in a browser, routed to a tmux session, with TTS back: "a walkie-talkie for your AI coding setup." Its author asks whether PTT or wake word is right, unanswered | **[S]** [SKI](https://justski.it/), **[P]** [AgentWire](https://news.ycombinator.com/item?id=46968740) |
| **Pixel Agents, Claude Office, Roundtable** | Open source visualizers | Each session becomes a character in a pixel office. They display activity and I saw no control surface | **[S]** [claude-office](https://github.com/paulrobello/claude-office) |

## 3. Interaction primitives catalog

Verdict: **Adopt**, **Adapt**, or **Skip** for Venezia.

| Primitive | Seen in | Verdict |
|---|---|---|
| Plan conversation that pushes back | Factory, Jules, Codex `/plan` | **Adopt.** Voice-friendly. |
| Validation contract before features | Factory | **Adopt.** The single most important idea here. |
| Independent validator with fresh context | Factory | **Adopt**, and let it run commands, unlike `/goal`. |
| Pause, re-plan, resume in plain language | Factory | **Adopt** as a big button and a spoken phrase. |
| Approve, Deny, plus "tell it what to do" | Codex mobile | **Adopt.** |
| Comment on an artifact without stopping the run | Antigravity | **Adopt.** The best steering primitive found. |
| Peek and inline reply | Claude agent view | **Adapt.** Must include permission answers, which agent view lacks. |
| Recap on return | Claude attach, Codex side chat | **Adopt.** Should be spoken. |
| One-line live summary per session | Claude agent view | **Adopt.** Becomes TTS status. |
| Five-color status | Codex Micro, agent view | **Adopt** the idea of a few plain status colours. |
| "Green means unread" | Codex Micro | **Adopt.** |
| Hold to talk, double-tap to latch | Codex Micro | **Adopt** on screen and physical keys. |
| Silent until status changes | Codex Micro | **Adopt** as the default ambient mode. |
| Six attention slots | Codex Micro | **Adopt** as an attention cap, not a hardware limit. |
| Kanban | Devin, Vibe Kanban | **Skip** as primary. Vibe Kanban's board was retired **[S]**, and Claude uses groups. Keep as an alternate view. |
| Spaces | Devin | **Adapt.** In Venezia, each idea is its Space by default. |
| Side-by-side sessions, up to 8 | Devin | **Skip** for mobile-first. |
| Checks tab before merge | Conductor | **Adapt** into the publish gate. |
| Video and screenshot proof | Cursor | **Adopt.** Chrome is available locally. |
| Scaffold readiness check | Factory | **Adapt.** Bake it into templates. |
| Handoff to a clean thread | Amp, Devin | **Adopt.** Pairs with fresh-context workers. |
| Model mix by role | Factory | **Adopt.** Strong orchestrator, cheaper workers. |
| Pets | Codex | **Adapt.** Make the creature carry real state and control. |
| Fork a session | Claude `/fork` | **Adopt** for "try it both ways." |
| Auto-approve timers | Jules | **Skip.** Silence must never mean yes. |

## 4. What users actually complain about

**4.1 False "done"**

- [claude-code #104504](https://github.com/anthropics/claude-code/issues/104504) **[U, measured]**, one team, Claude Code 2.1.304, filed 2026-10-23. Of 357 claims in 150 sessions: 178 backed, 80 no backing run, 92 unverifiable, 5 contradicted, 2 other. Of 36 unbacked claims in the dev set: **32 stale** (code edited after the passing run), 3 narrowed runs presented as the full suite, 1 no run at all. 1,514 of 2,084 test runs (**73%**) were piped through `tail` or `head`, where a failing exit code can be masked without `pipefail`. Open, with no maintainer reply.
- [One developer's audit](https://dev.to/vinzenz_eiberger/i-checked-101-tests-pass-claims-from-my-ai-coding-agents-35-werent-true-h6n) **[U, small sample]**: 35 of 101 claims were untrue when made (Codex 29 of 68, Claude Code 6 of 33). The author warns the workloads differ, so this is no model ranking. His detector reached only 73% accuracy, below his 90% bar for blocking.
- [HN on Ars piece](https://news.ycombinator.com/item?id=50059523) **[U]**: AI tests "asserted that the defective behavior was correct", and "Coverage is increasingly becoming theater." **A green suite is not proof if the same agent wrote the tests.** This is why the contract must precede the code.
- Devin: a reviewer says it can "spend significant time pursuing the wrong solution without recognizing it" **[U]** ([Gartner](https://www.gartner.com/reviews/product/devin-ai-568760006)). A review citing Answer.AI's 2025 test says testers saw it "spending days on impossible approaches" **[V-raw for the review, S for the test]** ([review](https://saas.com.ai/devin-ai-review/)).

I found no measured false-done rate for Factory Missions or Devin.

**4.2 Runaway cost and zombie loops**

- [claude-code #85422](https://github.com/anthropics/claude-code/issues/85422) **[U]**, open, labeled `area:cost`: "There is no mechanism anywhere in Claude Code that **stops** runaway token consumption." Linked cases: 5 planned agents became 361+ background agents and consumed a full 5-hour quota; 10 background tasks stuck 34+ hours; 430M tokens burned in failed retries. A key point: a signal the model can read is no use when the model is not what is spending. A maintainer replied that `claude -p --max-budget-usd` is a hard cap and that interactive sessions, per-source attribution, and rolling-window budgets have no equivalent.
- Other notes in that thread: hook subprocess spend never enters CLI accounting; parent-only caps miss nested subagents, so caps must aggregate the spawn tree; "absent" must differ from "zero."
- [claude-code #68619](https://github.com/anthropics/claude-code/issues/68619) **[U]**: recursion past 50 levels, per the reporter.
- OpenAI `/goal` cluster **[U]**: repeating after compaction, up to hundreds of turns ([#47707](https://github.com/openai/codex/issues/47707)); goal lost after compaction ([#31659](https://github.com/openai/codex/issues/31659)); 25% of a weekly limit lost overnight asking for confirmation ([#22833](https://github.com/openai/codex/issues/22833)); a blocked goal keeps running, with the ask "when blocked, /goal should pause" ([#23177](https://github.com/openai/codex/issues/23177)); continuation after quota exhausted ([#21536](https://github.com/openai/codex/issues/21536)); explicit pause ignored, 1.26M tokens in 12 no-op turns ([#41831](https://github.com/openai/codex/issues/41831)). Several are closed, and I did not verify which are fixed.
- [HN 47218318](https://news.ycombinator.com/item?id=47218318) **[U]**: parallel agents "hit Max plan limits in under an hour", and "weekly quota by around day 3-4" on a $200 plan.
- Factory: Mission quota can run out mid-run on lower plans, and Missions pause at rate limits **[S]** ([review](https://continuumcode.ai/guides/factory-ai-review/)).

**4.3 Attention and review**

- "it looks cognitively like being a pilot landing a plane _all day long_" and "The current bottleneck is validation" **[U]** ([HN](https://news.ycombinator.com/item?id=47218318)).
- Review as "hands down the biggest bottleneck" **[U]** ([HN](https://news.ycombinator.com/item?id=45489884)).
- Past three or four agents, review degrades into rubber-stamping **[S]** ([HackerNoon](https://hackernoon.com/how-to-build-a-team-architecture-around-ai-agents-without-burning-out-on-review)).
- 2 to 3 focused agents beat 6 to 8 competing ones, which create merge conflicts **[U]**.
- One commenter doubts that the number of parallel agents is the right productivity metric **[U]**.

**4.4 Steerability**

- Devin locks sessions read-only during a run; Claude peek replies queue; Jules auto-approves plans.
- Goal drift after compaction (#31659).
- "so unsupervised and unsupervisable" **[U]**. One user reports Claude "bypassed the deny list and nuked an important untracked directory" **[U]** ([HN](https://news.ycombinator.com/item?id=47218318)).
- Pause is the documented recovery tool in Factory and Codex, and #41831 shows it must be state, not a chat request. The reporter says the loop stopped only after the persisted status was changed.

**4.5 Approval fatigue**

93% acceptance means prompts are largely theater, and the classifier replacement misses 17% of real overeager actions (section 2.5). Neither pure mode is enough, so gating belongs on irreversible actions.

**4.6 Housekeeping**

Worktrees pile up in both Codex **[S]** and Claude Code **[P]**. Droid is "less stable" **[U via S]**. Six keys are too few for fleets **[U]**.

**Gaps in this evidence:** I found no independent hands-on review of Mission Control. Public Devin reviews are thin, and many are affiliate-style. Issue reports are self-selected, so they show that failures exist, not how often they occur.

## 5. What existing products do not do

"Not found" means not in the docs and reviews I read, which is weaker than proof of absence.

1. **Load-bearing game state.** Pets are explicitly cosmetic. Pixel offices appear to observe only. Nobody seems to make the game the control surface, with selection, control groups, an alert channel, and a resource bar. Voice RTS control of coding agents turned up nothing.
2. **Proof receipts that expire.** Validators and video exist, but I found no user-facing "done" object bound to a commit SHA, real exit code, and timestamp that is automatically voided by a later edit. A runtime can enforce this mechanically, and issue #104504 suggests it would address most false claims in that sample.
3. **Budget as a live control.** Credits are displayed (Factory), and caps exist (Devin, `--max-budget-usd`), but I found no steerable, spawn-tree-aware budget with breakers on non-progress, in a personal tool.
4. **Blocked costs zero, guaranteed.** The Codex cluster shows this was not a given. Venezia can enforce it in its runner, not by asking the model.
5. **A spoken decision loop.** Codex Voice can start, check, and redirect tasks in conversation, so talking to work is taken. I found no batched spoken brief and no documented spoken approval flow, such as "read me the three decisions waiting" while walking. Claude Code offers dictation.
6. **Attention budgeting.** Lists group by state, and none rank interruptions by cost of delay or cap work in progress to protect the human.
7. **A personal memory.** Factory's learning is organizational, and Devin has a Wiki. I found no taste-and-preference model that learns one person's design decisions and rejected ideas across projects.
8. **One thread from spoken idea to public URL under local control.** Codex Sites approaches this, in OpenAI's cloud. Enterprise centers stop at a PR.
9. **Device-agnostic control.** Micro is bound to one desktop app. Web, phone, physical keys, and voice all driving one state machine is open territory.
10. **Headless and visual parity.** Factory comes closest with `droid exec --mission`. A personal factory can treat the API as primary and every interface as a client.

## 6. Implications for Venezia

Items marked **Needs test** rest on flags I confirmed exist but did not exercise.

**Engine**

1. **Run a Venezia supervisor around `claude -p --output-format stream-json --max-budget-usd`,** not agent view, because the hard cap requires `-p`. Read `claude agents --json` only to display outside sessions.
2. **Needs test:** `--input-format stream-json` for mid-run messages, `--permission-prompt-tool` or `--permission-prompts host` to route approvals to phone and voice, and whether `--max-budget-usd` stops subagents, as the maintainer said.
3. **Default to serial with a concurrency cap of 2** on this 8 GB machine, and grow only with evidence. Factory's own proof case is serial, the docs list parallel as an open question, and users report 2 to 3 as the useful range.

**Dependability**

4. **Pipeline:** contract, then features, then milestones, then an independent validator, each in fresh context, with state in files.
5. **Budget planning:** assume about a third of runtime for validation and a third of features as fixes. Use `runs ≈ features + 2 × milestones` as the displayed floor.
6. **Done is a receipt produced by Venezia, not stated by the model.** It holds commit SHA, command, real exit code from a `pipefail` wrapper, timestamp, and scope (full suite or narrowed). Any later edit voids it. UI work adds a Chrome screenshot or video.
7. **Tests from the contract come before the code,** written by a role that does not implement, because AI tests can bless defects.
8. **Breakers live in the runner.** Per-run and per-tree caps; pause on `blocked` with zero model calls; loop detection on repeated output, no tool use, and repeated compaction; awareness of the 5-hour window. Overshoot is real, so set caps below limits. Report "not measured" separately from zero.
9. **Pause is persisted state,** never a request to the model.
10. **Gate irreversible actions only:** delete outside the worktree, push to `main`, publish, spend above budget, secrets. Auto-approve the rest. Silence never approves.

**Control surface**

11. **One state machine, many clients,** with a few plain status colours: white idle, blue working, green done-unread, amber needs you, red failed, off empty. Add grey stopped from Claude Code. Colour is never the only signal, and honor reduced motion.
12. **Six visible slots,** as an attention cap. Keep the command set: Approve, Decline, Redirect, Talk, Send, New.
13. **A decision inbox as the home screen:** one card at a time, ranked by cost of delay, with Approve, Decline, and "tell it what to do."
14. **Steer without stopping:** comment on an artifact and the run absorbs it at the next safe point. Pause and re-plan is the heavy option.
15. **Silent until a state changes.** Notifications go out only on amber, red, and receipts.

**Voice**

16. **Hold-to-talk by default,** double-tap to latch, with Micro's three-stage feedback. Wake word can wait.
17. **Name runs so voice can address them,** as in "talk to the checkout build."
18. **Add a spoken brief and spoken recap,** generated from the one-line summaries. Irreversible actions need an on-screen confirmation, so a misheard word cannot publish.

**Game layer**

19. **The game is the state, not decoration.** Budget is a visible resource, runs are units, amber is a raised flare, receipts are trophies. If it does not map to real state or a real control, cut it.
20. A theme suggestion, mine rather than sourced: the Venetian Arsenale was a historic shipbuilding works, which suits "ideas become ships launched from a yard."

**Competitive caution:** do not rebuild diff review, Kanban, or a multi-vendor board. Spend the effort on receipts, breakers, the inbox, voice, and the game layer.

## 7. Open questions for later tracks

- Does `--input-format stream-json` deliver a message mid-turn, or queue it?
- How many concurrent `claude -p` runs are stable on 8 GB with a browser validator running?
- Can a supervised `-p` run reach the phone through Remote Control push, or does Venezia need its own notification path?
- Can a Web interface capture a Creator Micro 2 as generic keystrokes? I did not test this, and no device is confirmed on hand.

## 8. Dead ends

- The [Cognition post](https://x.com/cognition/status/2113671026286682500) and Fast Company's pixel-agent piece could not be fetched (402 and 403). The changelog covers the first.
- MarkTechPost's Droid 1.0 article returned 403, so Droid 1.0 and Factory's "17% fewer tokens" claim are snippets only **[S]**.
- Many mid-2026 Codex doc paths guessed from labels returned 404; correct paths are in this report.
- Amp's page carries text aimed at language models. I ignored it as instructions.

## 9. Verification ledger

**Verified directly**

| Item | How |
|---|---|
| Claude Code 2.1.318 flags and behaviors in section 2.5 | Ran on this machine. Three tiny headless Haiku calls in total. |
| Factory: fresh reviewer bias, "not their call", contract wording, in-order runner, externalized state, "not fire-and-forget" | curl and grep |
| Factory launch page date and 16-day longest run | curl and grep |
| Tweet dates | Decoded from post IDs |
| Codex Micro LED table, stick defaults, sea-green recording light, 350 ms latch | curl and grep |
| Anthropic 93% and 17% | curl and grep |
| Devin "greyed out and are read-only" | curl and grep |
| Domain moves | 308 responses |

**Primary source, read through a summarizer**

All other Factory docs figures, Devin changelog and blogs, Codex goals, voice, mobile, pets, and Sites pages, Work Louder spec page, agent view, `/goal`, Remote Control, Conductor, Jules, Cursor changelog, and the GitHub issues.

**Secondhand only**

Codex app launch dates, GPT-Live details, Droid 1.0, Antigravity features, Cursor 3 release date, Gas Town, Agent HQ, Devin ACU parameters, Factory phone features, all Reddit items, and pricing or rollout details.

**Disagreements in the sources**

- Longest Mission: 16 days (Factory page) versus 40 days (snippet).
- Factory launch year: page says 2025; the post ID says 2026.
- "Parallel" marketing versus "in order" engineering at Factory.
- Dispatch availability differs between Claude Code docs and the Help Center **[S]**. Not used here.
