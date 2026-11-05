/* The factory is fake here, but it behaves: a small state machine per hull,
   a decision queue, and a window rule. A hull cannot pass a closed window. */
(function () {
  const VZ = window.VZ, A = VZ.audio;
  const $ = (s) => document.querySelector(s);
  const canvas = $('#glass');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (matchMedia('(hover: none)').matches || navigator.maxTouchPoints > 0) document.documentElement.classList.add('hasTouch');

  /* Vibration needs a prior tap in every browser that has it, and iOS Safari has none */
  const buzz = (p) => { const u = navigator.userActivation; if (navigator.vibrate && (!u || u.hasBeenActive)) navigator.vibrate(p); };
  let R;
  try { R = new VZ.Renderer(canvas); }
  catch (e) {
    console.error(e);
    document.body.innerHTML = '<div class="noGL">The Mosaic needs WebGL2 and this browser did not provide it.</div>';
    return;
  }

  const LAMP = {
    idle: { c: [0.92, 0.92, 0.86], label: 'idle' },
    work: { c: [0.46, 0.74, 1.0], label: 'working' },
    done: { c: [0.22, 0.82, 0.46], label: 'finished, unread' },
    need: { c: [0.98, 0.58, 0.10], label: 'needs you' },
    fail: { c: [1.0, 0.40, 0.27], label: 'failed' },
  };
  const EFFORT = ['Lowest', 'Low', 'Medium', 'High', 'Highest'];
  const NEW_NAMES = [['Rialto', 'Booking page'], ['Zattere', 'Notes sync'], ['Giudecca', 'Photo sorter'], ['Dorsoduro', 'Budget chart'], ['Cannaregio', 'Link shortener'], ['Castello', 'Habit tracker'], ['Malamocco', 'Menu scanner'], ['Erasmo', 'Garden planner']];

  const S = {
    t: 0, clock: 9 * 3600 + 41 * 60,
    usage: 0.68, wxShown: 0.68, renown: 340, gold: 7, dull: 2, effort: 2,
    plain: false, sel: 0, hold: 0, holding: false, holdTicks: 0, ready: false, sheen: 0, dim: 1, calm: 0,
    voice: 0, level: 0, talking: false, latched: false, processing: 0, flash: 0,
    card: null, queue: [], cardT: 0, cardUp: 0, chipT: 0, chipUp: 0, lido: false, ceremony: null, words: 0,
  };
  let L = null;
  let rings = [], flyers = [];
  const keys = {};
  ['reject', 'approve', 'dial', 'talk'].forEach((k) => (keys[k] = { press: 0, target: 0, el: $('#' + k) }));
  const lampEls = [...document.querySelectorAll('.lampk')];
  lampEls.forEach((el, i) => (keys['l' + i] = { press: 0, target: 0, el }));

  const hulls = [
    { id: 'aurora', name: 'Aurora', plain: 'Portfolio site', cls: 'galley', st: 3, state: 'pending', stage: 4, items: 6, total: 6, files: 14, fails: 0, lamp: 'work', note: 'Independent review running.' },
    { id: 'fenice', name: 'Fenice', plain: 'Invoice parser', cls: 'galley', st: 3, state: 'leak', stage: 4, items: 7, total: 7, files: 9, fails: 1, lamp: 'fail', note: 'Gate failed: 2 of 41 checks. Repairer on attempt 2 of 3.', timer: 25 },
    { id: 'murano', name: 'Murano', plain: 'Recipe app', cls: 'galleass', st: 2, state: 'build', stage: 3, items: 5, total: 8, files: 22, fails: 0, lamp: 'work', note: 'Building work item 6 of 8.', timer: 1.5 },
    { id: 'lido', name: 'Lido', plain: 'Tide widget', cls: 'gondola', st: 0, state: 'asking', stage: 0, items: 0, total: 3, files: 6, fails: 0, lamp: 'need', note: 'One open question before a contract can be written.', fog: 1 },
    { id: 'torcello', name: 'Torcello', plain: 'Field notes', cls: 'galley', st: 1, state: 'contract', stage: 1, items: 0, total: 5, files: 11, fails: 1, lamp: 'idle', note: 'Waiting its turn. Spending nothing.', timer: 16 },
    { id: 'burano', name: 'Burano', plain: 'Colour picker', cls: 'gondola', st: 5, state: 'learning', stage: 4, items: 3, total: 3, files: 4, fails: 0, lamp: 'done', note: 'Finished. Chronicle written, 2 lessons drafted.', timer: 9, gild: 1 },
  ];
  hulls.forEach((h, i) => Object.assign(h, { slot: i, pal: VZ.hullPalettes[h.id], fog: h.fog || 0, leak: h.state === 'leak' ? 1 : 0, gild: h.gild || 0, gildR: h.gild ? 9999 : 0, facing: 1, list: 0, s: 0, y: 0, x: 0, target: 0, after: null, timer: h.timer || 0, gx: 0, gy: 0 }));
  const hull = (id) => hulls.find((h) => h.id === id);

  /* ---------- buffers ---------- */
  const sprites = new Float32Array(18 * 96); let nS = 0;
  const dynA = new Float32Array(22 * 700); let nA = 0;
  const dynB = new Float32Array(22 * 300); let nB = 0;
  const thick = new Float32Array(20 * 18); let nT = 0;

  function spr(cx, cy, hw, hh, atlas, col, a, kind, p1, p2, p3, rot, sx) {
    if (nS >= 96) return;
    const o = nS++ * 18;
    sprites[o] = cx; sprites[o + 1] = cy; sprites[o + 2] = hw; sprites[o + 3] = hh;
    if (atlas) { sprites[o + 4] = atlas[0]; sprites[o + 5] = atlas[1]; sprites[o + 6] = atlas[2]; sprites[o + 7] = atlas[3]; }
    sprites[o + 8] = col[0]; sprites[o + 9] = col[1]; sprites[o + 10] = col[2]; sprites[o + 11] = a;
    sprites[o + 12] = kind; sprites[o + 13] = p1 || 0; sprites[o + 14] = p2 || 0; sprites[o + 15] = p3 || 0;
    sprites[o + 16] = rot || 0; sprites[o + 17] = sx === undefined ? 1 : sx;
  }
  function tile(layer, x, y, w, h, a, seed, col, gold, glyph, ink, inkA, lift, flip) {
    const buf = layer ? dynB : dynA;
    if ((layer ? nB : nA) >= (layer ? 300 : 700)) return;
    const o = (layer ? nB++ : nA++) * 22;
    buf[o] = x; buf[o + 1] = y; buf[o + 2] = w; buf[o + 3] = h; buf[o + 4] = a; buf[o + 5] = seed;
    buf[o + 6] = col[0]; buf[o + 7] = col[1]; buf[o + 8] = col[2]; buf[o + 9] = gold;
    if (glyph) { buf[o + 10] = glyph[0]; buf[o + 11] = glyph[1]; buf[o + 12] = glyph[2]; buf[o + 13] = glyph[3]; }
    else { buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = 0; buf[o + 13] = 0; }
    const k = ink || [0, 0, 0];
    buf[o + 14] = k[0]; buf[o + 15] = k[1]; buf[o + 16] = k[2]; buf[o + 17] = inkA === undefined ? 1 : inkA;
    buf[o + 18] = lift || 0; buf[o + 19] = flip || 0; buf[o + 20] = 0; buf[o + 21] = 0;
  }
  function th(cx, cy, hw, hh, rad, dep, press, kind, body, seed, glow, gi, e0, e1, e2, e3) {
    const o = nT++ * 20;
    thick.set([cx, cy, hw, hh, rad, dep, press, kind, body[0], body[1], body[2], seed, glow[0], glow[1], glow[2], gi, e0 || 0, e1 || 0, e2 || 0, e3 || 0], o);
  }
  const VELL = [0.937, 0.894, 0.796], INK = [0.106, 0.102, 0.09], DARK = [0.09, 0.14, 0.15], STONE = [0.96, 0.92, 0.83];
  const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

  function word(layer, str, x, y, m, fill, ink, opt) {
    opt = opt || {};
    const sq = opt.sq === undefined ? 1 : opt.sq;
    const chars = [...str];
    const ws = chars.map((ch) => (ch === ' ' ? 0.55 : VZ.glyphW[ch] || 1) * m.w * sq);
    const total = ws.reduce((a, b) => a + b + m.gap * sq, -m.gap * sq);
    if (opt.center) x -= total / 2;
    if (opt.right) x -= total;
    let cx = x;
    chars.forEach((ch, i) => {
      const g = VZ.glyphs[ch], w = ws[i];
      if (ch !== ' ' && g) {
        const seed = i * 3.3 + (opt.seed || 1);
        const px = cx + w / 2;
        const py = y + (opt.tilt ? (px - (opt.cx || 0)) * Math.tan(opt.tilt) : 0);
        tile(layer, px, py, w, m.h, (opt.tilt || 0) + (Math.sin(seed * 7.1) * 0.018), seed, fill, opt.gold || 0, g, ink, 1, opt.lift || 0, opt.flip ? opt.flip(i) : 0);
      }
      cx += w + m.gap * sq;
    });
    return total;
  }

  /* ---------- layout ---------- */
  const place = (el, r, hideH) => { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; };
  function quality() {
    const dev = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(1, dev * (VZ._q || 1));
  }
  function build() {
    const W = window.innerWidth, H = window.innerHeight;
    const safe = getComputedStyle($('#safe'));
    const top = parseFloat(safe.paddingTop) || 0, bot = parseFloat(safe.paddingBottom) || 0;
    const old = L;
    L = VZ.layout(W, H, top, bot);
    R.setCanvasSize(W, H, quality());
    const div = L.wide ? 3 : 2;
    const st = VZ.paintStatic(L, div);
    const tiles = VZ.tessellate(L);
    R.setWorld(st.canvas, st.data, st.dw, st.dh, tiles, st.dw, st.dh);
    VZ.count = tiles.length / 6;
    /* stars: every gold tile earned so far is a star in the sky */
    S.stars = []; S.dulls = [];
    const skyTop = L.hud.h + 5, skyH = L.regs[0].wallTop - skyTop - (L.wide ? 34 : 15);
    const place2 = (i) => {
      const x = 12 + (((i * 0.6180339) % 1) * (L.W - 24)), y = skyTop + (((i * 0.3819 + 0.2) % 1) * skyH);
      return { x, y };
    };
    for (let i = 0; i < 40; i++) S.stars.push(place2(i * 2 + 1));
    for (let i = 0; i < 12; i++) S.dulls.push(place2(i * 2 + 50));

    keys.reject.d = keys.approve.d = 9; keys.talk.d = 8; keys.dial.d = 9;
    lampEls.forEach((el, i) => { keys['l' + i].d = 6; place(el, L.lamps[i]); });
    place(keys.reject.el, L.reject); place(keys.approve.el, L.approve); place(keys.dial.el, L.dial); place(keys.talk.el, L.talk);
    place($('#card'), L.card);
    const chipH = L.wide ? 46 : 52;
    L.chipLow = { x: L.card.x, y: L.card.y + (L.card.h - chipH) / 2, w: L.card.w, h: chipH };
    L.chipHigh = L.wide ? { x: L.card.x, y: L.card.y - chipH - 12, w: L.card.w, h: chipH } : { x: L.card.x, y: L.hud.h + 8, w: L.card.w, h: chipH };
    L.chip = L.chipLow;
    place($('#chip'), L.chip);
    const feed = $('#feed'), det = $('#detail');
    feed.hidden = det.hidden = !L.wide;
    if (L.wide) { place(feed, L.feed); place(det, L.detail); }
    place($('#wxBtn'), { x: 0, y: L.hud.h, w: L.W * 0.7, h: 40 });
    place($('#plainBtn'), L.plainR = { x: L.W - (L.wide ? 106 : 72), y: L.hud.h + 3, w: L.wide ? 86 : 60, h: L.wide ? 26 : 22 });

    hulls.forEach((h) => {
      if (h.state === 'gone' || h.st < 0) { h.s = L.path.len; h.target = h.s; return; }
      if (!old) {
        h.s = L.stations[h.st].s;
        h.target = h.s;
        if (h.id === 'aurora') { h.s = L.stations[4].s - (L.wide ? 150 : 86); }
        if (h.id === 'fenice' && !L.wide) h.s += 0;
      } else {
        h.s = h.moving ? Math.min(L.stations[h.st].s, L.stations[h.st].s) : L.stations[h.st].s;
        h.target = L.stations[h.st].s;
      }
    });
    if (!old) {
      const a = hull('aurora'); a.moving = true; a.st = 4; a.target = L.stations[4].s; a.after = 'ready'; a.state = 'moving';
      setTimeout(() => proved(a, true), reduced ? 200 : 1500);
    }
    hulls.forEach(paintCell);
  }

  function paintCell(h) {
    const gl = R.gl;
    if (gl.isContextLost()) return;
    const c = VZ.paintHullCell(h.slot, h.cls, h.stage, h.pal);
    gl.bindTexture(gl.TEXTURE_2D, R.tAtlas);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, c.x, c.y, gl.RGBA, gl.UNSIGNED_BYTE, c.cv);
  }

  /* ---------- rings ---------- */
  function ring(x, y, o) {
    if (reduced && !o.keep) return;
    rings.push(Object.assign({ x, y, t0: S.t, speed: 420, w: 34, a: 1, tilt: 1, flip: 0, max: 2400, life: 3.2, r: 0 }, o));
    if (rings.length > 8) rings.shift();
  }

  /* ---------- events ---------- */
  const fmt = (t) => { const m = Math.floor(t / 60); return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  function feed(name, text) {
    const ol = $('#feed ol');
    const li = document.createElement('li');
    li.innerHTML = `<time>${fmt(S.clock)}</time><span><b>${name}</b> ${text}</span>`;
    ol.prepend(li);
    while (ol.children.length > 11) ol.lastChild.remove();
  }
  function chipPlace() {
    if (S.card && S.card.kind === 'done') closeCard();
    L.chip = S.card ? L.chipHigh : L.chipLow;
    place($('#chip'), L.chip);
  }
  function chip(text, secs) {
    const el = $('#chip');
    chipPlace();
    el.textContent = text; el.hidden = false;
    S.chipT = secs || 4;
  }
  function earn(fromX, fromY, gold, renown) {
    const list = gold ? S.stars : S.dulls;
    const idx = gold ? S.gold : S.dull;
    const to = list[Math.min(idx, list.length - 1)];
    flyers.push({ x0: fromX, y0: fromY, x1: to.x, y1: to.y, t0: S.t, dur: reduced ? 0.01 : 1.1, gold, done() {
      if (gold) { S.gold++; A.gold(); S.renown += renown || 0; } else { S.dull++; A.dull(); }
    } });
  }

  function proved(h, first) {
    h.gildR = 0.01; h.gilding = true;
    h.note = 'Gate passed, 38 of 38 checks. Review passed. Receipt issued.';
    const sz = 170 * L.hullScale;
    h.gx = h.x - h.facing * 60 * L.hullScale; h.gy = h.y - 12;
    ring(h.gx, h.gy, { speed: 130, w: 13, a: 0.7, tilt: 0.5, flip: 0.6, max: sz, life: 2.4, gildOf: h });
    A.gold();
    feed(h.name, 'gate passed, 38 of 38 checks. Receipt issued.');
    announce(h.name + ': gate passed, gold tile set.');
    setTimeout(() => earn(h.x, h.y - 16, true, 10), 1300);
  }

  function setLamp(h, l, note) { h.lamp = l; if (note) h.note = note; }

  function stationFree(k) { return !hulls.some((h) => h.st === k && h.state !== 'gone'); }
  function go(h, k, after) {
    if (!stationFree(k)) return false;
    h.st = k; h.target = L.stations[k].s; h.after = after; h.state = 'moving'; h.moving = true;
    return true;
  }

  function enter(h) {
    switch (h.state) {
      case 'ready':
        setLamp(h, 'need', 'Local preview is live. Waiting on your publish decision.');
        pushCard({ kind: 'publish', h });
        break;
      case 'asking':
        h.fog = 1; setLamp(h, 'need', 'One open question before a contract can be written.');
        if (S.lido) pushCard({ kind: 'ask', h });
        break;
      case 'contract': h.timer = 6; setLamp(h, 'work', 'Planner writing what done means.'); break;
      case 'build': h.timer = 1.5; setLamp(h, 'work', `Building work item ${h.items + 1} of ${h.total}.`); break;
      case 'prove': h.timer = 3; setLamp(h, 'work', 'Host gate running. No model involved.'); feed(h.name, 'at the gate. Host running checks.'); break;
      case 'leak':
        h.leak = 0.01; h.timer = 16; setLamp(h, 'fail', 'Gate failed: 2 of 41 checks. Repairer on attempt 1 of 3.');
        feed(h.name, 'gate failed, 2 of 41 checks. Dull tile recorded.'); earn(h.x, h.y - 16, false); break;
      case 'learning': h.timer = 9; setLamp(h, 'work', 'Writing the chronicle and lessons.'); break;
    }
  }

  function tickHull(h, dt) {
    const speed = (reduced ? 1000 : 1) * (L.wide ? 58 : 27) * (0.75 + S.effort * 0.16);
    if (h.state === 'moving') {
      let next = Math.min(h.target, h.s + speed * dt);
      const gap = (L.wide ? 130 : 96);
      const blocked = hulls.some((o) => o !== h && o.state !== 'gone' && o.s > h.s && o.s - next < gap && o.s < h.target + 1);
      if (!blocked) h.s = next;
      if (h.s >= h.target - 0.5) { h.moving = false; h.state = h.after; enter(h); }
    } else if (h.timer > 0) h.timer -= dt * (0.7 + S.effort * 0.2);

    switch (h.state) {
      case 'contract':
        if (h.st === 0) { if (go(h, 1, 'contract')) feed(h.name, 'towed to the contract office.'); }
        else if (h.timer <= 0 && go(h, 2, 'build')) feed(h.name, 'contract signed. Towed to the build yard.');
        break;
      case 'build':
        if (h.timer <= 0) {
          if (h.items < h.total) {
            h.items++; h.timer = 2.6; toss(h);
            const stage = Math.min(4, Math.floor((h.items / h.total) * 4.6));
            if (stage !== h.stage) { h.stage = stage; paintCell(h); }
            setLamp(h, 'work', `Building work item ${Math.min(h.items + 1, h.total)} of ${h.total}.`);
          } else if (go(h, 3, 'prove')) feed(h.name, `built, ${h.total} of ${h.total} work items. Towed to the gate.`);
          else setLamp(h, 'idle', 'Built. Waiting for the gate window to open.');
        }
        break;
      case 'prove':
        if (h.timer <= 0) { if (h.fails > 0) { h.fails--; h.state = 'leak'; enter(h); } else { proved(h); h.state = 'proved'; setLamp(h, 'work'); } }
        break;
      case 'leak':
        if (h.timer <= 0) { h.state = 'prove'; h.leaving = true; feed(h.name, 'repair done. Gate running again.'); enter(h); }
        break;
      case 'proved': if (go(h, 4, 'ready')) feed(h.name, 'towed to the launch basin.'); break;
      case 'live': h.timer -= dt; if (h.timer <= 0 && go(h, 5, 'learning')) feed(h.name, 'towed to the chart room.'); break;
      case 'learning':
        if (h.timer <= 0) {
          setLamp(h, 'done', 'Finished. Chronicle written, 2 lessons drafted.');
          h.state = 'waitlook'; h.timer = 10;
        }
        break;
      case 'waitlook':
        if (h.timer <= 0) { h.st = -1; h.target = L.path.len - 2; h.after = 'gone'; h.state = 'moving'; h.moving = true; feed(h.name, 'sailed.'); }
        break;
      case 'gone': if (stationFree(0)) retire(h); break;
    }
    h.leak += ((h.state === 'leak' ? 1 : 0) - h.leak) * Math.min(1, dt * 2);
    h.fog += ((h.state === 'asking' ? 1 : 0) - h.fog) * Math.min(1, dt * 1.2);
  }

  function retire(h) {
    const [name, plain] = NEW_NAMES.shift(); NEW_NAMES.push([name, plain]);
    Object.assign(h, { name, plain, stage: 0, items: 0, total: 5 + ((Math.random() * 3) | 0), gild: 0, gildR: 0, s: 0, fails: Math.random() < 0.4 ? 1 : 0, files: 6 + ((Math.random() * 20) | 0), st: 0, state: 'moving', after: 'asking', target: L.stations[0].s, moving: true, id: h.id, timer: 0, cls: h.cls === 'gondola' ? 'galley' : h.cls });
    setLamp(h, 'work', 'New idea at the slot.');
    paintCell(h);
    feed(name, 'a new idea at the slot.');
    S.lido = true;
    labels();
  }

  function toss(h) {
    const st = L.stations[h.st];
    A.tick(0.7);
    flyers.push({ x0: st.x, y0: st.archB - st.archH * 0.4, x1: h.x, y1: h.y - 14, t0: S.t, dur: 0.55, arc: 34, col: VELL });
  }

  /* ---------- decision cards ---------- */
  function pushCard(c) { S.queue.push(c); if (!S.card) nextCard(); }
  function nextCard() {
    if (S.card || !S.queue.length) return;
    const c = S.queue.shift();
    S.card = c;
    const el = $('#card');
    const h = c.h;
    const hd = el.querySelector('h2'), me = el.querySelector('.meta'), how = el.querySelector('.how');
    if (c.kind === 'publish') {
      hd.textContent = `${h.name} wants to publish to GitHub Pages.`;
      me.innerHTML = `${h.files} files, public link. <em>Gate passed.</em>`;
      how.textContent = 'Hold the ring for 2 seconds to publish. Reject keeps it local.';
    } else if (c.kind === 'ask') {
      hd.textContent = `${h.name} has one open question.`;
      me.textContent = 'Live tide data, or a table you keep?';
      how.textContent = 'Approve takes the default: live data. Reject answers later.';
    } else if (c.kind === 'done') {
      hd.textContent = `${h.name} is live.`;
      me.innerHTML = `vz-yard.github.io/${h.name.toLowerCase()} <em>Live check passed.</em>`;
      how.textContent = 'One gold tile set. It stays on the wall.';
      c.expire = S.t + 6;
    }
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('up'));
    S.cardGoal = 1;
    if (c.kind !== 'done') {
      A.pregadi();
      buzz([18, 60, 18]);
      ring(L.card.x + L.card.w / 2, L.card.y + L.card.h / 2, { speed: 260, w: 26, a: 0.7, tilt: 0.8, flip: 0.9, max: 340, life: 1.3 });
    }
    announce(hd.textContent + ' ' + me.textContent + ' ' + how.textContent);
    syncDial();
  }
  function closeCard() {
    S.card = null;
    const el = $('#card');
    el.classList.remove('up');
    S.cardGoal = 0;
    syncDial();
    setTimeout(() => { if (!S.card) { el.hidden = true; nextCard(); } }, 340);
  }
  const ringLive = () => S.card && S.card.kind === 'publish' && !S.ceremony;
  function syncDial() {
    const d = keys.dial.el;
    d.classList.toggle('ring', !!ringLive());
    d.querySelector('.a').textContent = ringLive() ? 'Hold ring' : 'Effort';
    d.querySelector('.b').textContent = ringLive() ? (S.ready ? 'Release' : '2 sec') : EFFORT[S.effort];
    d.setAttribute('aria-valuenow', S.effort + 1);
    d.setAttribute('aria-valuetext', ringLive() ? 'Press and hold for two seconds to publish' : 'Effort ' + EFFORT[S.effort]);
  }
  function announce(t) { $('#status').textContent = t; }

  function approve() {
    const c = S.card;
    if (!c) return chip('Nothing is waiting on you.', 2.4);
    if (c.kind === 'publish') { S.ringNudge = 1; return chip('Publishing is permanent, so it takes the ring. Hold it for 2 seconds.', 4); }
    if (c.kind === 'ask') {
      const h = c.h; A.gold(); feed(h.name, 'question answered: live data. Fog lifted.');
      h.state = 'contract'; h.timer = 0;
      closeCard();
      setLamp(h, 'work', 'Question answered. Waiting for the contract window.');
    }
  }
  function reject() {
    const c = S.card;
    if (!c) return chip('Nothing is waiting on you.', 2.4);
    if (c.kind === 'publish') {
      const h = c.h; feed(h.name, 'kept local. Nothing published.');
      chip(`${h.name} stays local. Nothing was published.`, 3.5);
      h.state = 'live'; h.timer = 1; setLamp(h, 'idle', 'Kept local. Nothing published.');
      S.lido = true; closeCard();
      const l = hull('lido'); if (l.state === 'asking') pushCard({ kind: 'ask', h: l });
    } else if (c.kind === 'ask') {
      const h = c.h; closeCard();
      chip(`${h.name} waits in fog. It spends nothing until you answer.`, 3.5);
      setTimeout(() => { if (h.state === 'asking') pushCard({ kind: 'ask', h }); }, 30000);
    }
  }

  /* ---------- the Sensa ---------- */
  function ceremony() {
    const c = S.card, h = c.h;
    const d = L.dial;
    const x = h.x + (L.wide ? 80 : 30) * h.facing, y = h.y + (L.wide ? 18 : 5);
    S.ceremony = { h, t0: S.t, x, y, x0: d.x + d.w / 2, y0: d.y + d.h / 2 - 3, phase: 0, bucS: -160 };
    syncDial();
    A.droneOff();
    announce('Released. Publishing ' + h.name + '.');
    feed(h.name, 'ring released. Publishing to GitHub Pages.');
    setLamp(h, 'work', 'Publish broker running. No model involved.');
    buzz(30);
  }
  function cerUpdate() {
    const C = S.ceremony; if (!C) return;
    const a = S.t - C.t0;
    if (C.phase === 0 && a >= (reduced ? 0 : 0.42)) {
      C.phase = 1;
      A.splash(); A.marangona();
      buzz([40, 80, 24, 80, 14]);
      const sp = L.wide ? 380 : 300;
      for (let i = 0; i < 6; i++) {
        setTimeout(() => ring(C.x, C.y, { speed: sp, w: i ? 13 : 18, a: i ? 1 - i * 0.1 : 1.2, tilt: 0.8, flip: i === 0 ? 0.8 : 0, life: 4.2 }), i * 240);
      }
      const hd = $('#card h2'), me = $('#card .meta'), how = $('#card .how');
      hd.textContent = `Publishing ${C.h.name} to GitHub Pages.`;
      me.textContent = 'Broker running. No model involved.';
      how.textContent = 'A gold tile is set only if the live check passes.';
    }
    if (C.phase === 1 && a > 3.4) {
      C.phase = 2;
      const h = C.h;
      closeCardNow();
      pushCard({ kind: 'done', h });
      feed(h.name, 'live check passed. HTTP 200, title matches. Gold tile set.');
      earn(h.x, h.y - 16, true, 25);
      setLamp(h, 'done', 'Live and verified. Unread.');
      h.state = 'live'; h.timer = 4;
    }
    if (C.phase === 2 && a > 9) {
      S.ceremony = null; S.lido = true; syncDial();
      const l = hull('lido'); if (l.state === 'asking') pushCard({ kind: 'ask', h: l });
    }
  }
  function closeCardNow() {
    S.card = null;
    $('#card').classList.remove('up');
    S.cardGoal = 0;
  }

  /* ---------- talk ---------- */
  const PHRASES = (h) => `Tell ${h.name} to use a darker theme.`;
  let mic = null;
  async function tryMic() {
    if (mic !== null || !navigator.mediaDevices) return;
    mic = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const an = A.ctx.createAnalyser(); an.fftSize = 512;
      A.ctx.createMediaStreamSource(stream).connect(an);
      mic = { an, buf: new Uint8Array(512) };
    } catch (e) { mic = false; }
  }
  function micLevel() {
    if (!mic) return null;
    mic.an.getByteTimeDomainData(mic.buf);
    let s = 0; for (let i = 0; i < 512; i += 2) { const v = (mic.buf[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / 256) * 5);
  }
  function talkStart() {
    if (S.talking) return;
    S.talking = true; S.talkT = 0; S.words = 0;
    chipPlace();
    tryMic();
    A.press(0.8);
    buzz(12);
    keys.talk.target = 1;
  }
  function talkEnd() {
    if (!S.talking) return;
    S.talking = false; S.latched = false; keys.talk.target = 0; A.release(0.8);
    S.processing = 0.8;
    const h = hulls[S.sel];
    const said = PHRASES(h);
    setTimeout(() => {
      chip(`Nudge queued for ${h.name}. Reads it at the next window.`, 3.2);
      feed(h.name, 'nudge: "use a darker theme". Folds in at the next tool boundary.');
      flyers.push({ x0: L.talk.x + 40, y0: L.talk.y, x1: h.x, y1: h.y - 10, t0: S.t, dur: 0.9, arc: 60, col: [0.45, 0.9, 0.78] });
      A.tick(1.3);
    }, reduced ? 0 : 800);
  }

  /* ---------- selection ---------- */
  function selectHull(i, quiet) {
    S.sel = i;
    const h = hulls[i];
    if (h.lamp === 'done') setLamp(h, 'idle', h.note); /* green is a to-do: it clears when you look */
    if (!quiet) {
      ring(h.x, h.y, { speed: 150, w: 13, a: 0.55, tilt: 0.7, max: 110, life: 0.9 });
      if (!L.wide) chip(`${h.name}, ${h.plain}. ${h.note}`, 4.6);
    }
    renderDetail(); labels();
  }
  function renderDetail() {
    if (!L || !L.wide) return;
    const h = hulls[S.sel], st = L.stations[Math.max(0, h.st)];
    $('#detail').innerHTML = `<h3>${h.name}</h3><p class="sub">${h.plain}, ${S.plain ? st.p.toLowerCase() : st.f[0] + st.f.slice(1).toLowerCase() + ' (' + st.p.toLowerCase() + ')'}</p>
      <dl><dt>Status</dt><dd>${LAMP[h.lamp].label}</dd><dt>Now</dt><dd>${h.note}</dd><dt>Items</dt><dd>${h.items} of ${h.total} done, ${h.files} files</dd></dl>`;
  }
  function labels() {
    hulls.forEach((h, i) => {
      const el = lampEls[i];
      el.querySelector('b').textContent = h.name[0];
      el.querySelector('i').textContent = h.name;
      el.setAttribute('aria-label', `${h.name}: ${LAMP[h.lamp].label}. ${h.note}`);
    });
    $('#plainBtn').setAttribute('aria-pressed', S.plain);
    $('#wxBtn').setAttribute('aria-label', `${wxName()}, ${Math.round(S.usage * 100)} percent of the rate window used. Tap to preview other weather.`);
  }
  function wxName() { return S.usage < 0.5 ? 'CLEAR' : S.usage <= 0.75 ? 'WIND' : S.usage < 0.9 ? 'SQUALL' : 'STORM'; }

  /* ---------- input ---------- */
  const bindHold = (el, down, up) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); A.init(); try { el.setPointerCapture(e.pointerId); } catch (x) {} down(e); });
    const u = (e) => up(e);
    el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u); el.addEventListener('lostpointercapture', u);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  function keyDown(k, p) { if (keys[k].target) return; keys[k].target = 1; A.press(p); buzz(8); }
  function keyUp(k, p, fn) { if (!keys[k].target) return; keys[k].target = 0; A.release(p); fn && fn(); }

  bindHold(keys.approve.el, () => keyDown('approve', 1.15), () => keyUp('approve', 1.15, approve));
  bindHold(keys.reject.el, () => keyDown('reject', 0.8), () => keyUp('reject', 0.8, reject));
  lampEls.forEach((el, i) => bindHold(el, () => keyDown('l' + i, 1.5), () => keyUp('l' + i, 1.5, () => selectHull(i))));

  let lastTalk = 0;
  bindHold(keys.talk.el, () => {
    const now = performance.now();
    if (S.latched) { talkEnd(); return; }
    if (now - lastTalk < 350) { S.latched = true; lastTalk = 0; chip('Hands-free. Press again to stop.', 2); talkStart(); return; }
    lastTalk = now; talkStart();
  }, () => { if (!S.latched) talkEnd(); });

  function holdStart() { if (!ringLive() || S.holding) return; S.holding = true; S.holdTicks = 0; keys.dial.target = 1; A.press(0.7); A.droneOn(); }
  function holdEnd() {
    if (!S.holding) return;
    S.holding = false; keys.dial.target = 0;
    if (S.hold >= 1) { S.ready = false; ceremony(); }
    else { A.droneOff(); A.release(0.7); if (S.hold > 0.05) chip('Not published. Hold the full 2 seconds.', 2.6); }
    syncDial();
  }
  let dialDrag = null;
  function setEffort(v) {
    v = Math.max(0, Math.min(4, v));
    if (v === S.effort) return;
    S.effort = v; A.tick(1 + v * 0.1); buzz(4);
    syncDial();
  }
  bindHold(keys.dial.el, (e) => {
    if (ringLive()) return holdStart();
    keyDown('dial', 0.9);
    const d = L.dial, cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    dialDrag = { cx, cy, a: Math.atan2(e.clientY - cy, e.clientX - cx), acc: 0 };
  }, () => { holdEnd(); dialDrag = null; keyUp('dial', 0.9); });
  keys.dial.el.addEventListener('pointermove', (e) => {
    if (!dialDrag) return;
    const a = Math.atan2(e.clientY - dialDrag.cy, e.clientX - dialDrag.cx);
    let d = a - dialDrag.a; if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
    dialDrag.a = a; dialDrag.acc += d;
    if (Math.abs(dialDrag.acc) > 0.42) { setEffort(S.effort + Math.sign(dialDrag.acc)); dialDrag.acc = 0; }
  });

  $('#plainBtn').addEventListener('click', () => { A.init(); A.tick(); S.plain = !S.plain; S.plainFlip = S.t; labels(); renderDetail(); });
  const wxSteps = [0.42, 0.68, 0.93]; let wxI = 1;
  $('#wxBtn').addEventListener('click', () => {
    A.init(); A.tick(1.2); wxI = (wxI + 1) % 3; S.usage = wxSteps[wxI]; labels();
    chip(`${wxName()[0] + wxName().slice(1).toLowerCase()} shows the rate limit: ${Math.round(S.usage * 100)}% of the window used. Preview only.`, 3.4);
  });
  canvas.addEventListener('pointerdown', (e) => {
    A.init();
    let best = 1e9, bi = -1;
    hulls.forEach((h, i) => { const d = Math.hypot(h.x - e.clientX, h.y - 16 - e.clientY); if (d < best) { best = d; bi = i; } });
    if (best < 70 * L.hullScale) { A.tick(); selectHull(bi); }
  });
  window.addEventListener('pointermove', (e) => { S.px = e.clientX; S.py = e.clientY; }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k >= '1' && k <= '6') { const i = +k - 1; keyDown('l' + i, 1.5); setTimeout(() => keyUp('l' + i, 1.5, () => selectHull(i)), 90); }
    else if (k === 'y' || k === 'Y') { A.init(); keyDown('approve', 1.15); setTimeout(() => keyUp('approve', 1.15, approve), 90); }
    else if (k === 'n' || k === 'N') { A.init(); keyDown('reject', 0.8); setTimeout(() => keyUp('reject', 0.8, reject), 90); }
    else if (k === ' ') { e.preventDefault(); A.init(); talkStart(); }
    else if (k === '[' || (document.activeElement === keys.dial.el && (k === 'ArrowLeft' || k === 'ArrowDown'))) setEffort(S.effort - 1);
    else if (k === ']' || (document.activeElement === keys.dial.el && (k === 'ArrowRight' || k === 'ArrowUp'))) setEffort(S.effort + 1);
    else if (k === 'Enter' && document.activeElement === keys.dial.el) { A.init(); holdStart(); }
    else if (k === 'o' || k === 'O') { A.init(); holdStart(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') talkEnd();
    if (e.key === 'Enter' || e.key === 'o' || e.key === 'O') holdEnd();
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { build(); renderDetail(); }, 120); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = performance.now(); requestAnimationFrame(frame); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('webgl context lost'); });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  /* ---------- per-frame ---------- */
  const springs = {};
  function spring(k, tgt, dt, stiff) { const s = (springs[k] = springs[k] || { x: tgt, v: 0 }); const f = (tgt - s.x) * stiff - s.v * 2 * Math.sqrt(stiff) * 0.72; s.v += f * dt; s.x += s.v * dt; return s.x; }

  function stationLight(st, i) {
    const occ = hulls.find((h) => h.st === i && h.state !== 'moving' && h.state !== 'gone');
    if (i === 3 && occ && occ.leak > 0.3) return { col: [0.86, 0.22, 0.10], open: false };
    if (occ && occ.lamp === 'work') return { col: [0.56, 0.74, 0.95], open: true };
    if (occ) return { col: [0.93, 0.80, 0.55], open: true };
    return { col: [0.93, 0.80, 0.55], open: true };
  }

  function draw(dt) {
    nS = nA = nB = nT = 0;
    const a = VZ.atlas, t = S.t;
    const U = a.unitW, UH = a.unitH;

    /* arches */
    L.stations.forEach((st, i) => {
      const s = stationLight(st, i);
      spr(st.x, st.archB - st.archH / 2, st.archW / 2, st.archH / 2, null, s.col, 0, 5);
      if (!s.open) spr(st.x, st.archB - st.archH / 2, st.archW / 2, st.archH / 2, null, [0.10, 0.11, 0.12], 0, 8, 5);
      /* window light on the water */
      spr(st.x, st.archB + (L.wide ? 26 : 11), st.archW * 0.42, L.wide ? 26 : 11, null, s.col.map((v) => v * 0.62), 0, 6);
    });

    /* Bucintoro: appears only at release */
    const C = S.ceremony;
    let bx = 0;
    if (C && C.phase >= 1) {
      const p = VZ.pointAt(L.path, L.stations[4].s);
      const age = t - C.t0 - 0.42;
      const k = Math.min(1, age / 8.5);
      const x0 = L.wide ? C.x - 300 : -170;
      bx = x0 + (L.W + 220 - x0) * k * k * 0.4 + (L.W + 220 - x0) * k * 0.6;
      const sc = L.hullScale * (L.wide ? 1.3 : 1.25);
      const yy = p.y + (L.wide ? 70 : 3);
      const atl = [(8 % a.cols) * a.CELL_W / a.W, Math.floor(8 / a.cols) * a.CELL_H * 2 / a.H, a.CELL_W / a.W, a.CELL_H / a.H];
      const wave = Math.max(0, age) * (L.wide ? 380 : 300);
      spr(bx, yy - 0.2 * UH * sc + Math.sin(t * 1.4) * 1.2, U / 2 * sc, UH / 2 * sc, atl, [1, 0, 0], 1, 7, wave, C.x, C.y);
    }

    hulls.forEach((h, i) => {
      if (h.state === 'gone') return;
      const p = VZ.pointAt(L.path, h.s);
      const sc = (h.cls === 'gondola' ? 0.86 : h.cls === 'galleass' ? 1.04 : 1) * L.hullScale;
      const want = p.tx >= 0 ? 1 : -1;
      h.facing += (want - h.facing) * Math.min(1, dt * 3.2);
      if (Math.abs(p.tx) < 0.3 && p.ty) h.facing += 0;
      const bob = reduced ? 0 : Math.sin(t * 1.3 + i * 1.7) * (0.9 + S.wxShown * 1.6);
      const waterY = p.y + L.band * (L.wide ? 0.02 : 0.10) + bob;
      h.x = p.x; h.y = waterY;
      const rock = reduced ? 0 : Math.sin(t * 0.9 + i) * (0.008 + S.wxShown * 0.03);
      h.list += ((h.leak > 0.3 ? 0.075 : 0) - h.list) * Math.min(1, dt * 1.5);
      const ang = rock + h.list * Math.sign(h.facing || 1);
      const sx = Math.abs(h.facing) < 0.12 ? 0.12 * Math.sign(h.facing || 1) : h.facing;
      const atl = [(h.slot % a.cols) * a.CELL_W / a.W, Math.floor(h.slot / a.cols) * a.CELL_H * 2 / a.H, a.CELL_W / a.W, a.CELL_H / a.H];
      const yC = waterY - 0.2 * UH * sc;
      const hero = S.hold > 0.02 && S.card && S.card.h === h;

      if (h.leak > 0.05) spr(h.x - h.facing * 8, waterY + 3 * sc, 112 * sc * h.leak, 22 * sc, null, [0, 0, 0], 1, 6);
      spr(h.x, waterY + 0.2 * UH * sc * 0.6, U / 2 * sc * Math.abs(sx), -(UH / 2) * sc * 0.6, atl, [0, 0, 0], 0, 1);
      if (h.gildR > 0 && h.gilding) {
        h.gildR += dt * 130;
        if (h.gildR > 420 * L.hullScale) { h.gilding = false; h.gild = 1; h.gildR = 9999; }
      }
      const gR = h.gild ? 9999 : h.gildR;
      /* gold wave radiates from a fixed origin on the hull so moving hulls stay gilded */
      const gox = h.gild ? h.x : h.gx, goy = h.gild ? h.y : h.gy;
      spr(h.x, yC, U / 2 * sc * Math.abs(sx), UH / 2 * sc, atl, [hero ? 1 : 0, 0, 0], h.stage >= 3 && h.cls !== 'gondola' ? 1 : 0, 0, gR, gox, goy, ang, sx >= 0 ? 1 : -1);
      if (h.moving || h.gilding) { h.gx = h.x - h.facing * 60 * L.hullScale; h.gy = h.y - 12; }

      if (h.leak > 0.05) {
        spr(h.x - h.facing * 34 * sc, waterY - 66 * sc, 50 * sc, 68 * sc, null, [0, 0, 0], 0, 3, -h.facing * 0.1 - S.wxShown * 0.5);
      }
      if (h.state === 'build') spr(h.x, waterY - 28 * sc, 74 * sc, 44 * sc, null, [0.45, 0.68, 1.0], 0.6, 9);
      if (h.fog > 0.02) {
        const k = h.fog;
        spr(h.x, waterY - 12 * sc, 92 * sc * k, 66 * sc * k, null, [0, 0, 0], 3.1 + i, 2);
      }
      /* name set on the hull in movable type */
      const m = L.plate;
      const name = h.name.toUpperCase();
      const sq = Math.min(1, Math.abs(sx));
      const fit = Math.min(1, (146 * sc) / (name.length * (m.w + m.gap)));
      const mm = { w: m.w * fit, h: m.h, gap: m.gap * fit };
      const plY = waterY - 5.5 * sc;
      if (sq > 0.25) {
        const total = word(0, name, h.x, plY, mm, VELL, INK, { center: 1, seed: i * 4 + 1, sq, tilt: ang, cx: h.x });
        const lc = LAMP[h.lamp].c;
        const ps = m.h * 0.56;
        tile(0, h.x + (h.facing > 0 ? -1 : 1) * (total / 2 + ps * 0.95), plY + (h.facing > 0 ? 1 : -1) * 0, ps, ps, 0, i, lc, 0, null, null, 0, S.sel === i ? 0.35 : 0);
      }
      if (h.leak > 0.4) { /* sprung planks: glass that pulses at the waterline */
        for (let k = 0; k < 6; k++) {
          const lx = h.x + (k - 2.5) * 13 * sc, on = reduced ? 1 : 0.55 + 0.45 * Math.sin(t * 6 + k * 1.9);
          tile(0, lx, waterY + 8.5 * sc + (lx - h.x) * Math.tan(ang), 8 * sc, 4.6 * sc, ang, k + 0.3, [0.95 * on, 0.22 * on, 0.1 * on], 0);
        }
      }
      /* work items: one pip per item, lit when done */
      if (h.state === 'build') {
        for (let k = 0; k < h.total; k++) {
          const pw = L.wide ? 8 : 5;
          tile(0, h.x - ((h.total - 1) * (pw + 1.5)) / 2 + k * (pw + 1.5), waterY - 92 * sc, pw, pw, 0, k * 2.1 + i, k < h.items ? [0.45, 0.72, 1] : [0.08, 0.13, 0.16], 0);
        }
      }
      if (h.fog > 0.3) word(0, '?', h.x + 44 * sc, waterY - 52 * sc, m, VELL, INK, { center: 1, seed: 9, wave: 1.2 });
    });

    /* station plates */
    L.stations.forEach((st, i) => {
      const lab = S.plain ? st.p : st.f;
      const fl = S.plainFlip && t - S.plainFlip < 0.7 ? (j) => Math.max(0, 1 - Math.abs((t - S.plainFlip) * 3 - j * 0.1 - 0.5) * 2) : null;
      word(0, lab, st.x, st.plateY, L.splate, [0.13, 0.15, 0.15], VELL, { center: 1, seed: i * 7 + 2, flip: fl });
    });

    /* gold stars: the verified results so far. Dull glass for failed gates */
    for (let i = 0; i < Math.min(S.gold, S.stars.length); i++) {
      const s = S.stars[i], w = L.wide ? 10 : 7;
      tile(0, s.x, s.y, w, w, 0.785, i * 1.9, [0.85, 0.66, 0.23], 1);
    }
    for (let i = 0; i < Math.min(S.dull, S.dulls.length); i++) {
      const s = S.dulls[i], w = L.wide ? 7 : 4.6;
      tile(0, s.x, s.y, w, w, 0.2, i * 2.9, [0.19, 0.2, 0.21], 0);
    }

    /* HUD in movable type */
    const y0 = L.top + (L.wide ? 25 : 18), m = L.hudt, gx = 12;
    const lx = L.wide ? 22 : 12;
    let x = lx;
    x += word(0, S.plain ? 'RATE LIMIT' : 'TREASURY', x, y0, m, DARK, VELL, { seed: 3 }) + m.w * 0.7;
    const left = 1 - S.usage, seg = L.wide ? 14 : 10;
    const tw = L.wide ? 9 : 5.4;
    for (let i = 0; i < seg; i++) {
      const on = i / seg < left;
      tile(0, x + i * (tw + 1.2) + tw / 2, y0, tw, m.h, 0, i * 3.1, on ? [0.36, 0.72, 0.62] : [0.12, 0.16, 0.17], 0);
    }
    x += seg * (tw + 1.2) + m.w * 0.5;
    word(0, Math.round(left * 100) + '%', x, y0, m, DARK, VELL, { seed: 4 });

    let rx = L.W - lx;
    const gtxt = String(S.gold);
    rx -= word(0, gtxt, rx, y0, m, DARK, [0.95, 0.78, 0.36], { right: 1, seed: 8 }) + 3;
    tile(0, rx - m.w * 0.36, y0, m.w * 0.8, m.w * 0.8, 0.785, 1.2, [0.85, 0.66, 0.23], 1);
    rx -= m.w * 1.4;
    const ren = 'RENOWN ' + S.renown;
    rx -= word(0, ren, rx, y0, m, DARK, VELL, { right: 1, seed: 6 });

    /* weather, read directly off the sky */
    const wn = wxName() + ' ' + Math.round(S.usage * 100) + '%';
    word(0, wn, lx, L.hud.h + (L.wide ? 22 : 13), L.hudt, [0.92, 0.91, 0.83], INK, { seed: 11 });
    if (L.wide) word(0, 'OF RATE WINDOW USED', lx + (wn.length + 1) * (m.w + m.gap), L.hud.h + 22, { w: 10, h: 14, gap: 0.5 }, DARK, VELL, { seed: 12 });
    if (!S.card && S.chipUp < 0.3 && S.cardUp < 0.3) {
      word(0, S.queue.length ? 'ONE MOMENT' : 'NOTHING NEEDS YOU', L.card.x + L.card.w / 2, L.card.y + L.card.h / 2, { w: L.wide ? 13 : 10, h: L.wide ? 18 : 14, gap: 0.7 }, [0.10, 0.14, 0.15], [0.62, 0.74, 0.70], { center: 1, seed: 19 });
    }
    /* plain toggle */
    word(0, S.plain ? 'FICTION' : 'PLAIN', L.plainR.x + L.plainR.w, L.plainR.y + L.plainR.h / 2, { w: L.wide ? 12 : 9, h: L.wide ? 16 : 12.5, gap: 0.4 }, DARK, VELL, { right: 1, seed: 13 });

    if (C && C.phase >= 1 && t - C.t0 > 0.9 && t - C.t0 < 7) {
      const line = S.plain ? 'MARRIED TO THE SEA' : 'DESPONSAMUS TE MARE';
      const mm = L.wide ? { w: 20, h: 26, gap: 1.2 } : { w: Math.min(16, (L.W - 40) / line.length), h: 19, gap: 0.8 };
      const yy = L.wide ? L.hud.h + L.sky.h * 0.6 : L.sky.y + L.sky.h * 0.62;
      const age = t - C.t0 - 0.9;
      word(0, line, L.W / 2, yy, mm, VELL, INK, { center: 1, seed: 31, flip: (j) => Math.max(0, 1 - Math.max(0, age * 4 - j * 0.12)) });
    }

    /* tiles in flight */
    flyers = flyers.filter((f) => {
      const u = (t - f.t0) / f.dur;
      if (u >= 1) { f.done && f.done(); return false; }
      const e = u * u * (3 - 2 * u);
      const px = f.x0 + (f.x1 - f.x0) * e, py = f.y0 + (f.y1 - f.y0) * e - Math.sin(u * Math.PI) * (f.arc || 30);
      tile(1, px, py, 7, 7, u * 7, 3.3, f.gold === undefined ? f.col : f.gold ? [0.85, 0.66, 0.23] : [0.2, 0.2, 0.22], f.gold ? 1 : 0, null, null, 0, 0.3);
      return true;
    });

    /* --- thick glass --- */
    const body = (r, press, kind, b, seed, g, gi, rad, dep, e) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      th(cx, cy, r.w / 2, r.h / 2, rad, dep, press, kind, b, seed, g, gi, e && e[0], e && e[1], e && e[2], e && e[3]);
    };
    if (L.wide) {
      const slab = [0.075, 0.12, 0.125];
      body(L.feed, 0, 2, slab, 0.2, [0, 0, 0], 0, 9, 3);
      body(L.detail, 0, 2, slab, 0.6, [0, 0, 0], 0, 9, 3);
    }
    /* card */
    S.cardUp = spring('card', S.cardGoal ? 1 : 0, dt, 110);
    if (S.cardUp > 0.02) {
      const cu = Math.max(0, Math.min(1.1, S.cardUp));
      const r = L.card, sc = 0.94 + 0.06 * cu;
      const rr = { x: r.x + (r.w * (1 - sc)) / 2, y: r.y + 6 * (1 - cu), w: r.w * sc, h: r.h };
      body(rr, 1 - cu, 2, STONE, 0.4, [0, 0, 0], 0, 11, 7);
    }
    /* transcript / chip */
    S.chipUp = spring('chip', S.chipT > 0 || S.talking ? 1 : 0, dt, 170);
    if (S.chipUp > 0.03) body(L.chip, 1 - Math.min(1, S.chipUp), 2, [0.075, 0.135, 0.135], 0.8, [0, 0, 0], 0, 9, 6);
    $('#chip').style.opacity = S.chipUp > 0.5 ? 1 : 0;
    $('#chip').style.transform = `translateY(${-6 * (Math.min(1, S.chipUp))}px)`;

    /* lamps */
    hulls.forEach((h, i) => {
      const k = keys['l' + i];
      k.press += (k.target - k.press) * Math.min(1, dt * 26);
      const lc = LAMP[h.lamp].c;
      let br = 1;
      if (h.lamp === 'work') br = 0.88 + 0.12 * Math.sin(t * 2.6 + i);
      if (h.lamp === 'need') br = 0.86 + 0.14 * Math.sin(t * 5.2);
      if (h.lamp === 'fail') br = 0.88 + 0.12 * (Math.sin(t * 8) > 0 ? 1 : 0);
      if (reduced) br = 1;
      const b = [0.42 + lc[0] * 0.52, 0.42 + lc[1] * 0.52, 0.42 + lc[2] * 0.52].map((v, j) => v * (0.5 + lc[j] * 0.5));
      body(L.lamps[i], k.press, 0, b, i * 0.13, lc, 1.08 * br, 7, k.d, [0, 0, 0, 0]);
      k.el.style.setProperty('--h', (k.d * (1 - k.press * 0.78)).toFixed(1) + 'px');
      if (S.sel === i) tile(1, L.lamps[i].x + L.lamps[i].w / 2, L.lamps[i].y - 9, L.lamps[i].w * 0.5, 2.6, 0, 1, VELL, 0);
    });

    const pk = (k, stiff) => { const K = keys[k]; K.press += (K.target - K.press) * Math.min(1, dt * (stiff || 30)); K.el.style.setProperty('--h', (K.d * (1 - K.press * 0.78)).toFixed(1) + 'px'); return K.press; };
    const hasCard = S.card && S.card.kind !== 'done';
    body(L.reject, pk('reject'), 0, [0.25, 0.055, 0.03], 0.21, [0.92, 0.22, 0.10], hasCard ? 0.5 : 0.26, 13, keys.reject.d);
    const appr = S.card && S.card.kind === 'ask';
    body(L.approve, pk('approve'), 0, [0.03, 0.2, 0.17], 0.33, [0.20, 0.82, 0.64], appr ? 0.42 : 0.2, 13, keys.approve.d);

    const talking = S.talking;
    const talkG = talking ? [0.27, 0.86, 0.68] : S.processing > 0 ? [0.92, 0.95, 0.92] : [0.20, 0.5, 0.45];
    const pt = pk('talk');
    body(L.talk, pt, 0, [0.055, 0.08, 0.085], 0.53, talkG, talking ? 0.32 + S.level * 0.45 : S.processing > 0 ? 0.5 : 0.1, 13, keys.talk.d, [0, 0, 0, talking || S.processing > 0 ? 1 : 0]);
    /* live voice: columns of tiny tiles inside the talk key */
    const tk = L.talk, cols = L.wide ? 34 : 24, tw2 = 3.6, gap = 2.2;
    const barsR = tk.x + tk.w - 14, barsW = cols * (tw2 + gap);
    const baseY = tk.y + tk.h / 2 - keys.talk.d * (1 - pt * 0.78);
    for (let i = 0; i < cols; i++) {
      const hist = S.vb ? S.vb[(S.vbH + S.vb.length - i * 2) % S.vb.length] : 0;
      const h = 2.4 + hist * (tk.h * 0.62);
      const col = talking || S.level > 0.02 ? [0.45, 0.95, 0.78] : [0.17, 0.27, 0.26];
      tile(1, barsR - barsW + i * (tw2 + gap), baseY, tw2, h, 0, i * 1.3, col, 0, null, null, 0, Math.min(0.9, hist));
    }

    /* dial */
    const d = L.dial;
    const pd = pk('dial', 22);
    const ringVis = ringLive() ? 1 : 0;
    S.ringV = (S.ringV || 0) + (ringVis - (S.ringV || 0)) * Math.min(1, dt * 6);
    const nudge = (S.ringNudge = Math.max(0, (S.ringNudge || 0) - dt * 1.4));
    const dr = d.w / 2;
    th(d.x + dr, d.y + dr, dr, dr, dr, keys.dial.d, pd, 1, [0.06, 0.085, 0.09], 0.71, ringVis ? [0.85, 0.66, 0.23] : [0.24, 0.55, 0.49], ringVis ? 0.13 + S.hold * 0.55 + nudge * 0.4 + (S.holding ? 0 : 0.08 + 0.08 * Math.sin(t * 3.2)) : 0.11, 0, S.ringV, S.hold, 0);
    /* effort ticks: five tiny tiles on the deck around the dial */
    if (S.ringV < 0.5) for (let i = 0; i < 5; i++) {
      const an = -Math.PI * 0.5 + (i - 2) * 0.46, rr = dr + 7;
      tile(0, d.x + dr + Math.cos(an) * rr, d.y + dr + Math.sin(an) * rr, 6, 3, an + Math.PI / 2, i, i <= S.effort ? [0.45, 0.82, 0.70] : [0.14, 0.2, 0.2], 0);
    }
    const hy = keys.dial.d * (1 - pd * 0.78);

    /* the ring falls */
    if (C && C.phase === 0) {
      const u = Math.min(1, (t - C.t0) / 0.42), e = u * u;
      const rr = dr + (10 - dr) * e;
      th(C.x0 + (C.x - C.x0) * e, C.y0 + (C.y - C.y0) * e, rr, rr, rr, 0, 0, 3, [1, 1, 1], 0, [1, 1, 1], 1);
    }
  }

  function buildLights() {
    const list = [];
    hulls.forEach((h, i) => {
      const r = L.lamps[i], c = LAMP[h.lamp].c;
      list.push({ x: r.x + r.w / 2, y: r.y + r.h / 2, r: L.wide ? 60 : 44, i: 0.34, c });
    });
    if (S.talking) list.push({ x: L.talk.x + L.talk.w / 2, y: L.talk.y, r: 160, i: 0.2 + S.level * 0.4, c: [0.25, 0.8, 0.62] });
    const d = L.dial;
    if (S.hold > 0) list.push({ x: d.x + d.w / 2, y: d.y + d.h / 2, r: 110 + S.hold * 180, i: 0.2 + S.hold * 0.5, c: [0.85, 0.62, 0.2] });
    return list;
  }

  function update(dt) {
    S.t += reduced ? dt * 0.12 : dt;
    S.tReal = (S.tReal || 0) + dt;
    S.clock += dt * 6;
    if (!reduced) S.usage = Math.min(0.97, S.usage + dt * 0.00012);
    const wxTarget = S.usage;
    S.wxShown += (wxTarget - S.wxShown) * Math.min(1, dt * 1.1);
    if (S.usage >= 0.9 && !reduced && Math.random() < dt * 0.14) S.flash = 0.8;
    S.flash *= Math.exp(-dt * 9);
    A.weather && A.ctx && A.weather(S.wxShown);

    hulls.forEach((h) => tickHull(h, dt));
    cerUpdate();

    /* ring hold */
    if (S.holding) {
      S.hold = Math.min(1, S.hold + dt / 2);
      const ticks = Math.floor(S.hold * 24);
      if (ticks > S.holdTicks) { S.holdTicks = ticks; A.tick(0.8 + S.hold * 1.1); if (ticks % 3 === 0) buzz(6); }
      if (S.hold >= 1 && !S.ready) { S.ready = true; syncDial(); A.gold(); chipOff(); }
      A.droneSet(S.hold);
    } else if (S.hold > 0) {
      S.hold = S.ceremony ? Math.max(0, S.hold - dt * 1.6) : Math.max(0, S.hold - dt * 2.2);
      if (S.hold === 0) S.ready = false;
    }
    const cAge = S.ceremony ? S.t - S.ceremony.t0 : 99;
    /* while the ring is held, the mosaic stills: every tile turns toward you */
    const calmT = S.holding ? S.hold : 0;
    S.calm += (calmT - S.calm) * Math.min(1, dt * (S.holding ? 5 : 11));
    S.dim = 1 - S.calm * 0.42;
    S.sheen = S.calm * 0.62;

    /* voice */
    let lvl = 0;
    if (S.talking) {
      S.talkT += dt;
      const real = micLevel();
      const tt = S.talkT;
      const syll = Math.abs(Math.sin(tt * 7.3)) * (0.55 + 0.45 * Math.abs(Math.sin(tt * 2.3 + 1)));
      const gate = Math.sin(tt * 0.9) > -0.82 ? 1 : 0.1;
      lvl = real !== null ? real : 0.24 + 0.76 * syll * gate;
      const h = hulls[S.sel];
      const ph = PHRASES(h).split(' ');
      const n = Math.min(ph.length, Math.floor(tt * 3.2) + 1);
      if (n !== S.words) { S.words = n; $('#chip').textContent = ph.slice(0, n).join(' '); $('#chip').hidden = false; }
    }
    S.level += (lvl - S.level) * Math.min(1, dt * (lvl > S.level ? 40 : 12));
    S.voice = Math.max(S.level, S.voice - dt * 0.4);
    if (S.processing > 0) S.processing -= dt;
    S.vb = S.vb || new Float32Array(120); S.vbH = S.vbH || 0;
    S.vbA = (S.vbA || 0) + dt * 60;
    while (S.vbA >= 1) { S.vbA -= 1; S.vbH = (S.vbH + 1) % S.vb.length; S.vb[S.vbH] = S.level; }
    S.hA = (S.hA || 0) + dt * 88;
    const hn = Math.floor(S.hA); S.hA -= hn;
    if (!reduced && hn) R.pushHist(S.level, hn);
    const tl = S.talking ? 'Listening' : S.processing > 0 ? 'Reading' : 'Hold to talk';
    if (tl !== S.talkLabel) { S.talkLabel = tl; keys.talk.el.querySelector('span').textContent = tl; }

    if (S.chipT > 0 && !S.talking) { S.chipT -= dt; }
    if (S.card && S.card.expire && S.t > S.card.expire) closeCard();

    for (const r of rings) { const age = S.t - r.t0; r.r = age * r.speed; r.aNow = r.a; }
    rings = rings.filter((r) => S.t - r.t0 < r.life);
    S.frameCount = (S.frameCount || 0) + 1;
    if (S.frameCount % 45 === 0) { labels(); if (L.wide) renderDetail(); }
  }
  const chipOff = () => (S.chipT = 0);

  function frameData() {
    const t = S.t, W = L.W, H = L.H;
    let lx = W * (0.5 + 0.62 * Math.sin(t * 0.17)), ly = H * (0.36 + 0.38 * Math.sin(t * 0.11 + 1.1));
    if (reduced) { lx = W * 0.62; ly = H * 0.3; }
    if (S.px !== undefined) { lx += (S.px - W / 2) * 0.4; ly += (S.py - H / 2) * 0.3; }
    if (S.calm > 0.01 && S.card) { lx += (S.card.h.x - lx) * S.calm * 0.8; ly += (S.card.h.y - ly) * S.calm * 0.8; }
    const rr = rings.map((r) => { const age = t - r.t0, k = Math.max(0, 1 - age / r.life); return { x: r.x, y: r.y, r: r.r, a: r.a * k, w: r.w + age * 9, tilt: r.tilt, flip: r.flip * Math.min(1, k * 1.6), max: r.max }; });
    return {
      t, wx: Math.max(0, (S.wxShown - 0.32) / 0.64), flash: S.flash, dim: S.dim, calm: S.calm, sheen: S.sheen, motion: !reduced,
      light: [lx, ly, L.wide ? 520 : 400], worldB: L.world.h, rings: rr, lights: buildLights(),
      sprites, nSprites: nS, dynA, nDynA: nA, dynB, nDynB: nB, thick, nThick: nT,
      voice: S.level + S.voice, voiceTint: S.voice, voiceP: [L.talk.x + L.talk.w / 2, L.talk.y + L.talk.h / 2],
    };
  }

  let last = 0, ema = 16, lowFor = 0;
  const stats = { frames: 0, t0: 0 };
  function frame(now) {
    if (document.hidden) return;
    const dt = Math.max(0.001, Math.min(0.05, (now - last) / 1000 || 0.016));
    const raw = now - last;
    last = now;
    update(dt);
    draw(dt);
    if (!R.gl.isContextLost()) R.draw(frameData());
    stats.frames++;
    /* adaptive quality: drop pixels before dropping frames */
    if (raw < 200) {
      ema += (raw - ema) * 0.06;
      if (ema > 21) lowFor += dt; else lowFor = Math.max(0, lowFor - dt);
      if (lowFor > 2 && !VZ.noAdapt && (VZ._q || 1) > 0.6) {
        VZ._q = (VZ._q || 1) - 0.2; lowFor = 0;
        R.setCanvasSize(L.W, L.H, quality());
      }
    }
    requestAnimationFrame(frame);
  }

  function start() {
    const atlasCv = document.createElement('canvas');
    atlasCv.width = VZ.atlas.W; atlasCv.height = VZ.atlas.H;
    R.setAtlas(atlasCv);
    R.setGlyphs(VZ.paintGlyphs());
    build();
    const buc = VZ.paintHullCell(8, 'galleass', 4, VZ.hullPalettes.buc);
    const gl = R.gl;
    gl.bindTexture(gl.TEXTURE_2D, R.tAtlas);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, buc.x, buc.y, gl.RGBA, gl.UNSIGNED_BYTE, buc.cv);
    [['Burano', 'chronicle written, 2 lessons drafted.'], ['Murano', 'work item 5 of 8 passed its own checks.'], ['Fenice', 'gate failed, 2 of 41 checks. Repairer called.'], ['Lido', 'one open question. Waiting, spending nothing.']].forEach(([a, b]) => { S.clock -= 80; feed(a, b); });
    S.clock += 320;
    selectHull(0, true);
    labels(); syncDial(); renderDetail();
    last = performance.now();
    requestAnimationFrame(frame);
  }

  const ready = document.fonts && document.fonts.load
    ? Promise.race([Promise.all([document.fonts.load('700 66px Cardo'), document.fonts.load('400 12px "B612 Mono"')]), new Promise((r) => setTimeout(r, 1800))])
    : Promise.resolve();
  ready.then(start, start);

  VZ.debug = { S, hulls, stats, get L() { return L; }, get rings() { return rings; }, reduced, step(dt) { update(dt); draw(dt); }, ceremony, approve, reject };
})();
