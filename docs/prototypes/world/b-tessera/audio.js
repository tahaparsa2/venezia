/* Sound is glass on stone, water and bells. All synthesised. */
(function () {
  const VZ = (window.VZ = window.VZ || {});
  const A = (VZ.audio = {
    ctx: null, on: true,
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const ctx = (this.ctx = new C());
      this.master = ctx.createGain(); this.master.gain.value = 0.8;
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(ctx.destination);
      /* short stone room */
      const len = ctx.sampleRate * 1.8, ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
      this.verb = ctx.createConvolver(); this.verb.buffer = ir;
      this.wet = ctx.createGain(); this.wet.gain.value = 0.3;
      this.verb.connect(this.wet); this.wet.connect(this.master);
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      this.noiseBuf = nb;
      /* water bed */
      const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0.018;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lg = ctx.createGain(); lg.gain.value = 0.008;
      lfo.connect(lg); lg.connect(g.gain); lfo.start();
      s.connect(f); f.connect(g); g.connect(this.master); s.start();
      this.bed = g;
    },
    out(wet) { const n = this.ctx.createGain(); n.connect(this.master); if (wet) n.connect(this.verb); return n; },
    tone(f, t, dur, gain, type, wet) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.out(wet)); o.start(t); o.stop(t + dur + 0.05);
    },
    burst(t, dur, freq, q, gain) {
      const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.out(false)); s.start(t, Math.random()); s.stop(t + dur + 0.02);
    },
    /* a thick glass tile bottoming out in its seat */
    press(pitch) {
      if (!this.ctx) return; const t = this.ctx.currentTime, p = pitch || 1;
      this.burst(t, 0.03, 2900 * p, 6, 0.35);
      this.tone(165 * p, t, 0.07, 0.5);
      this.tone(2120 * p, t, 0.11, 0.05);
    },
    release(pitch) {
      if (!this.ctx) return; const t = this.ctx.currentTime, p = pitch || 1;
      this.burst(t, 0.02, 4300 * p, 8, 0.14);
      this.tone(3100 * p, t, 0.06, 0.02);
    },
    tick(p) { if (!this.ctx) return; const t = this.ctx.currentTime; this.burst(t, 0.014, 5200 * (p || 1), 9, 0.24); },
    /* Partials loosely follow a large bell, hum note first */
    bell(f0, gain, dur) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      [[0.5, 1], [1, 0.8], [1.19, 0.55], [1.5, 0.35], [2, 0.42], [2.51, 0.2], [2.98, 0.14], [4.09, 0.08]].forEach(([r, a], i) => {
        this.tone(f0 * r, t, dur * (1 - i * 0.08), gain * a, 'sine', true);
      });
    },
    pregadi() { this.bell(440, 0.13, 1.5); },
    marangona() { this.bell(147, 0.34, 6); setTimeout(() => this.bell(147, 0.22, 5), 1400); },
    gold() { if (!this.ctx) return; const t = this.ctx.currentTime; [1760, 2637, 3520].forEach((f, i) => this.tone(f, t + i * 0.05, 0.7, 0.05, 'sine', true)); },
    dull() { if (!this.ctx) return; const t = this.ctx.currentTime; this.tone(92, t, 0.34, 0.4, 'sine', true); this.burst(t, 0.1, 620, 2, 0.2); },
    splash() { if (!this.ctx) return; const t = this.ctx.currentTime; this.burst(t, 0.6, 900, 0.7, 0.7); this.tone(82, t, 0.5, 0.5); },
    droneOn() {
      if (!this.ctx || this.dr) return;
      const c = this.ctx, g = c.createGain(); g.gain.value = 0;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
      const os = [98, 146.8, 196, 293.7].map((fr, i) => { const o = c.createOscillator(); o.type = i % 2 ? 'triangle' : 'sawtooth'; o.frequency.value = fr; o.detune.value = (i - 1.5) * 4; o.connect(f); o.start(); return o; });
      f.connect(g); g.connect(this.out(true));
      this.dr = { g, f, os };
    },
    droneSet(v) {
      if (!this.dr) return; const t = this.ctx.currentTime;
      this.dr.g.gain.setTargetAtTime(v * 0.085, t, 0.05);
      this.dr.f.frequency.setTargetAtTime(240 + v * 2300, t, 0.08);
      this.dr.os.forEach((o) => o.detune.setTargetAtTime((v * v) * 120, t, 0.1));
    },
    droneOff() {
      if (!this.dr) return; const d = this.dr; this.dr = null;
      const t = this.ctx.currentTime;
      d.g.gain.setTargetAtTime(0, t, 0.09);
      setTimeout(() => d.os.forEach((o) => { try { o.stop(); } catch (e) {} }), 600);
    },
    weather(v) { if (this.bed) this.bed.gain.setTargetAtTime(0.014 + v * 0.05, this.ctx.currentTime, 0.8); },
  });
})();
