/* app.js: the fake factory. Lifecycle, decisions, ceremony, render loop.
   In the real system all of this state comes from the host's event log. */
(function () {
  const { clamp, lerp } = V;
  const $ = (id) => document.getElementById(id);
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  V.calm = calm;
  const q = new URLSearchParams(location.search);

  const STN = ['bocca', 'disegno', 'cantiere', 'collaudo', 'varo', 'portolano'];
  const STN_NAME = { bocca: 'Bocca', disegno: 'Disegno', cantiere: 'Cantiere', collaudo: 'Collaudo', varo: 'Varo', portolano: 'Portolano' };
  const STN_PLAIN = { bocca: 'Intake', disegno: 'Contract', cantiere: 'Build', collaudo: 'Prove', varo: 'Launch', portolano: 'Learn' };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

  function seedHulls() {
    return [
      { id: 'aurora', name: 'Aurora', st: 3.72, goal: 4, mode: 'gilt', progress: 1, lamp: 'work', items: '7 of 7', sub: 'A galley, towed to the launch', note: 'Portfolio site', seed: 3, spend: '184 ducats' },
      { id: 'marea', name: 'Marea', st: .24, goal: .24, mode: 'fog', progress: .3, lamp: 'need', items: '0 of 5', q: 2, sub: 'Two open questions before work starts', note: 'Tide table app', seed: 5, spend: '6 ducats' },
      { id: 'sirena', name: 'Sirena', st: 2.9, goal: 2.9, mode: 'leak', progress: 1, lamp: 'fail', items: '9 of 9', sub: 'Gate failed, the repairer is at work', note: 'Invoice tracker', seed: 9, spend: '241 ducats' },
      { id: 'cometa', name: 'Cometa', st: 1.7, goal: 2.02, mode: 'build', progress: 4 / 7, done: 4, of: 7, lamp: 'work', items: '4 of 7', sub: 'Being built, item 5 is in hand', note: 'Recipe box', seed: 13, spend: '97 ducats' },
      { id: 'lido', name: 'Lido', st: .9, goal: .9, mode: 'plain', progress: .55, lamp: 'idle', items: '0 of 3', sub: 'A sketch, moored at the contract', note: 'Link shortener', seed: 17, spend: '11 ducats' },
      { id: 'fenice', name: 'Fenice', st: 5, goal: 5, mode: 'plain', progress: 1, lamp: 'done', items: '6 of 6', sub: 'Finished, chronicle written, unread', note: 'Bird song quiz', seed: 21, spend: '122 ducats' },
    ];
  }
  const S = {
    t: 0, dt: 0, hulls: seedHulls(), sel: null, wind: .6, storm: 0, used: 68, voice: 0, hold: 0, shock: 0,
    fx: 0, fy: 0, effort: 1, rings: [], gates: [], decision: null, queue: [], tess: 9, dark: 1, renown: 1284, tileMax: 16,
    plain: false, script: [],
  };
  V.state = S; S.sel = S.hulls[0];
  let L = null, grid = null;

  /* ---------- geometry ---------- */
  const uOf = (st) => { // st is a station index with fractions, negative runs back towards the gate
    const a = [L.st.bocca, L.st.disegno, L.st.cantiere, L.st.collaudo, L.st.varo, L.st.portolano];
    if (st < 0) return lerp(a[0], 0, -st);
    const i = Math.min(4, Math.floor(st)), f = st - i;
    return lerp(a[i], a[i + 1], f);
  };

  function buildMarks() {
    const m = $('marks'); m.innerHTML = '';
    STN.forEach((id, i) => {
      const p = L.labels[id], d = document.createElement('div'); d.className = 'station'; d.dataset.st = id;
      d.innerHTML = `<i>${ROMAN[i]}</i><span>${(S.plain ? STN_PLAIN : STN_NAME)[id]}</span>`;
      d.style.left = p[0] + 'px'; d.style.top = p[1] + 'px'; m.appendChild(d);
    });
    S.hulls.forEach((h, i) => {
      const b = document.createElement('button'); b.className = 'ban'; b.dataset.i = i; b.setAttribute('aria-label', 'Select ' + h.name);
      b.innerHTML = '<span class="rib"><span>' + h.name + '</span><em></em></span><span class="tie"></span>';
      b.addEventListener('click', () => select(i)); m.appendChild(b); h.el = b; h.badgeEl = b.querySelector('em');
      b.style.pointerEvents = 'auto';
    });
    badges();
  }
  function badge(h) {
    if (h.mode === 'fog') return `${h.q}?`;
    if (h.mode === 'leak') return 'gate ✕';
    if (h.mode === 'gilt') return 'proved';
    if (h.mode === 'build') return `${h.done}/${h.of}`;
    if (h.lamp === 'done') return 'done';
    return h.id === 'lido' ? 'idle' : '';
  }
  function badges() { S.hulls.forEach((h) => { if (!h.badgeEl) return; const b = badge(h); if (h.badgeEl.textContent !== b) h.badgeEl.textContent = b; h.el.classList.toggle('fail', h.mode === 'leak'); h.el.classList.toggle('sel', h === S.sel); }); }

  function layout() {
    const w = $('world'), r = w.getBoundingClientRect();
    const wide = innerWidth >= 1000;
    const short = innerHeight < 520 && innerWidth > innerHeight;
    const usable = wide ? r.height * .71 : short ? r.height - 80 : r.height - 118;
    const dpr = Math.min(2, devicePixelRatio || 1);
    L = V.makeLayout(r.width, r.height, wide ? 'wide' : 'tall', Math.max(short ? 280 : 320, usable));
    grid = V.buildField(L);
    V.drawCity($('city'), L, Math.min(2.5, devicePixelRatio || 1), grid);
    grid = V.buildField(L, $('city'));
    V.water.scale = Math.min(V.water.quality || 2, dpr);
    V.water.field(L, grid);
    V.ships.init($('ships'), L, dpr);
    buildMarks();
    const wb = $('weather'); wb.style.left = (L.wind[0] + (wide ? 44 : 20)) + 'px'; wb.style.top = (L.wind[1] - (wide ? 42 : 36)) + 'px';
    V.deck.paintPlate();
    const g = S.gates; S.gates = [{ u: uOf(3) + .55, open: false, id: 'collaudo' }];
    if (g.length) S.gates[0].open = g[0].open;
    placeAll();
  }
  function placeAll() { S.hulls.forEach((h) => { h.u = uOf(h.st); place(h, 0); }); }
  function place(h, dt) {
    const p = L.at(h.u); h.x = p.x; h.y = p.y; h.s = L.scale(p.y) * (h.id === 'lido' ? .86 : 1);
    const c = Math.cos(p.a);
    h.flip = c < 0; let tl = h.flip ? p.a - Math.PI * Math.sign(p.a || 1) : p.a;
    h.tilt = clamp(tl, -.2, .2) + (h.mode === 'leak' ? (h.flip ? .07 : -.07) : 0);
    h.bob = Math.sin(S.t * 1.1 + h.seed) * .9 * (1 + S.wind) * h.s + (h.mode === 'leak' ? 2.6 * h.s : 0);
    h.heading = p.a;
  }

  /* ---------- feed ---------- */
  const FEED = [];
  function log(html, plainLine, opt) {
    const t = opt && opt.time ? opt.time : clock();
    FEED.unshift({ t, html });
    const f = $('feed'); const li = document.createElement('li'); li.className = 'fresh'; li.innerHTML = `<time>${t}</time><span>${html}</span>`; f.prepend(li);
    while (f.children.length > 12) f.lastChild.remove();
    if (plainLine) tape(plainLine);
  }
  function clock() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function tape(s) { $('tapeText').textContent = s; }

  function detail() {
    const h = S.sel, box = $('detail');
    const stn = (S.plain ? STN_PLAIN : STN_NAME)[STN[clamp(Math.round(h.st), 0, 5)]] || 'Bocca';
    box.innerHTML = `<h2>${h.name}</h2><p class="sub">${h.sub}</p>
      <dl><dt>Project</dt><dd>${h.note}</dd><dt>Station</dt><dd>${stn}</dd><dt>Work items</dt><dd>${h.items}</dd>
      <dt>Evidence</dt><dd>${h.mode === 'gilt' ? 'Gate passed, receipt 7f3a c91e' : h.mode === 'leak' ? '3 tests fail in checkout' : 'None yet'}</dd><dt>Spent</dt><dd>${h.spend}</dd></dl>`;
  }
  function select(i) {
    S.sel = S.hulls[i]; V.audio.unlock();
    // Green is a to-do. It clears when you look.
    if (S.sel.lamp === 'done') S.sel.lamp = 'idle';
    tape(`${S.sel.name}: ${S.sel.sub}.`);
    detail(); lampsNow(); badges();
  }
  function lampsNow() { S.hulls.forEach((h, i) => V.deck.lamp(i, h, h === S.sel)); }

  /* ---------- HUD ---------- */
  const TILE_ROT = [-5, 3, -2, 6, -4, 2, 5, -6, 3, -3, 4, -2, 6, -5, 2, 4, -4, 3, -6, 5];
  function tiles() {
    const el = $('tess'), m = $('mosaic'); el.innerHTML = '';
    for (let i = 0; i < S.tess; i++) { const t = document.createElement('i'); t.className = 't'; t.style.setProperty('--r', TILE_ROT[i % 20] + 'deg'); el.appendChild(t); }
    for (let i = 0; i < S.dark; i++) { const t = document.createElement('i'); t.className = 't dull'; t.style.setProperty('--r', '3deg'); el.appendChild(t); }
    m.innerHTML = '';
    const r = V.rng(44);
    for (let i = 0; i < 120 + S.tess; i++) { const t = document.createElement('i'); t.className = 't' + (r() < .07 ? ' dull' : ''); t.style.setProperty('--r', (r() * 12 - 6).toFixed(1) + 'deg'); m.appendChild(t); }
  }
  function earn() {
    S.tess++;
    const el = $('tess'), t = document.createElement('i'); t.className = 't new'; t.style.setProperty('--r', TILE_ROT[S.tess % 20] + 'deg');
    el.insertBefore(t, el.querySelector('.dull')); V.audio.tessera();
  }
  function renown(to) {
    const from = S.renown, t0 = performance.now(); S.renown = to;
    (function up() { const k = clamp((performance.now() - t0) / 900, 0, 1); $('ren').textContent = Math.round(lerp(from, to, k)).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(up); })();
  }
  function meter() { const m = $('meter'); if (!m.children.length) for (let i = 0; i < 20; i++) m.appendChild(document.createElement('i')); const left = 100 - S.used; [...m.children].forEach((e, i) => e.classList.toggle('on', i < Math.round(left / 5))); }
  function weather() {
    const u = S.used;
    const nm = u < 50 ? 'Clear' : u < 75 ? 'Wind' : u < 90 ? 'Gale' : 'Storm';
    const pl = u < 50 ? 'Plenty left' : u < 75 ? 'Getting used' : u < 90 ? 'Running low' : 'Nearly out';
    S.windT = u < 50 ? .08 : u < 75 ? .55 : u < 90 ? .85 : 1; S.stormT = u < 50 ? 0 : u < 75 ? 0 : u < 90 ? .22 : 1;
    $('tre').textContent = Math.max(0, Math.round(100 - u)) + '%';
    $('wname').textContent = S.plain ? pl : nm; $('wval').textContent = Math.round(u) + '% used, refills 1h 12m';
    meter();
  }

  /* ---------- decisions ---------- */
  const D_AURORA = { id: 'pub-aurora', hull: 'aurora', tier: 3, kick: 'Public · hold to approve', title: 'Aurora wants to publish to GitHub Pages.', body: '14 files, public link. Gate passed.', files: 14 };
  const D_MAREA = { id: 'q-marea', hull: 'marea', tier: 0, kick: 'Question 1 of 2 · approve or reject', title: 'Should Marea sign in by email link?', body: 'Recommended. Reject to choose passwords.' };
  const D_SIRENA = { id: 'fix-sirena', hull: 'sirena', tier: 0, kick: 'Gate failed twice · approve or reject', title: 'Let the repairer try Sirena once more?', body: '3 tests fail in checkout. Up to 40 ducats.' };
  const D_SIRENA_PUB = { id: 'pub-sirena', hull: 'sirena', tier: 3, kick: 'Public · hold to approve', title: 'Sirena wants to publish to GitHub Pages.', body: '22 files, public link. Gate passed.', files: 22 };

  function offer(d) {
    if (S.decision) { S.queue.push(d); return; }
    S.decision = d; const h = S.hulls.find((x) => x.id === d.hull);
    $('cKick').textContent = d.kick; $('cTitle').textContent = d.title; $('cBody').textContent = d.body;
    $('ring').hidden = d.tier < 3;
    $('card').setAttribute('aria-hidden', 'false');
    const card = $('card'); card.classList.remove('out'); card.classList.add('up');
    $('tape').classList.add('hide');
    $('approve').classList.add('want');
    $('appLabel').textContent = d.tier >= 3 ? 'Hold' : 'Approve';
    h.lamp = 'need'; lampsNow(); S.sel = h; lampsNow(); badges(); detail();
    V.audio.pregadi(); V.haptic([12, 60, 12]);
  }
  function closeCard() {
    const card = $('card'); card.classList.remove('up'); card.classList.add('out');
    card.setAttribute('aria-hidden', 'true');
    $('tape').classList.remove('hide'); $('approve').classList.remove('want'); $('appLabel').textContent = 'Approve';
    setTimeout(() => card.classList.remove('out'), 400);
    S.decision = null;
    if (S.queue.length) { const n = S.queue.shift(); after(calm ? 4 : 2.6, () => offer(n)); }
  }
  const after = (sec, fn) => S.script.push({ at: S.t + sec, fn });

  /* The ring. Silence never approves: only a held press does, and only a release fires it. */
  const hold = { on: false, p: 0, locked: false };
  function holdDown() {
    const d = S.decision; if (!d || d.tier < 3 || hold.on) return;
    V.audio.unlock(); hold.on = true; hold.locked = false; $('ring').classList.add('down'); V.audio.holdStart(); V.haptic(10);
    $('ringLabel').textContent = '';
  }
  function holdUp() {
    if (!hold.on) return; hold.on = false; $('ring').classList.remove('down'); V.audio.holdStop();
    if (hold.locked) { ceremony(); } else { $('ringLabel').textContent = 'Hold'; tape('Hold the ring for two seconds to publish.'); }
  }
  function ceremony() {
    const d = S.decision, h = S.hulls.find((x) => x.id === d.hull);
    const rb = $('ring').getBoundingClientRect(), wb = $('world').getBoundingClientRect();
    V.ships.ringFall = { k: 0, x0: rb.left - wb.left + rb.width / 2, y0: rb.top - wb.top + rb.height / 2, x1: h.x, y1: h.y + 14 * h.s, r0: rb.width * .31 };
    $('ring').classList.remove('lock'); hold.locked = false; hold.p = 0;
    closeCard(); S.pause = true;
    const dur = calm ? .01 : .72;
    S.ceremony = { h, d, t0: S.t, step: 0, dur };
  }
  function ceremonyTick() {
    const C = S.ceremony; if (!C) return;
    const el = S.t - C.t0, h = C.h, d = C.d;
    if (V.ships.ringFall) { V.ships.ringFall.k = el / C.dur; }
    if (C.step === 0 && el >= C.dur) {
      C.step = 1; V.ships.ringFall = null;
      V.audio.splash(); V.audio.marangona(); V.haptic([30, 40, 80]);
      if (!calm) for (let i = 0; i < 6; i++) S.rings.push({ x: h.x, y: h.y + 12 * h.s, r: 0, delay: i * .62, life: 0, str: 1 - i * .08 });
      S.shock = 1; h.lamp = 'done'; h.sub = 'Published, live check passed'; lampsNow(); badges(); detail();
      $('sensaPlain').textContent = `${h.name} is published. Live check passed.`;
      $('sensaLink').textContent = `doge.github.io/venezia-sites/${h.id}`;
      $('sensa').classList.add('on'); document.body.classList.add('sensa'); h.el.classList.add('hero');
      log(`<b>${h.name}</b> married to the sea. ${d.files} files, live check passed.`, `${h.name} published. ${d.files} files, live check passed.`);
      V.ships.buc = { x: L.W + 170, y: lagoonY(), s: L.mode === 'wide' ? 1.2 : Math.min(.74, L.W / 520), a: 1, reveal: calm ? 1 : .15, gone: false };
      S.fleet = true;
    }
    if (C.step === 1 && el >= C.dur + 2.6) { C.step = 2; earn(); renown(S.renown + 40); log('A gold tessera is set. Renown 40, for a launch that passed its live check.'); }
    if (C.step === 2 && el >= C.dur + 8.5) {
      C.step = 3; $('sensa').classList.remove('on'); document.body.classList.remove('sensa'); h.el.classList.remove('hero'); if (V.ships.buc) V.ships.buc.gone = true;
      h.mode = 'plain'; h.gild = 0; h.goal = d.id === 'pub-aurora' ? 4.28 : 4; h.lamp = 'done'; h.towing = true; badges();
      after(10, () => { h.towing = false; });
      S.ceremony = null;
      if (d.id === 'pub-aurora') { after(3, () => offer(D_MAREA)); }
      if (d.id === 'pub-sirena') { after(16, reseed); }
    }
  }
  function lagoonY() { return L.mode === 'wide' ? L.usable * .86 : Math.min(L.H - 40, L.usable + 44); }
  function reseed() {
    S.hulls = seedHulls(); S.sel = S.hulls[0]; placeAll(); V.deck.buildLamps(S.hulls, select); buildMarks(); lampsNow(); S.gates[0].open = false; detail(); opening();
  }

  /* ---------- the day's script ---------- */
  function opening() {
    const a = S.hulls[0]; a.towing = true; a.gild = 0; a.st = 3.72;
    after(calm ? .1 : .4, () => { a.goal = 4; });
    after(calm ? .4 : 2.6, () => { a.towing = false; a.lamp = 'need'; lampsNow(); log('<b>Aurora</b> took her last window. Gate passed, receipt issued.', 'Aurora: gate passed, receipt issued.'); });
    after(calm ? .6 : 3.1, () => offer(D_AURORA));
    after(7, () => feedItem(S.hulls[3]));
  }
  function feedItem(h) {
    if (h.mode !== 'build' || h.done >= h.of) { return; }
    const station = L.at(uOf(2));
    V.ships.parcels.push({ k: 0, dur: 1.1, x0: station.x + 16 * L.scale(station.y), y0: station.y - L.canal / 2 - 6, x1: () => h.x, y1: () => h.y - 10 * h.s, done() {
      h.done++; h.progress = h.done / h.of; h.items = `${h.done} of ${h.of}`; h.sub = h.done < h.of ? `Being built, item ${h.done + 1} is in hand` : 'Built, towed to the gate'; badges(); detail();
      V.audio.detent(true);
      log(`<b>Cometa</b> took item ${h.done} of ${h.of} from the window.`, `Cometa: item ${h.done} of ${h.of} handed over.`);
      if (h.done === h.of) { h.mode = 'plain'; h.goal = 2.08; h.towing = true; after(12, () => { h.towing = false; h.lamp = 'idle'; }); return; }
      after([14, 9, 7, 5][S.effort], () => feedItem(h));
    } });
  }
  V.onEffort = (i) => { S.effort = i; const nm = ['low', 'medium', 'high', 'max'][i]; tape(`Next worker will think at ${nm} effort.`); };

  function resolve(ok) {
    const d = S.decision; if (!d) return;
    const h = S.hulls.find((x) => x.id === d.hull);
    if (d.id === 'q-marea') {
      if (ok) { tape('Marea: email link chosen. One question left.'); log('<b>Marea</b> will use email links. One question answered, one to go.'); } else { tape('Marea: passwords chosen. One question left.'); log('<b>Marea</b> will use passwords. One question answered, one to go.'); }
      h.q = 1; badges();
      after(1.2, () => { h.q = 0; h.mode = 'plain'; h.fogFade = 1; h.lamp = 'work'; h.progress = .55; h.goal = .3; h.towing = true; h.sub = 'Fog lifted, contract being written'; lampsNow(); badges(); detail(); log('<b>Marea</b>: the second question took its recommended default. The fog lifts.'); });
      after(14, () => { h.towing = false; h.lamp = 'idle'; lampsNow(); });
      closeCard(); after(4, () => offer(D_SIRENA)); return;
    }
    if (d.id === 'fix-sirena') {
      closeCard();
      if (!ok) { tape('Sirena stays where she is. No spend.'); log('<b>Sirena</b> held. Blocked means zero spend.'); return; }
      tape('Sirena: repairer sent in, up to 40 ducats.'); log('<b>Sirena</b>: the Calafato goes aboard with a fresh context.');
      after(7, () => {
        h.mode = 'gilt'; h.gild = 0; h.sub = 'Gate passed on the third run'; h.lamp = 'work'; S.gates[0].open = true; h.goal = 3.82; h.towing = true; lampsNow(); badges(); detail(); earn(); renown(S.renown + 10);
        log('<b>Sirena</b> passed her gate. A gold tessera is set.', 'Sirena: gate passed on the third run.');
      });
      after(13, () => { h.towing = false; offer(D_SIRENA_PUB); });
      return;
    }
    if (d.tier >= 3 && !ok) {
      closeCard(); tape(`${h.name} stays at the launch. Nothing was published.`); log(`<b>${h.name}</b> held at the launch. Nothing was published.`);
      after(calm ? 3 : 11, () => offer(d));
    }
  }

  /* ---------- controls ---------- */
  function wire() {
    V.deck.buildLamps(S.hulls, select); V.deck.initDial();
    const ringT = V.deck.travel($('ring'), { pitch: .7, down: holdDown, up: holdUp });
    const app = V.deck.travel($('approve'), { pitch: 1, down: () => { if (S.decision && S.decision.tier >= 3) holdDown(); }, up: () => { if (hold.on) holdUp(); else if (S.decision && S.decision.tier < 3) resolve(true); } });
    const rej = V.deck.travel($('reject'), { pitch: .78, down: () => {}, up: () => { if (!hold.on) resolve(false); } });
    const talk = V.deck.travel($('talk'), { pitch: .9, down: talkDown, up: talkUp });
    $('snd').addEventListener('click', () => { V.audio.unlock(); const on = V.audio.toggle(); $('snd').setAttribute('aria-pressed', on); });
    $('plain').addEventListener('click', () => { S.plain = !S.plain; $('plain').setAttribute('aria-pressed', S.plain); applyPlain(); });
    const levels = [47, 68, 84, 93]; let li = 1;
    $('weather').addEventListener('click', () => { V.audio.unlock(); li = (li + 1) % 4; S.used = levels[li]; weather(); V.audio.detent(true); tape(`Rate limit: ${S.used}% of this window used.`); });
    addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      if (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'slider' && e.key.startsWith('Arrow')) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '6') { V.deck.lampEls[+k - 1].classList.add('down'); V.audio.unlock(); V.audio.key(true, 1.1); select(+k - 1); }
      else if (k === 'y') app.down(e); else if (k === 'n') rej.down(e);
      else if (k === ' ') { e.preventDefault(); talk.down(e); }
      else if (k === '[') V.deck.setEffort(V.deck.effort - 1); else if (k === ']') V.deck.setEffort(V.deck.effort + 1);
    });
    addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '6') { V.deck.lampEls[+k - 1].classList.remove('down'); V.audio.key(false, 1.1); }
      else if (k === 'y') app.up(e); else if (k === 'n') rej.up(e); else if (k === ' ') talk.up(e);
    });
    let rs; new ResizeObserver(() => { clearTimeout(rs); rs = setTimeout(layout, 120); }).observe($('world'));
  }
  function applyPlain() {
    document.querySelectorAll('[data-f]').forEach((e) => { e.textContent = S.plain ? e.dataset.p : e.dataset.f; });
    document.querySelectorAll('.station').forEach((e) => { e.querySelector('span').textContent = (S.plain ? STN_PLAIN : STN_NAME)[e.dataset.st]; });
    $('rank').textContent = S.plain ? 'Level 2' : 'Marangone'; weather(); detail();
  }

  /* Voice. Your voice physically disturbs the water around the selected hull. */
  const NOTES = ['use a darker theme', 'add a footer with the date', 'make the buttons larger', 'keep it to one page'];
  let ni = 0, talking = false, talkT = 0;
  function talkDown() { talking = true; talkT = S.t; $('deck').classList.add('talking'); $('talkLabel').textContent = 'Listening'; V.audio.unlock(); V.audio.ctx && V.audio.micStart(); }
  function talkUp() {
    talking = false; $('deck').classList.remove('talking'); $('talkLabel').textContent = 'Hold to talk';
    if (S.t - talkT < .28) { tape('Hold the key while you speak.'); return; }
    const h = S.sel, n = NOTES[ni++ % NOTES.length];
    tape(`Note for ${h.name}: "${n}". She reads it at the next window.`);
    log(`A note to <b>${h.name}</b>: "${n}". It waits in her box for the next window.`);
    S.rings.push({ x: h.x, y: h.y + 6 * h.s, r: 0, delay: 0, life: 0, str: .5, small: true });
  }
  function voiceLevel(t) {
    const m = V.audio.micLevel();
    if (m >= 0) return m;
    // no microphone: syllables at speech rate, so the visual still reads as speech
    const syl = Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.3 + 1)) * (.55 + .45 * Math.sin(t * 13.1));
    return clamp(syl * 1.2, 0, 1);
  }

  /* ---------- the loop ---------- */
  let last = 0, ft = 16, slow = 0, frames = 0, fpsT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (calm && now - last < 200) return;
    const t0 = performance.now();
    const dt = Math.min(calm ? .3 : .05, (now - last) / 1000 || .016); last = now;
    S.dt = dt; S.t += dt;
    const shaderT = calm ? 12 : S.t;

    // scheduled life
    for (let i = S.script.length - 1; i >= 0; i--) if (S.script[i].at <= S.t) { const s = S.script.splice(i, 1)[0]; s.fn(); }
    ceremonyTick();

    // the hold
    if (hold.on) {
      hold.p = clamp(hold.p + (S.ceremony ? 0 : dt / 2), 0, 1);
      if (hold.p >= 1 && !hold.locked) { hold.locked = true; $('ring').classList.add('lock'); $('ringLabel').textContent = 'Let go'; V.audio.lock(); V.haptic(30); }
    } else if (!S.ceremony && hold.p > 0) hold.p = Math.max(0, hold.p - dt * 3);
    $('ringArc').setAttribute('stroke-dasharray', `${(hold.p * 100).toFixed(1)} 100`);

    // weather drifts up with real use, faster at higher effort
    S.used = clamp(S.used + dt * (.0035 + S.effort * .0045), 0, 99);
    S.wind = lerp(S.wind, S.windT, 1 - Math.exp(-dt * 1.4)); S.storm = lerp(S.storm, S.stormT, 1 - Math.exp(-dt * 1.4));
    if (Math.floor(S.t) !== S.tick) { S.tick = Math.floor(S.t); weather(); }

    // hulls
    const W = V.water;
    S.hulls.forEach((h, i) => {
      const gu = uOf(h.goal), du = gu - uOf(h.st);
      const speed = (.042 + .018 * S.effort) * dt * (h.towing ? 1 : .8);
      const was = h.st;
      if (Math.abs(h.goal - h.st) > .002) h.st += Math.sign(h.goal - h.st) * Math.min(Math.abs(h.goal - h.st), speed * (calm ? 30 : 1));
      else h.st = h.goal;
      h.moving = h.st !== was;
      h.u = uOf(h.st); place(h, dt);
      if (h.mode === 'gilt') h.gild = clamp((h.gild || 0) + dt * .7, 0, 1);
      if (h.fogFade > 0) h.fogFade = clamp(h.fogFade - dt * .4, 0, 1);
      W.hA[i * 4] = h.x; W.hA[i * 4 + 1] = h.y + 1 * h.s; W.hA[i * 4 + 2] = 50 * h.s * 1.06; W.hA[i * 4 + 3] = h.moving ? 1 : 0;
      W.hB[i * 4] = Math.cos(h.tilt) * (h.flip ? -1 : 1); W.hB[i * 4 + 1] = Math.sin(h.tilt) * (h.flip ? -1 : 1);
      W.hB[i * 4 + 2] = h.mode === 'gilt' ? (h.gild || 0) : 0; W.hB[i * 4 + 3] = h.mode === 'leak' ? 1 : 0;
      if (h.el) {
        const by = h.y - (h.progress >= 1 ? 62 : h.progress >= .7 ? 56 : h.progress >= .5 ? 50 : 26) * h.s + h.bob - (L.mode === 'wide' ? 30 : 26);
        const elw = h.elw || (h.elw = h.el.offsetWidth);
        const bx = clamp(h.x + (h.flip ? -1 : 1) * 4 * h.s - elw / 2, 3, L.W - elw - 3);
        h.el.style.transform = `translate3d(${bx.toFixed(1)}px,${by.toFixed(1)}px,0)`;
      }
    });
    S.fx = S.ceremony ? S.ceremony.h.x : hold.on || hold.p > 0 ? (S.decision ? S.hulls.find((x) => x.id === S.decision.hull).x : S.sel.x) : S.sel.x;
    S.fy = S.ceremony ? S.ceremony.h.y : hold.on || hold.p > 0 ? (S.decision ? S.hulls.find((x) => x.id === S.decision.hull).y : S.sel.y) : S.sel.y;

    // rings
    const reach = Math.hypot(L.W, L.H) * 1.6, spd = L.mode === 'wide' ? 150 : 86;
    S.rings = S.rings.filter((r) => { r.delay -= dt; if (r.delay > 0) return true; r.life += dt; r.r += dt * spd * (r.small ? .7 : 1); return r.small ? r.r < 90 : r.r < reach; });
    W.rg.fill(0);
    S.rings.slice(0, 6).forEach((r, i) => {
      if (r.delay > 0) return;
      W.rg[i * 4] = r.x; W.rg[i * 4 + 1] = r.y; W.rg[i * 4 + 2] = r.r;
      W.rg[i * 4 + 3] = r.str * clamp(1 - r.r / (r.small ? 90 : reach), 0, 1) * clamp(r.life * 5, 0, 1);
    });
    S.shock = Math.max(0, S.shock - dt * .55);

    // Bucintoro
    const B = V.ships.buc;
    if (B) {
      const home = L.W * (L.mode === 'wide' ? .62 : .56);
      if (B.gone) { B.x -= dt * 26; B.a -= dt * .35; if (B.a <= 0) V.ships.buc = null; }
      else { B.x = calm ? home : lerp(B.x, home, 1 - Math.exp(-dt * .9)); B.reveal = clamp(B.reveal + dt * .7, 0, 1); }
    }

    // voice
    const v = talking ? voiceLevel(S.t) : 0;
    S.voice = lerp(S.voice, v, 1 - Math.exp(-dt * 18));
    V.deck.vox(S.voice, S.t, talking || S.voice > .02);

    S.hold = hold.p * hold.p * (3 - 2 * hold.p);
    const drawT = S.t;
    S.t = shaderT; W.ok ? W.render(S) : 0; S.t = drawT;
    V.ships.frame(S);
    S.hulls.forEach((h, i) => V.deck.lampPulse(i, h, S.t, calm));

    // keep a phone at 60: cut water resolution rather than the line count
    V.jsMs = lerp(V.jsMs || 0, performance.now() - t0, .05);
    frames++; if (now - fpsT > 1000) { V.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
    ft = lerp(ft, dt * 1000, .05);
    if (!q.has('fixed') && !calm) {
      slow = ft > 24 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 90 && W.scale > 1.1) { W.scale = Math.max(1.1, W.scale - .3); W.quality = W.scale; W.resize(); slow = 0; }
    }
  }

  function start() {
    if (!V.water.init($('water'))) document.body.classList.add('nogl');
    wire(); tiles(); weather();
    layout(); detail(); lampsNow();
    log('<b>Cometa</b> took item 4 of 7 from the window.', 'Cometa: item 4 of 7 handed over.', { time: '21:58' });
    log('<b>Sirena</b> failed her gate. 3 tests fail in checkout. A dark tile is set, honestly.', null, { time: '21:49' });
    log('<b>Lido</b> skipped contract review, a well-defined sketch.', null, { time: '21:41' });
    log('<b>Fenice</b> reached the Portolano. Chronicle written, 2 lessons drafted.', null, { time: '21:32' });
    log('<b>Marea</b> entered at the Bocca with two open questions.', null, { time: '21:20' });
    const f = $('feed'); [...f.children].reverse().forEach((c) => f.appendChild(c));
    tape('Cometa: item 4 of 7 handed over.');
    opening();
    requestAnimationFrame(frame);
  }
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(start);
  addEventListener('error', (e) => { console.error('runtime', e.message); });
})();
