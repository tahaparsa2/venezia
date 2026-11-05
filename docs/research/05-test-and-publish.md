# 05: Test and Publish (track: ship)

How Venezia should prove a generated app works, and how it should put that app in the world.

Date: 2026-11-04. Machine: macOS, 8 CPU, 8 GB RAM, Node 25.8.1, npm 11.11.0, gh 2.103.3, Chrome 156.0.8078.80.
Nothing remote was created. GitHub calls were read-only. No real publish was run against any provider.

## 1. Conclusions

1. **The gate must own its own acceptance surface, or it proves nothing.** My first gate caught every honest failure and then lost to all six cheats a lazy agent would try (`"test": "exit 0"`, deleted tests, hardcoded smoke answers, a silenced console, a stub server, automation sniffing). Locking the contract, tests and scripts by hash, adding a runtime nonce to smoke input, and installing error capture before page scripts closed all six. Final score: 36 of 36 web cases correct, 9 of 9 non-web cases correct.
2. **The gate proves the app works, not that it is the right app.** Three known gaps still PASS by design: a missing feature the contract never asked for, an ugly UI, and user-agent sniffing. These need the planner to write a good contract, an independent reviewer and the human.
3. **Local dev servers lie.** `vite preview` answers 200 for missing files through SPA fallback, macOS disks are case-insensitive, and apps tested at `/` break at `/<repo>/`. The gate needs a gate-owned host simulator with per-target rules, and that simulator is also the best available dry run for GitHub Pages.
4. **On GitHub Free, Pages needs a public repo.** The recommended design keeps source private and pushes only built output to one public `venezia-sites` repo, on a `gh-pages` branch. That also avoids two scope problems in a default `gh` token: no `workflow` scope, so workflow deploys are expected to fail, and no `delete_repo` scope, so per-app public repos could not be deleted.
5. **System Chrome works well at about 7 s per gate run.** Use `channel:'chrome'` by default with a one-at-a-time browser lock. Peak real memory is about 460 MB for two contexts. `chrome-headless-shell` uses 5x less (87 MB) and is the fallback under memory pressure, but it has no WebGPU adapter and no real GPU.
6. **Publishing goes through a broker, never through the agent.** Adapter contract: `probe / plan / dryRun / apply / verify / rollback`. Approval binds to the hash of the exact payload.

## 2. What I verified and what I only read

**Verified by running it here:** everything under section 3 (browser and gate), section 4 (checks through read-only `gh api`), tarball and bare-repo rehearsals, `wrangler deploy --dry-run`, the unauthenticated `vercel --dry` error, CLI flags as printed by `--help` on the installed versions, and the Pages `cache-control` header.

**Read only, not run:** all live provider behaviour, including Pages site creation, `--temporary` deploys, Vercel and Cloudflare limits and pricing, and `gh gist create` binary rejection (read in source). These carry a source link.

**Inferred, not directly observed:** workflow-file pushes failing without the `workflow` scope (reports plus GitHub's scope description; testing it needs a remote write). This is flagged where used.

**Not tested at all:**
- Any live publish or live post-publish check.
- A real iPhone or Safari. Playwright's "iPhone 15" here is Chromium with a phone viewport, touch and user agent. It catches layout, not WebKit bugs.
- Whether `SpeechRecognition` works headless. The API object exists in both browsers; recognition itself was not exercised.
- A phone actually reaching the Mac over Wi-Fi. I only confirmed the LAN IP answers from the same machine.

## 3. Verification

### 3.1 Playwright with system Chrome

`playwright-core` 1.64.1 installed in scratch: 13 MB, about 1 s. It drove Chrome 156 with `chromium.launch({channel:'chrome', headless:true})`. The user's own Chrome was running at the time (59 processes, 1.8 GB RSS). The test browser used a throwaway profile, did not interfere, and left no processes behind in any run.

Five passes of measurement, then a separate head-to-head:

| Measure | Chrome channel | chrome-headless-shell |
|---|---|---|
| Launch, warm | 223–556 ms | 55–58 ms |
| Launch, first | 653–1673 ms | 2637 ms |
| Sum of RSS, 2 contexts (double-counts shared memory) | 1109–1166 MB, 9 procs | 354–370 MB, 5 procs |
| **`phys_footprint`, 2 contexts** (the honest number) | **455–464 MB** | **86–87 MB** |
| Download | 0 | 206 MB (203 MB shell, 3 MB ffmpeg) |
| WebGL2 | Yes, real Metal GPU (Apple M2) | Yes, SwiftShader software |
| WebGPU adapter | Yes | No (`api-no-adapter`) |
| Version control | Tracks Chrome auto-update | Pinned to the Playwright release |

Chrome channel only, from the 5-pass run:

| Measure | Result |
|---|---|
| Sum of RSS: idle / 1 page / 4 contexts | 372–496 MB / 766–1043 MB / 1966–2111 MB (13 procs) |
| Phone viewport screenshot (393×659 @3x) | median 99 ms, about 150 KB |
| Phone full-page screenshot | median 322 ms, about 1 MB |
| Desktop viewport screenshot (1440×900 @2x) | median 116 ms, about 180 KB |
| Desktop full-page screenshot | median 493 ms, about 840 KB |
| First-ever screenshot after cold launch | **1416 ms**, and different bytes from later runs |
| Browser close | 144–182 ms |

Error capture worked: `console.error`, `console.warn`, uncaught exceptions, unhandled rejections, a throw inside a click handler, and 404s were all captured with the right text.

Consequences:
- Do not compare screenshot hashes across cold runs. The first shot was not byte-stable. Use them as evidence, not as a regression oracle, unless the page is settled first.
- Record `browser.version()` in evidence, because system Chrome moves under you.
- Serialize browser use. Four contexts at about 2 GB RSS on an 8 GB machine that is already running the user's Chrome is the wrong place to spend memory.

### 3.2 The evidence gate prototype

Prototype, 162 lines, no dependency beyond `playwright-core`: `docs/prototypes/gate/gate.mjs`.

The mutation runner and results sit beside it (`mutants.py`, `mutants-result.json`). The fixtures and `ev/` output were temporary and are not in this repository.

The gate judges only exit codes, HTTP responses, browser events and pixels. It never reads an agent's claim. Output is `evidence.json` plus logs and 8 screenshots, 164 KB in total.

Passing web run: about 7 s in total.

| Step | What it decides | Typical time |
|---|---|---|
| `contract` | `venezia.contract.json` exists and matches the hash locked at plan time | instant |
| `locked-surface` | Test files and script bodies match hashes inside the contract | instant |
| `install` | `npm ci --ignore-scripts`; no lockfile is a failure | 0.3–0.5 s |
| `build` / `build-output` | Exit 0 **and** `outDir/index.html` exists and is non-empty | 1.2 s |
| `test` | Exit 0 **and** passing tests ≥ `minTests` | 0.3 s |
| `secret-scan` | Regex scan of every non-`node_modules` file, plus any `.env*` | instant |
| `start-health` | Server starts on an injected port and answers under 400 within 20 s | 0.4 s |
| `browser-server` | Phone and desktop: load, not blank, no overflow, viewport meta, no broken images, no console or page errors, no tamper, smoke steps pass | 2.3 s |
| `browser-host-sim` | Same checks on `outDir` served at `/<slug>/`, case-sensitive, with no SPA fallback | 2.0 s |

The health check timeout is the slow path, at about 22 s for a hung server.

**Non-web projects** take a different route, with the same principle: test the artifact a stranger would receive, not the working tree.

- CLI or library: `npm pack`, install the tarball into an empty folder, run contract-owned golden commands, compare exit code and stdout. The transcript replaces the screenshot.
- Python: `uv build --wheel`, then `uvx --isolated --from <wheel> <cmd>`.
- Passing runs took about 1 s.

**Results on the final gate**

| Group | Cases | Correct | Examples |
|---|---|---|---|
| Healthy web controls (must PASS) | 4 | 4 | Normal app, canvas-only app, sparse white page, no favicon |
| Broken web apps (must FAIL) | 24 | 24 | Syntax error, fake build, no-op button, click-only exception, 404 asset, blank page, phone overflow, leaked key, `.env` left behind, weakened contract |
| Cheating agent (must FAIL) | 8 | 8 | Hollow test script, deleted or edited tests, hardcoded smoke, `console.error` overridden, `preventDefault` on errors, stub server, webdriver sniffing |
| Healthy non-web (must PASS) | 3 | 3 | Node CLI, Node library, Python wheel |
| Broken non-web (must FAIL) | 6 | 6 | `exports` file not packed, undeclared dependency, wrong output, wrong exit code, no golden tests, entry-point typo |

**Caveat on the numbers:** the mutants are mine, written knowing the gate, so 36 of 36 means the gate meets its specification, not that it catches everything. The script-editing mutants now stop at `locked-surface`, so in the final run the runtime paths for "start crashes", "server hangs" and "wrong port" were not reached. Those three were caught by `start-health` in the earlier gate version, and that code did not change.

**What running it taught me**

| Finding | Evidence | Fix |
|---|---|---|
| A "mostly one colour" blank check rejects legitimate sparse pages | Healthy app failed at 99.6% white, sampled at 64×64 | Sample at 480×300, fail only at ≥99.95%, and never require text, because canvas apps have none |
| Console lines for 404s cannot be filtered by URL as text | Missing-favicon control failed | Ignore `Failed to load resource` text; judge by the response event |
| `vite preview` hides real 404s | Missing asset passed the live-server check, caught only by the simulator | Keep the simulator; also fail on `naturalWidth === 0` |
| `pageerror` goes blind to `preventDefault()` in a page error handler | Cheat passed all browser checks | Capture-phase listener installed by init script, before any page script |
| `# tests N` is too weak | A run reported 1 test and 0 passing | Count `# pass N` |
| npm silently includes `bin` files | My "unpublishable CLI" mutant was inert and passed | Replaced with mutants that really fail after packing; a mutant that survives may be a bad mutant |

**Residual holes, confirmed PASS on the final gate**

| Case | Why it passes | What covers it |
|---|---|---|
| Feature requested but never built | The contract did not ask for it | Planner turns each acceptance criterion into a smoke step before building |
| Ugly or wrong-looking UI | No mechanical check for taste | Screenshots go to an independent reviewer model and to the human |
| Sniffs `Headless` in the user agent | Only `navigator.webdriver` is masked | Set a normal desktop UA. This is an arms race, so aim at lazy agents, not malicious ones |

Also out of reach: an error caught and swallowed by the app's own `try/catch` is invisible to any browser check.

**Add before shipping, not yet in the prototype**
- Fail on `.map` files in the publish payload.
- Turn the recorded list of external hosts into a check.
- Run install with scripts on only through an explicit allowlist. `--ignore-scripts` worked for Vite, esbuild and Rollup here, but packages such as native addons may need scripts.
- Make the simulator a per-target profile: `{base, caseSensitive, spaFallback}`.

### 3.3 The contract

The planner writes this **before** the builder starts. The orchestrator stores its hash outside the project, and the builder cannot change it.

```json
{
  "kind": "web",
  "static": true,
  "outDir": "dist",
  "start": "npm start",
  "test": "npm test --silent",
  "minTests": 1,
  "health": "/",
  "smoke": [
    {"fill": "#t", "value": "$NONCE"},
    {"click": "#add"},
    {"expectCount": "#l li", "n": 1},
    {"expectText": "$NONCE"}
  ],
  "locked": {
    "files": {"test/a.test.js": "<sha256>"},
    "scripts": {"build": "vite build", "start": "vite preview ...", "test": "node --test --test-reporter=tap"}
  }
}
```

`$NONCE` is generated at run time, per viewport, so an app cannot hardcode the answer. Non-web contracts use `kind: "cli" | "library"` and a `golden` list of `{run, stdout, exit}`.

## 4. GitHub account assumptions

The account details from the original read-only check are left out of this copy. The design assumes:

| Assumption | Why it matters |
|---|---|
| A free personal plan | Pages needs a public repo, and GitHub refuses branch protection on private repos with a 403 asking for an upgrade |
| A `gh` token with its default scopes | They leave out `workflow`, `delete_repo` and `user`. The plan cannot be read directly without `user` |
| The name `venezia-sites` is free on the account | The public output repo uses it |

I did not change the token, and I did not `POST /pages` on a private repo, because that is a mutation.

**Git credentials matter:** plain `git ls-remote` on a private repo fails (`could not read Username`), because the only helper is `osxkeychain` and nothing is stored there. The same command succeeds with:

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' <command>
```

The adapter must inject this. Do not run `gh auth setup-git`, because that writes the user's global git config and arms every process on the machine, including agents.

## 5. Publish targets

### 5.1 Which work today

| Target | Works with only today's `gh` auth? |
|---|---|
| Local preview, LAN preview, local tarball | Yes. Needs no auth |
| Private GitHub repo | Yes |
| GitHub Release on a repo | Yes |
| Gist (secret or public) | Yes, text files only |
| GitHub Pages via `gh-pages` branch | Yes, public repo only (per docs and scopes; not run) |
| GitHub Pages via Actions workflow | **Expected no.** Needs `gh auth refresh -s workflow` |
| Vercel, Cloudflare (permanent) | No. Needs an account and token |
| Vercel, Cloudflare (`--temporary`) | No GitHub auth or account needed, but expires in about an hour and accepts provider terms |

### 5.2 Reference

| Target | Exact commands | Prerequisites | Reverse | Cost |
|---|---|---|---|---|
| **Local preview** | `vite preview --host 127.0.0.1 --strictPort --port $PORT`, or a Node static server | None | Kill the process group | Free |
| **LAN preview** | Same, with `--host 0.0.0.0`; URL `http://<mac-name>.local:$PORT` | Same Wi-Fi | Kill it. Note it is open to the whole network | Free |
| **Tarball** | See 5.4 | None | Delete the file | Free |
| **Private repo** | `gh repo create <owner>/<name> --private --source . --push` | `repo` scope | `gh repo archive`. Deleting needs `delete_repo` | Free |
| **Release** | `gh release create v0.1.0 app.tgz --draft --notes-file NOTES.md`, then `gh release edit v0.1.0 --draft=false` | A repo | `gh release delete v0.1.0 --cleanup-tag` | Free |
| **Gist** | `gh gist create -d "desc" file1 file2` (add `--public` to list it) | `gist` scope | `gh gist delete <id>` | Free |
| **Pages, branch** | See 5.3 | **Public repo on Free** | Rollback commit. `DELETE /repos/o/r/pages` needs only `repo` | Free; 1 GB site, 100 GB/month soft, 10 builds/hour soft |
| **Pages, workflow** | Commit a workflow using `configure-pages@v5`, `upload-pages-artifact@v4`, `deploy-pages@v4` with `pages: write`, `id-token: write`; then `POST /pages` with `build_type: workflow` | Public repo, **`workflow` scope** | Re-run an older commit | Free on public repos |
| **Vercel, temporary** | `vercel deploy --temporary` | No credentials, unlinked folder, **not in CI** | Expires. No documented early delete | Free, 1 hour |
| **Vercel, permanent** | `vercel build`, then `vercel deploy --prebuilt --prod --yes --verify`; first time `vercel login` or `VERCEL_TOKEN` | Account, token | `vercel rollback <deployment>`, `vercel remove <id>`, `vercel project pause` | Hobby free, **non-commercial only**, 100 deployments/day |
| **Cloudflare Workers assets, temporary** | `wrangler deploy --temporary --assets dist --name <n> --compatibility-date 2026-11-04` | No credentials at all (existing ones cause an error) | Deleted after 60 min if unclaimed | Free; 1,000 files, 5 MiB each |
| **Cloudflare Workers assets, permanent** | `wrangler deploy --assets dist --name <n> --compatibility-date 2026-11-04` | `wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | `wrangler rollback <version>`, `wrangler delete <name>` | Free; static asset requests unlimited; Worker requests 100k/day; paid from $5/month |
| **Cloudflare Pages** | `wrangler pages deploy dist --project-name <n>` | Same; token permission Account > Cloudflare Pages > Edit | `wrangler pages deployment delete <id>`, `wrangler pages project delete <n>` | Free; 20,000 files, 25 MiB each |

Notes:
- **Cloudflare:** prefer Workers static assets. Cloudflare's best-practices guide steers new projects there, and investment is focused on Workers. I found no sunset date for Pages.
- **Vercel:** `--verify` loads the live URL and exits 1 on failure, but creates a protection-bypass secret when Deployment Protection is on. `stdout` is always the deployment URL, so it is safe to parse. Use `VERCEL_TOKEN` rather than `--token`, which would show in `ps`.
- **Temporary deploys:** claim URLs are bearer credentials. Never log them or show them on a shared screen. Cloudflare says Wrangler "accepts" its terms on continuing, so the user should agree once per provider. An agent should not accept on their behalf silently.
- **Gist:** secret gists are unlisted, not private. Anyone with the URL can read them. Gists hold text files in a flat list, are not a website host, and binary files are rejected before any network call, per the `gh` source.
- **CLI sizes:** Vercel and Wrangler together pulled 619 MB of `node_modules` (334 packages). Do not use `npx` each time. Install pinned versions into a Venezia tools folder the first time a provider is connected.

### 5.3 Recommended default: one public output repo

```
Private source repo:  <owner>/<app>            source, history, contract, tests
Public output repo:   <owner>/venezia-sites    gh-pages branch, built files only
                        .nojekyll
                        todo/   -> https://<owner>.github.io/venezia-sites/todo/
                        notes/  -> https://<owner>.github.io/venezia-sites/notes/
```

Why this shape:
- Source stays private on GitHub Free. Only built output is public.
- It needs no `workflow` scope. Docs confirm branch deploys with `.nojekyll` still run a deploy-only Action, with no workflow file of ours.
- It creates one public repo once, not one per idea. Without `delete_repo`, every per-app public repo would be permanent clutter.
- Rollback is per-app. **Rehearsed against a local bare repo:** two apps published, one rolled back with `git checkout <sha> -- todo`, the other untouched, history preserved.

One-time setup (a Tier 3 action, needs approval):

```sh
gh repo create <owner>/venezia-sites --public --disable-issues --disable-wiki
# push a gh-pages branch containing .nojekyll, then:
echo '{"build_type":"legacy","source":{"branch":"gh-pages","path":"/"}}' \
  | gh api -X POST repos/<owner>/venezia-sites/pages --input -
```

Each publish:

```sh
# replace <slug>/ with the gated build, commit, then:
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin gh-pages
gh api repos/<owner>/venezia-sites/pages/builds/latest --jq .status   # poll until "built"
```

Trade-offs to design around:
- **All apps share one origin**, so localStorage, IndexedDB, cookies and service workers collide across apps. Namespace storage by slug and restrict service-worker scope. An app that cannot do that goes to Cloudflare or Vercel, which give each app its own origin.
- **Rollback is not instant.** `pages.github.com` returned `cache-control: max-age=600`, so a pulled version can stay visible for up to 10 minutes.
- **The repo is public, so its history is too.** Rolling back removes a file from the site, not from git history, forks or caches. A leaked secret must be rotated, not just reverted. This is why the secret scan runs before the outward step.
- **Pages rules still apply:** GitHub prohibits using it as free hosting for an online business or commercial SaaS, or for collecting passwords or card numbers. Commercial ideas should default to a paid-capable target.
- **Build limit:** 10 builds/hour is a soft limit, so batch rapid republishes.
- **No SPA fallback:** deep links 404 on Pages. Either use hash routing or have the adapter copy `index.html` to `404.html`.

If an app needs a server, Pages cannot host it. Use Cloudflare or Vercel, which requires the user to connect an account.

### 5.4 Reproducible tarball

Verified: rebuilding from unchanged inputs gives an identical SHA-256, and the round trip extracts identically. Touching a file's mtime changes the hash, so normalize mtimes first.

```sh
find site -exec touch -t 202611040000 {} +
(cd site && find . -type f | LC_ALL=C sort \
  | COPYFILE_DISABLE=1 tar --no-mac-metadata --uid 0 --gid 0 -cf - -T -) | gzip -n > app.tgz
shasum -a 256 app.tgz
```

`COPYFILE_DISABLE`, `--no-mac-metadata` and `gzip -n` keep macOS metadata and timestamps out of the archive.

## 6. Dry runs

No provider offers a complete dry run on today's credentials. The layers below get close.

| Target | Dry-run method | Verified? |
|---|---|---|
| Local preview, tarball | Just run it; nothing leaves the machine | Yes |
| Pages | Host simulator with `/venezia-sites/<slug>/`, plus a push to a local bare repo | Yes. Caught absolute `base`, case mismatch and missing SPA fallback |
| Git push of any kind | `git push --dry-run` | Yes against a local bare repo; remote unchanged |
| Name availability | `gh api repos/o/<name>` returns 404 | Yes |
| GitHub API calls | No dry-run mode. Inject the `gh` path into the adapter and use a stub in tests | Design only |
| Gist | Local preflight: flat, text only, sizes; show exact file list | Design only |
| Release | Local tarball first. `--draft` is a useful rehearsal but is a remote write | Flag confirmed only |
| npm package | `npm pack --dry-run --json` lists exact contents and size | Yes |
| Cloudflare Workers | `wrangler deploy --dry-run --assets dist --name x --compatibility-date ... --outdir out` | **Yes, with no credentials** |
| Cloudflare Pages | **No flag exists** (`pages deploy --help` has no `dry-run`) | Yes |
| Vercel | `vercel deploy --dry --json` gives a full manifest with content hashes, but **fails with no credentials** ("No existing credentials found"). Changelog says it needs a linked project | Error confirmed; the success path was not run |

## 7. Adapter interface

```ts
type Tier = 0 | 1 | 2 | 3 | 4;

interface Target {
  id: string;                     // "gh-pages-branch", "cf-workers", ...
  tier(opts: PublishOpts): Tier;
  profile: HostProfile;           // { base, caseSensitive, spaFallback } for the simulator

  probe(): Promise<Probe>;                        // read-only: auth, scopes, quotas, name free
  plan(a: Artifact, o: PublishOpts): Promise<Plan>;     // pure: no writes
  dryRun(p: Plan): Promise<DryRunReport>;         // nothing remote changes
  apply(p: Plan, a: Approval): Promise<Receipt>;  // idempotent on plan.hash
  verify(r: Receipt): Promise<LiveReport>;        // browser checks at the live URL
  rollback(r: Receipt): Promise<Receipt>;
}

interface Plan {
  hash: string;              // sha256 of manifest + commands + target + visibility
  manifest: FileEntry[];     // every path, size, sha256 that will leave the machine
  commands: string[][];      // exact argv, shown to the human
  expectedUrl?: string;
  visibility: "local" | "private" | "unlisted" | "public";
  expiresAt?: string;
  cost: string;
  rollback: string;          // written before apply, or apply refuses
  evidenceHash: string;      // must match a PASS from the gate
}
```

Rules:
- `apply` refuses without a passing evidence file whose artifact hash equals the plan's.
- `apply` writes an intent to an append-only journal before acting, and the receipt after. A crash between the two is recoverable, because re-running with the same hash is a no-op.
- `Approval` is a signature over `plan.hash` with a short expiry, minted by the control plane. If a single byte changes, the approval is void.
- Providers are data plus a thin wrapper: add a target by implementing six methods.
- Pin provider CLI versions. The Vercel and Wrangler flags used here are recent and changing. `--temporary` is absent from `wrangler deploy --help` even though it exists in the code and docs.

## 8. Default safety gate

| Tier | Meaning | Examples | Default |
|---|---|---|---|
| 0 | Stays on this machine | Local preview, tarball | Automatic after gate PASS |
| 1 | Remote, private to the user | Private repo, draft release in it | Automatic after gate PASS and secret scan; notify |
| 2 | Reachable by URL, unlisted or expiring | Secret gist, `--temporary`, LAN preview | Approve once per target, then automatic. Show expiry |
| 3 | Public and durable | Pages, public gist, permanent Vercel or Cloudflare | One-tap approval per plan. Standing policy optional |
| 4 | Irreversible, costly or a change of identity | npm publish, custom domain, source repo going public, paid plan, any deletion, new token scope | Always explicit. Hold-to-confirm. Never a standing policy |

The user asked for publishing "on my behalf directly", so Tier 3 needs a fast path. Offer an opt-in standing policy scoped to one target, for example:

> Auto-publish to `venezia-sites` when the gate passes, the secret scan is clean, there are no new external hosts, no password or payment form is present, and the payload is under 50 MB.

Mechanical preflight before any Tier 2+ step, in order:
1. Gate PASS for this exact artifact hash.
2. Secret scan of the payload, and of history for repos.
3. No `.env*`, `.map`, or files outside the manifest.
4. Host simulator PASS with this target's profile.
5. Provider dry run where one exists.
6. Show the manifest diff against the last publish, expected URL, cost and rollback.

After publishing:
1. Run `verify` against the live URL, with the same browser checks and the nonce smoke.
2. On failure, roll back automatically. A rollback reduces exposure, so it needs no fresh approval.
3. Store URL, hash and receipt in the project's memory.

**Voice:** voice can *request* a publish, but should not alone *approve* Tier 3 or 4. A misheard "yes" should not put something on the public internet. Pair it with a tap, or a key on any future hardware panel.

**Keep the agent away from credentials.** The broker holds publish access; the builder should not.
- Verified: running a process with an empty `GH_CONFIG_DIR` makes `gh` report not logged in, and `git ls-remote` on the private repo also fails with an isolated git config.
- This is a tripwire, not a security boundary. An agent with shell access can still unset the variable and read `~/.config/gh`. Pair it with the Claude Code permission rules or sandbox from the agent-control track, and deny `gh`, `vercel`, `wrangler` and `git push` for builders.
- Do not add `workflow` or `delete_repo` scopes to the shared token by default. Each one widens what a mistake can do.

## 9. Decisions needed from the user

| Decision | Recommendation |
|---|---|
| Create public `<owner>/venezia-sites` on the first publish? | Yes. Tier 3, one-time |
| Grant `workflow` or `delete_repo` scope? | Not needed for the default path. Leave off |
| Connect Cloudflare and/or Vercel? | Later, when an app needs a server, its own origin, or commercial use. Cloudflare first: free static requests and no non-commercial clause in what I read |
| Enable the Tier 3 standing policy? | Off by default, offered after a few successful manual publishes |
| Use temporary deploys? | Yes, as a "share this for an hour" option, after one-time consent to each provider's terms |

A possible extra target: this harness offers a private-by-default Claude Artifact page, which could give a phone-viewable private preview with no GitHub exposure. I did not test it, and it is unknown whether it works from a headless `claude -p` run. Worth one experiment during the build.

## 10. Housekeeping notes

- My first `npm i playwright-core` used npm's default cache in `~/.npm`, which is outside the allowed write area. It added one package's cache entry and changed nothing else. All later installs used a cache in scratch, with `HOME` isolated for the Vercel and Wrangler runs.
- A safety check blocked one `rm -rf *` of a scratch folder. It was not retried. Fresh folders were used instead, and the stale scratch folder `fixtures/cli-unpublishable` remains.
- `gh`, `git ls-remote` and `curl` calls were all reads. `git ls-remote` touched one private repo for its `HEAD` only, and the SHA was masked in output.

## Sources

GitHub:
- [What is GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Creating a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site): Free requires public repo; sites are public even from private repos
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits): 1 GB, 10 minutes, 100 GB/month, 10 builds/hour, prohibited uses
- [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site): branch vs workflow, `.nojekyll`
- [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [REST API: Pages](https://docs.github.com/en/rest/pages/pages)
- [REST API: delete a repository](https://docs.github.com/en/rest/repos/repos#delete-a-repository): needs `delete_repo`
- [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps): `workflow`, `delete_repo`, `repo`
- [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)
- [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions): free on public repos; Free plan includes $12 of compute on private repos
- [Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility): going private unpublishes Pages on Free; forks stay public
- [Creating gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists): secret gists are not private
- [Securing Pages with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- [gh gist create source](https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/gist/create/create.go)

Workflow-scope failure, community reports only; I found no GitHub-authored page stating this error:
- [VS Code issue 97396](https://github.com/microsoft/vscode/issues/97396)
- [DEV Community write-up](https://dev.to/jessehouwing/can-t-push-to-github-refusing-to-allow-an-oauth-app-to-create-or-update-workflow-without-workflow-scope-1imc)

Vercel:
- [CLI: deploy](https://vercel.com/docs/cli/deploy)
- [Dry-run deployments changelog](https://vercel.com/changelog/dry-run-deployments-with-vercel-cli)
- [Deploy without an account changelog](https://vercel.com/changelog/deploy-without-an-account-using-vercel-cli)
- [Deploying without logging in](https://vercel.com/docs/deployments/deploy-without-logging-in)
- [Claim deployments](https://vercel.com/docs/deployments/claim-deployments)
- [Hobby plan](https://vercel.com/docs/plans/hobby)

Cloudflare:
- [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Direct Upload with CI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Claim deployments / temporary accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/)
- [Temporary accounts changelog](https://developers.cloudflare.com/changelog/post/2026-06-19-temporary-accounts-for-agents/)

Playwright:
- [Browsers](https://playwright.dev/docs/browsers): channels, headless shell vs new headless
