# Venezia

An agentic factory for one person: idea in, contract, build, proof, launch, lessons. The spec is `docs/SPEC.md` and it is binding. Research is in `docs/research/`, and working prototypes are in `docs/prototypes/`.

## Conventions

- Node 25 ES modules (`.mjs`), no build step, no TypeScript, no front-end framework. JSDoc where a shape is not obvious.
- Runtime deps are limited to `ws`, `playwright-core`, `qrcode-generator`.
- `shared/` runs in both Node and the browser, so it has no Node imports.
- State only changes through events in `engine/store.mjs`. Every surface sends the same commands from `shared/commands.mjs`.
- No model decides "done". The host decides from mechanical evidence.
- Plain English in anything the user must act on. Fiction lives in the world, not in decisions.
- Follow the history accuracy table in `docs/research/04-surfaces.md` section 8.
- Tests: `npm test`, on the fake Claude fixture. Real Claude runs need `VENEZIA_E2E=1`.
- Stay in this folder. Never put yards under `/tmp`.

## Git

- `main` stays green. Do all work on a branch.
- Run `npm test` on the branch before merging, and merge only when it passes.
- Keep commits small and say why.
- Nothing is pushed, and no remote is created, unless the owner says so.
- Commit under the GitHub noreply address, never a personal email. It is set per clone, so check `git config user.email` first.
- Never commit anything `.gitignore` covers: `data/`, `yards/`, generated `portolano/` files, secrets, certificates. Never use `git add -f` to get round it.
- No real paths or account details in docs or fixtures. Spend figures for real runs are welcome in the README. `docs/PUBLISHING.md` has the rules and the pre-publish checklist.
