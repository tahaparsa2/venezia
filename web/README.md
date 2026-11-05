# web/: the Venezia front end

Vanilla ES modules, no build step, no framework, and nothing from a CDN. Binding rules are in
`docs/DESIGN.md`. Served by `./vz serve`, with `/shared/*` from `shared/`.

```
node test/ui/serve.mjs            static server for UI work, prints the URL
http://127.0.0.1:4173/?demo=1     the sim in this tab, no server needed
node test/ui/shell.mjs            every layout, geometry checks, screenshots in data/shots/
node test/ui/tour.mjs             every state at every width, audited, in data/shots/tour/
node test/ui/tour.mjs --server    the same walk against ./vz serve --sim
```

`data/shots/tour/index.html` lists every scene with the query that reaches it, so any shot can be
walked to by hand. The audit fails on a console error, a request leaving the machine, sideways
scroll, clipped text, a control out of reach, a small tap target, low contrast, and an answer to a
decision that is off screen or covered. `tour.mjs storm --sizes=390,1440` retakes only those.

Demo query: `speed=10`, `seed=2`, `autopilot=1`, `ambient=0`, `ff=60000` (story ms to skip),
`fresh=1` (empty lagoon for the first-run moment, only ships you create appear), `nosw=1`,
`hour=12` (the time of day in the world, 0 to 24), `voice=scripted`.

## Surfaces

Each surface is one module with one export. Own your folder and your stylesheet, nothing else.
The stubs already there show the contract working. Replace them.

| Export | File | Stylesheet | Mounted on | Slot |
|---|---|---|---|---|
| `mountWorld(el, store)` | `js/world/index.js` | `css/world.css` | `/` | `#slot-world` |
| `mountDeck(el, store)` | `js/deck/index.js` | `css/deck.css` | `/`, `/deck` | `#slot-deck` |
| `mountCards(el, store)` | `js/cards/index.js` | `css/cards.css` | `/`, `/deck` | `#slot-cards` |
| `mountFolio(el, store)` | `js/folio/index.js` | `css/folio.css` | `/` | `#slot-folio` |
| `mountIntake(el, store)` | `js/intake/index.js` | `css/intake.css` | `/` | `#slot-intake` |

- A mount returns `{destroy}`, or a promise of it. `destroy` removes everything it added.
- A surface that throws gets a quiet note in its slot, and the others keep running.
- Style what is inside your slot, never the slot itself. Position is `css/base.css`.
- Colours, type, space, z-order and motion come from `css/tokens.css`. Do not invent any.
  `--gold-*` is earned only. `--lamp-*` appears on lamps only.
- Add new files to `SHELL` in `sw.js` only if the app cannot open without them. Others are
  cached the first time they load.
- Use absolute paths (`/js/...`, `/shared/...`): the app also lives at `/ships/:id`.
- `#slot-world` already holds `#demo-mark`. Append to the slot, do not clear it.

## store

```js
store.getState()              // state at the cursor: live, or the past while seeking
store.getLiveState()          // always now
store.subscribe((state, events, meta) => {})   // returns unsubscribe, see below
store.send(command)           // Promise<{ok, id?, error?}>. Never throws
store.seek(seq)               // Promise<state>. null returns to now
store.timeline()              // {first, last, at, live}, for a scrubber
store.selectedShip()          // selected ship, or whichever most wants attention

store.view.get()              // {selectedShip, panel, plain, sound}
store.view.set({panel: 'ship'})
store.view.subscribe((value, previous) => {})

store.connection.get()        // {state, via, attempt, retryAt, lostAt, hydrated, stale}
store.connection.subscribe(fn)
store.retry()

store.layout.get()            // see Layouts
store.layout.subscribe(fn)

store.actions.on((action) => {})    // keyboard intent, see Input
store.actions.emit(action)
store.announce(text, {urgent})      // screen reader
store.applyTerms(root)              // re-word [data-term] in a fresh subtree
store.notify(text, {title})         // a short message on the top ribbon
store.demo                          // the sim in demo mode, else null. evidence(), previewHtml()
```

`subscribe` runs at most once a frame. `events` holds what is new, and is empty on a seek.
`meta.reason` is `'event'`, `'seek'` or `'snapshot'`. `meta.seeking` means the past is on screen.
`meta.replay` means these are old events being caught up on: **do not ring a bell or start a
ceremony on a replay or a seek.** A world loop can skip `subscribe` and call `getState()` each
frame: it is cheap, and states are immutable, so `===` tells you whether anything changed.

Build commands with `cmd` from `/js/commands.js`, for instance `store.send(cmd.steer(id, 'now', text))`.
They are checked against `shared/commands.mjs` before leaving the page, and a double tap sends
once. While seeking only `ship.rewind` is accepted, since a scrub can only act by rewinding.
A failed send never queues: silence must not approve anything later.

`connection.hydrated` is false until a first state is held, so first-run must wait for it, or a
slow link shows a real factory as an empty lagoon. `stale` means the state on screen is a saved
copy. `state` is `connecting`, `live`, `offline` or `unpaired`. The shell draws the offline
ribbon and fogs the world, and `html[data-link]` is there if a surface wants more.

Words: `word(store, id)` from `/js/a11y.js` honours plain mode. `<span data-term="bocca"></span>`
updates itself, and `html[data-plain]` is set for CSS.

`html[data-sensa]` is set by the world while a public publish has the water. The cards hold the
next decision until it clears, for 14 seconds at most: waiting approves nothing.

`view.panel` is `null`, or a string the folio owns (`'ship'`, `'chronicle'`, `'mosaic'`,
`'lessons'`, `'fair'`). On a phone, a value raises the sheet and `null` closes it, so to open
details on tap: `store.view.set({selectedShip: id, panel: 'ship'})`. In the column layouts it only
picks what the folio shows. Escape clears it.

## Layouts

`html[data-layout]` and `store.layout.get()` carry the same `mode`. Thresholds are in `base.css`.

| mode | when | deck | folio | also |
|---|---|---|---|---|
| `phone` | under 700 wide | under the world | vellum sheet above the deck | |
| `landscape` | under 520 tall, landscape | right column, full height | sheet over the world | |
| `desk` | 700 and up | floats bottom-left of the world, up to 860 wide | right column, 300 to 372 | |
| `ultrawide` | 1800 and up | same | right column, 400 | `#slot-mosaic` column |
| `deckonly` | `/deck` | fills the screen | none | |

The deck slot is a size container named `deck`, and cards, folio and mosaic likewise. Lay the deck
out with `@container deck (min-width: ...)`, not media queries: at 768 wide the deck is 428 wide and
needs its phone form. Measured values, as CSS variables: `--deck-h`, `--card-h`, `--vv-h` (height
above the soft keyboard).

`layout.worldInsets` is how much of the world the shell covers. Keep hulls out of it, as the
prototype's `usable` did. `layout.mosaicSlot` is `#slot-mosaic` on ultrawide, otherwise `null`: the
folio renders the mosaic there when it is set, and inline when not.

## Input

`a11y.js` maps SPEC 12's keys, skips text fields, and leaves Space to a focused button. A gamepad
should emit the same actions. Surfaces only listen.

| Key | Action |
|---|---|
| `1`..`6` | `{type:'lamp', slot}`. The shell also selects that lamp's ship |
| `Y` / `N` | `{type:'approve'}` / `{type:'reject'}` |
| `Space` | `{type:'talk', phase:'down'}` then `'up'`. `up` also fires when the window loses focus |
| `S` | `{type:'steer'}` |
| `[` / `]` | `{type:'dial', delta:-1}` / `{type:'dial', delta:1}` |
| arrows | `{type:'wind', wind:'n'}`, or `'ne'` and so on for two held together |
| `Esc` | clears `view.panel`, otherwise `{type:'escape'}` |

## Accessibility

`#structure` is a hidden list of every hull and station in DOM order, with buttons that select the
ship, kept current by `a11y.js`, and a polite live region announces changes. So canvas needs no
labels of its own: mark it `aria-hidden="true"`. Everything a surface draws in DOM still needs a
real name, visible focus, 4.5:1 text and a `prefers-reduced-motion` path.

## Fonts and icons

Fonts: `fonts/README.md`, Cardo and DM Mono, OFL. Icons are generated by
`node web/icons/make-icons.mjs`. `icons/lion-mask.svg` is the same engraved mask with no background,
free for the Bocca.
