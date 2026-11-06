# Venezia: design direction

Decided by bake-off between three running prototypes in `docs/prototypes/world/`. This file is binding for `web/`.

## The decision

| From | Taken |
|---|---|
| **A, the Engraving** (the winner) | The whole world: engraved hatch-line water that parts around hulls, gold and verdigris line work on lagoon ink, light drawn by hatch density, the wind head, moon, parchment ribbons for hull names, the vellum folio side panel on desktop, the chronicle voice, the ceremony banner and rings |
| **C, the Diorama** | The deck as a dark machined object with lit keycaps, the "VERIFIED" stamp on cards, label plus status in hull flags, the deck ticker line |
| **B, the Mosaic** | Lamps as thick glass tiles with internal light, the mosaic wall of tesserae, the "gold only where proven" reveal, keeping a failed tile dark and honest |

## The rule that overrides the prototype

**Gold means verified, and nothing else.** Prototype A's brass deck breaks this, so the deck is not brass. The body is blackened iron with fine engraved line work in verdigris and vellum. In the whole interface, gold appears on: tesserae, gilded hulls, receipts, the ring during a real publish, and Renown. If an element has not been earned, it must not be gold. A hull that loses its receipt visibly loses its gold.

Other colour meaning: vermilion for danger and failure, verdigris for action and working water, vellum for what you read, amber for "needs you". Blue, green, white, amber and red on the lamps are the status colours and appear on the lamps only.

## Principles

1. **World first, not a dashboard.** The first screen is a place. Every number sits somewhere physical.
2. **One decision at a time.** The card is the only thing asking for you. Everything else can be ignored safely.
3. **Plain English in cards.** Fiction in the world, plain words when you must choose.
4. **Every state is drawn.** Fog is open questions, smoke is repair, gold is proof, weather is your rate limit. If a state is not drawn, it does not exist.
5. **The thumb owns the bottom third.** Reach matters more than symmetry on a phone.
6. **Touch, sound and light together.** iOS has no vibration, so nothing may depend on haptics alone.
7. **Same commands everywhere.** The UI only calls `POST /api/command`.
8. **Quiet when calm.** It rests when nothing needs you. No idle chatter or attention-seeking motion.

## First-run moment

An empty lagoon at night. The lion's mouth, the Bocca, is the only lit thing. "Speak an idea into the mouth." Tap or hold to talk, or type. Three starter ideas sit below as ribbons, so a new person is never stuck. When the idea goes in, a hull slides out and the water parts. This is the most important 20 seconds in the product.

## Layouts

- **Phone, 360 to 480 wide, portrait:** HUD, world, card, deck. Deck is always reachable. Details rise as a vellum sheet above the deck.
- **Tablet and laptop:** world fills, deck docks bottom-left of world, vellum folio on the right, as in the wide prototype shot.
- **Ultrawide:** world grows, folio stays at reading width, the mosaic gets its own column.
- **Phone landscape:** deck on the right edge in a column. The prototype is crowded here, so this needs its own work.
- **`/deck`:** deck only, full screen, for a phone sitting beside a big screen.

## Accessibility

Canvas is decoration over a real structure. Every hull and station also exists in a visually hidden list in DOM order, and a polite live region announces state changes. Lamp status uses shape and colour together. Full keyboard path, visible focus, `prefers-reduced-motion`, and text contrast of 4.5:1 or better on all readable text. "Plain" switches the fiction words off everywhere.

## Performance

Target 60 fps on a phone, and a power budget: when nothing changes and the page is not focused, drop to a few frames per second. Pause all rendering when hidden. No more than one WebGL context.
