# Prototypes

Throwaway experiments that informed `docs/SPEC.md` and `docs/DESIGN.md`. They are kept for reference and are not used at runtime.

| Folder | What it is |
|---|---|
| `spike/` | Harness for the Claude Code protocol tests in research 03. `env.sh` needs `SCRATCH` set to a scratch folder |
| `gate/` | The first evidence gate and its mutation runner and results, from research 05 |
| `voice/` | Speech recognition tests for macOS, from research 04 |
| `world/` | Three visual directions for the world: engraving, tessera and diorama |

Screenshots: about 130 PNG files made these folders 214 MB, most of it iterations of the tessera direction. They are ignored by git, except one small shot for each world.

## Third-party code and fonts

Nothing third-party is copied into these folders. The world prototypes load the following from the network when opened:

| Item | Used by | Licence | Loaded from |
|---|---|---|---|
| three.js 0.160.0 | `world/c-diorama` | MIT | jsDelivr |
| Cardo | all three worlds | SIL OFL 1.1 | Google Fonts |
| DM Mono | `world/a-engraving` | SIL OFL 1.1 | Google Fonts |
| B612 Mono | `world/b-tessera` | SIL OFL 1.1 | Google Fonts |
| IBM Plex Mono | `world/c-diorama` | SIL OFL 1.1 | Google Fonts |

`gate/gate.mjs` imports `playwright-core`. Fonts in the real app are vendored, and their licences are in `web/fonts/`.
