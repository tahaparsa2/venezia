# Fonts

Vendored so nothing loads from a CDN at runtime. Both families are under the SIL Open Font
License 1.1. The full text and copyright lines are in `OFL-Cardo.txt` and `OFL-DM-Mono.txt`,
which must stay next to the fonts.

| Family | Author | Files | Source |
|---|---|---|---|
| Cardo 400, 400 italic, 700 | David J. Perry | `cardo-*.woff2` | `@fontsource/cardo` 5.3.0 |
| DM Mono 400, 500 | The DM Mono Project Authors | `dm-mono-*.woff2` | `@fontsource/dm-mono` 5.3.0 |

The woff2 files are unmodified `latin` and `latin-ext` subsets from Fontsource. `@font-face`
rules live in `web/css/tokens.css`, with the same `unicode-range` split, so `latin-ext` is
only fetched for text that needs it.
