# Changelog

Notable changes to Venezia. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-11-05

The first version, not yet published.

### Added

- The factory line, from idea through contract, build, gate, independent review, repair, receipt and lessons, with state kept only as events.
- The gate: locked tests, a secret scan, and real Chrome checks at phone and desktop sizes, with mechanical evidence. No model decides "done".
- Worker control over the `claude` stream-json protocol, with sandboxing, a jail for yard code, budgets and a rate limit guard.
- The web surface: the lagoon world, deck, cards, folio and intake, plus voice typing on macOS 26.
- The `vz` command line, an MCP surface, and a simulator with `npm run sim` that spends nothing.
- LAN access over HTTPS, with a local certificate authority and phone pairing.
- Publishing through a broker: local, tarball, private repo, secret gist and GitHub Pages. Public targets need a held approval.
- Local prototypes kept for as long as a project's receipt holds.
- Memory in `portolano/`: lessons, the Atlas and the Mariegola rulebook.
- Preparation for publication: `.gitignore` for local state, secrets and large output, `SECURITY.md`, `docs/PUBLISHING.md`, and personal data removed from docs and tests.

### Known limits

- Two small projects have run on real Claude from start to finish. Larger ones have not.
- Nothing has been published to the internet from a real run.
- Pairing has not been tried on a physical phone.
- See `docs/ROADMAP.md` for the rest.
