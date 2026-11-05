// The world's inks. Colours belong to css/tokens.css, so the canvases read them from there and
// the shader gets them as constants. Gold is kept apart on purpose: nothing in the city, sky or
// water may reach for it, and only earned things (a gilded hull, a real publish) can.

const read = (style, name) => style.getPropertyValue(name).trim();

/** `#RRGGBB` with no alpha. A gradient fades to this, so it never greys on the way out. */
const clear = (hex) => `${hex}00`;

export function readInks(root = document.documentElement) {
  const style = getComputedStyle(root);
  const token = (name) => read(style, `--${name}`);
  return {
    serif: token('serif'),
    ink: token('ink'),
    lagoon: token('lagoon'),
    deep: token('lagoon-deep'),
    lift: token('lagoon-lift'),
    /** Line work of the city: copperplate in vellum and verdigris, never gold. */
    line: token('vellum-edge'),
    vellum: token('vellum'),
    vellumClear: clear(token('vellum')),
    pale: token('vellum-shade'),
    warm: token('vellum-warm'),
    verdigris: token('verdigris'),
    verdigrisLight: token('verdigris-light'),
    verdigrisDeep: token('verdigris-deep'),
    vermilion: token('vermilion'),
    vermilionGlow: token('vermilion-glow'),
    amber: token('amber'),
    gold: token('gold'),
    goldLight: token('gold-light'),
    goldPale: token('gold-pale'),
    goldDeep: token('gold-deep'),
    goldWire: token('gold-wire'),
  };
}

/** `#RRGGBB` as a GLSL vec3 literal. */
export function vec3(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const part = (shift) => (((n >> shift) & 255) / 255).toFixed(3);
  return `vec3(${part(16)},${part(8)},${part(0)})`;
}
