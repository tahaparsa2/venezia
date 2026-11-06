# Publishing Venezia

The checklist for making this repository public. Git history is permanent, so finish it before the first public push. Nothing here has been pushed, and no remote exists yet.

## Needed before publication

1. **Choose a licence.** This is the owner's decision and it is still open. There is no `LICENSE` file and no `license` field in `package.json`. Without a licence the code is all rights reserved, so others may read it but have no right to use, copy or change it. Once chosen, add `LICENSE`, set `license` in `package.json`, and replace the Licence section of `README.md`.
2. **Decide the licence for `docs/research/`.** `01-3dmk.md` draws on CC BY 4.0 material, and its credit must stay whatever the code licence is.
3. **Ask Anthropic whether the subscription route is allowed.** This is the owner's job and it is still open. The Consumer Terms bar access by script unless it is through an API key or Anthropic permits it, and the Claude Code terms say plan limits assume ordinary, individual use. Signing in to the unmodified `claude` with your own subscription is allowed, but neither says whether unattended factory runs fit. The Claude Code terms send such questions to [Anthropic sales](https://www.anthropic.com/contact-sales). `README.md` gives the terms and the Console route in the meantime.
4. **Turn on private vulnerability reporting** in the repository settings. `SECURITY.md` sends reporters there, and there is no other contact address.
5. **Use your GitHub noreply address in every commit.** The setting belongs to one clone, so run `git config user.email '<id>+<username>@users.noreply.github.com'` before a clone's first commit. `gh api user --jq .id` prints the id. In GitHub's email settings, turn on **Keep my email addresses private** and **Block command line pushes that expose my email**. A commit with the wrong address must be rewritten before the first push.
6. **Run the checks below** on the first commit, before any push.

## Undecided

| Item | Options and notes |
|---|---|
| Repository name and owner | Check that the name is free, and search for clashes with other projects called Venezia |
| `"private": true` in `package.json` | It only stops `npm publish`. Keep it unless the package goes on npm |
| Include `docs/research/` | It is useful context, but it is working notes with dated third-party facts. It could be published or moved out |
| Include `docs/prototypes/` | Source plus three small screenshots, 2.5 MB. See its README for third-party notes |
| README screenshots | No image is linked yet. Four small shots in `docs/shots/` are tracked. The two large desktop shots (7.6 MB) are ignored, so compress one first if the README should show the desktop view |
| Hardware notes | The docs mention an 8 GB MacBook as the test machine. They were kept because they explain design limits |
| Branch protection | Available on `main` once the repository is public |
| Gloria | If it is published first, update the "Nothing has been published" line in `README.md` and in `CHANGELOG.md` |

## CI is deferred

There is no `.github/workflows` file. Pushing one needs a token with the `workflow` scope, and adding that scope is the owner's choice. `docs/research/05-test-and-publish.md` advises against widening a token by default. Until then, run `npm test` before every merge. When CI is added, note that the tests need macOS for the jail and sandbox.

## Checks on the first commit

Run these in the repository, before any push:

```sh
git status --short                    # nothing unexpected
git config user.email                 # ends in @users.noreply.github.com
git log --all --format='%ae%n%ce' | sort -u | grep -v '@users\.noreply\.github\.com$'         # prints nothing
git check-ignore data yards portolano/ATLAS.md .env docs/shots/3-desktop-gate-failed-proof.png x.db x.sqlite x.jsonl x.har id_rsa .mcp.json
git ls-files | grep -E '^(data|yards)/|\.(pem|key|p12|crt|db|sqlite3?|jsonl|har)$|(^|/)(id_rsa|\.mcp\.json)$|portolano/(ATLAS|lessons/l-)'   # prints nothing
git ls-files -z | xargs -0 du -ch | tail -1                                                  # well under 30 MB
git grep -nIiE '/Users/[a-z]{2,}/|claude-[0-9]+/|<your name>|<your username>|<your email>|<your LAN address>'   # prints nothing
npm test
```

Replace the placeholders in the `git grep` line with your real name, GitHub username, personal email and LAN address (`ipconfig getifaddr en0`). `/Users/x` in the tests is a fake path, and the pattern skips it. Also run a secret scanner over the history if one is to hand.

## Rules for later commits

- `portolano/mariegola.md` is tracked as an empty template, so a promoted rule appears as a local change. Do not commit it.
- Do not add real paths, account details, LAN addresses, or session or message IDs to docs or fixtures. Use `$SCRATCH`, `~/project`, `<owner>`, `/Users/x` and made-up private addresses such as `10.20.30.40`. Tests cannot use the `192.0.2.0/24` documentation range, because the local CA only signs private addresses.
- Keep third-party quotes short and attributed, and keep the 3DMK credit in `README.md` and `docs/research/01-3dmk.md`.
