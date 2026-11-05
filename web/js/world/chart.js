// The geography. Three compositions of one city, all shaped by the same rule: the street starts
// at the lion's mouth, and runs 1 to 6 without crossing itself. Coordinates are design units,
// mapped onto whatever the shell leaves free. Each `st` is a point on the street in spline units.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = (a, b, t) => a + (b - a) * t;
export { clamp, lerp };

export const STATION_IDS = Object.freeze(['bocca', 'disegno', 'cantiere', 'collaudo', 'varo', 'portolano']);

/* A phone, a narrow column: a reversed S on three rows, ending in the open basin. */
const TALL = {
  name: 'tall', w: 390, h: 470, k: 1, horizon: 106, canal: 42, sTop: 0.74, sBot: 0.92, cut: 11.5,
  street: [[316, 160], [290, 165], [240, 170], [150, 166], [84, 178], [42, 222], [80, 266], [150, 282], [228, 286], [298, 282], [352, 298], [374, 342], [334, 388], [234, 406], [160, 412], [104, 418], [70, 420]],
  st: [1.2, 3, 6.8, 8.6, 12.4, 14.2],
  north: [[-10, 128], [40, 122], [92, 130], [150, 120], [210, 128], [262, 118], [320, 126], [400, 118]],
  south: [[400, 362], [352, 364], [300, 382], [246, 384], [190, 378], [130, 388], [70, 380], [24, 390], [-10, 386]],
  rii: [[[252, 170], [264, 118]], [[118, 166], [108, 118]], [[202, 284], [188, 224], [214, 168]], [[120, 278], [138, 330], [116, 390]], [[262, 286], [272, 336], [262, 388]]],
  porto: [132, 386], lion: [352, 140, 74],
  moon: [244, 72, 15], wind: [26, 92], rose: [322, 508, 40],
  basin: [20, 444, 372, 470],
  plaques: [[304, 199], [150, 199], [128, 314], [272, 316], [318, 428], [70, 382]],
};

/* A laptop or wider: the same S with room around it. */
const WIDE = {
  name: 'wide', w: 1080, h: 742, k: 1.34, horizon: 158, canal: 62, sTop: 0.72, sBot: 0.96, cut: 13.5,
  street: [[924, 234], [880, 240], [800, 246], [640, 238], [440, 232], [250, 258], [188, 330], [262, 396], [440, 408], [600, 412], [772, 404], [932, 418], [1016, 486], [960, 566], [800, 606], [620, 622], [420, 640], [300, 652]],
  st: [1, 3, 8, 10, 14.6, 16.2],
  north: [[-20, 196], [90, 184], [220, 196], [380, 182], [520, 192], [700, 178], [860, 190], [1000, 176], [1110, 186]],
  south: [[1110, 530], [1010, 540], [920, 566], [800, 570], [640, 576], [480, 566], [320, 584], [160, 572], [-20, 590]],
  rii: [[[700, 242], [716, 178]], [[330, 238], [320, 184]], [[520, 410], [506, 322], [540, 238]], [[350, 402], [366, 490], [340, 582]], [[690, 408], [712, 490], [690, 572]], [[860, 410], [872, 480], [850, 566]], [[900, 240], [908, 320], [870, 410]], [[130, 322], [60, 400], [90, 576]]],
  porto: [360, 586], lion: [1000, 214, 104],
  moon: [790, 92, 26], wind: [86, 124], rose: [1021, 917, 46],
  basin: [300, 702, 1050, 742],
  plaques: [[842, 290], [640, 290], [436, 462], [772, 460], [650, 668], [372, 674]],
};

/* Phone on its side: too short for three rows, so one hairpin, and the basin along the foot. */
const LOW = {
  name: 'low', w: 560, h: 390, k: 0.82, horizon: 66, canal: 34, sTop: 0.66, sBot: 0.86, cut: 7.6,
  street: [[462, 118], [430, 122], [340, 128], [240, 124], [150, 126], [70, 138], [34, 178], [66, 224], [150, 244], [260, 250], [360, 252], [450, 252], [520, 254]],
  st: [1, 3, 7.5, 8.9, 10, 11.2],
  north: [[-10, 86], [60, 80], [150, 88], [260, 78], [370, 86], [480, 78], [570, 84]],
  south: [[570, 208], [470, 212], [370, 206], [270, 214], [170, 208], [90, 216], [-10, 212]],
  rii: [[[300, 128], [314, 80]], [[120, 126], [110, 84]], [[210, 124], [196, 208]], [[350, 128], [360, 208]]],
  porto: [456, 210], lion: [510, 116, 64],
  moon: [300, 40, 12], wind: [34, 50], rose: [530, 420, 34],
  basin: [60, 318, 546, 390], tag: 470,
  plaques: [[430, 160], [240, 160], [96, 296], [236, 296], [362, 296], [486, 296]],
};

/** A hull rests this far past its stop, in hull units, so the stop's numeral stays in sight. */
const REST_AHEAD = 64;

function pick(width, usable) {
  const aspect = width / usable;
  if (aspect < 1.02) return TALL;
  return usable < 430 ? LOW : WIDE;
}

/**
 * Fit a composition to the free part of the world.
 * @param {number} W world width
 * @param {number} H world height
 * @param {number} usable the height the city may use, the rest is open water under the shell
 */
export function makeChart(W, H, usable) {
  const P = pick(W, usable);
  const sx = W / P.w;
  const sy = usable / P.h;
  /* The sky keeps its height so the HUD and weather never collide; only the city compresses. */
  const skyH = P.horizon * Math.min(1, Math.max(sy, P === TALL ? 1 : 0.62));
  const sy2 = (usable - skyH) / (P.h - P.horizon);
  const my = (y) => (y <= P.horizon ? (y * skyH) / P.horizon : skyH + (y - P.horizon) * sy2);
  const m = (point) => [point[0] * sx, my(point[1])];
  const round = Math.min(sx, 1.25);

  const L = {
    W, H, P, usable, sx, sy, name: P.name, wide: P === WIDE,
    k: P.k * Math.min(sx, 1.5) * Math.min(1, Math.max(0.8, sy + 0.1)),
    horizon: skyH,
    canal: P.canal * Math.min(sx, 1.15) * Math.min(1, sy + 0.1),
    street: P.street.map(m), north: P.north.map(m), south: P.south.map(m),
    rii: P.rii.map((rio) => rio.map(m)),
    porto: m(P.porto),
    moon: [P.moon[0] * sx, my(P.moon[1]), P.moon[2] * Math.min(sx, 1.2)],
    wind: m(P.wind),
    rose: [P.rose[0] * sx, my(P.rose[1]), P.rose[2] * round],
    lion: { x: P.lion[0] * sx, y: my(P.lion[1]), d: P.lion[2] * Math.min(1.3, Math.max(0.9, Math.min(sx, sy + 0.1))) },
    basin: { x0: P.basin[0] * sx, y0: my(P.basin[1]), x1: P.basin[2] * sx, y1: my(P.basin[3]) },
    tagRight: (P.tag ?? P.basin[2]) * sx,
    plaques: P.plaques.map(m),
    /** On the first night the lion stands alone in the middle of the lagoon. */
    night: { x: W / 2, y: skyH + (usable - skyH) * (P === WIDE ? 0.24 : 0.2), d: Math.min(W * 0.56, usable * 0.4, 320) },
  };

  const topY = Math.min(...L.street.map((p) => p[1]));
  const botY = Math.max(...L.street.map((p) => p[1]));
  L.scale = (y) => lerp(P.sTop, P.sBot, clamp((y - topY) / (botY - topY), 0, 1.25)) * L.k;

  const last = L.street.length - 1;
  const spline = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const slope = (a, b, c, d, t) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t);
  /** The point at spline position `u`, with its heading in `a`. */
  L.at = (u) => {
    const s = L.street;
    const v = clamp(u, 0, last - 0.0001);
    const i = Math.floor(v);
    const f = v - i;
    const p0 = s[Math.max(0, i - 1)];
    const p1 = s[i];
    const p2 = s[i + 1];
    const p3 = s[Math.min(last, i + 2)];
    return {
      x: spline(p0[0], p1[0], p2[0], p3[0], f),
      y: spline(p0[1], p1[1], p2[1], p3[1], f),
      a: Math.atan2(slope(p0[1], p1[1], p2[1], p3[1], f), slope(p0[0], p1[0], p2[0], p3[0], f)),
    };
  };

  /* Arc length, so spacing along the street means the same on a bend as on a straight. */
  const STEP = 0.05;
  const arc = [0];
  for (let u = STEP, previous = L.at(0); u <= last + 1e-6; u += STEP) {
    const point = L.at(u);
    arc.push(arc[arc.length - 1] + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  L.length = arc[arc.length - 1];
  L.sOf = (u) => {
    const position = clamp(u, 0, last) / STEP;
    const i = Math.min(arc.length - 2, Math.floor(position));
    return lerp(arc[i], arc[i + 1], position - i);
  };
  L.uOf = (s) => {
    const distance = clamp(s, 0, L.length);
    let low = 0;
    let high = arc.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (arc[mid] <= distance) low = mid;
      else high = mid;
    }
    const span = arc[high] - arc[low] || 1;
    return (low + (distance - arc[low]) / span) * STEP;
  };
  L.point = (s) => L.at(L.uOf(s));

  L.stations = STATION_IDS.map((id, index) => {
    const u = P.st[index];
    const point = L.at(u);
    const scale = L.scale(point.y);
    const s = L.sOf(u);
    const normalSign = Math.cos(point.a) >= 0 ? -1 : 1;
    const nx = -Math.sin(point.a) * normalSign;
    const ny = Math.cos(point.a) * normalSign;
    const bank = L.canal / 2 + 1;
    return { id, index, u, s, point, scale, rest: s + REST_AHEAD * scale, bank: { x: point.x + nx * bank, y: point.y + ny * bank } };
  });
  /** The arc-length position for a place along the street, in stations. */
  L.restOf = (along) => {
    const i = clamp(Math.floor(along), 0, L.stations.length - 1);
    const here = L.stations[i].rest;
    const there = i + 1 < L.stations.length ? L.stations[i + 1].rest : Math.min(L.length, here + 60 * L.k);
    return Math.min(L.length, lerp(here, there, along - i));
  };
  return L;
}

/** Where a moon this high and this far across stands in the sky. */
export function moonPosition(L, moon) {
  const low = L.horizon - 2;
  // Its course keeps to the free sky, clear of the Treasury and under the title.
  // The HUD's tiles grow down from the middle, so the sky's clear zone is under them and to one side.
  const high = Math.max(L.moon[2] * 1.5, L.horizon * 0.34, L.wide ? 100 : 104);
  const from = L.wide ? 0.62 : 0.66;
  const x = (from + (0.95 - from) * moon.across) * L.W;
  return [x, lerp(low, Math.min(high, low), clamp(moon.height, -0.2, 1)), L.moon[2]];
}
