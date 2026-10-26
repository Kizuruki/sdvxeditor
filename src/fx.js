/* ============================================================================
 * Audible chart effects: FX hold effects (Retrigger, Gate, Flanger, ...) and the
 * laser filter (peak / lpf1 / hpf1 / bitc), ported from USC's DSP.cpp,
 * AudioEffects.cpp and AudioPlayback.cpp (MIT licence).
 *
 * The music is played by an AudioWorklet that owns the PCM. It knows the exact
 * song position of every output sample, so effects line up with the chart to
 * the sample. The chart is compiled into a small schedule (song seconds) on
 * the main thread and posted to the worklet whenever it changes.
 * ========================================================================== */
const KSMFX = (() => {
	// --- effect string -> {type, p0, p1}   (USC BeatmapFromKSH ParseFXAndParameters + defaults)
	const DEFAULT_P = { BitCrusher: 4, Gate: 8, Retrigger: 8, Phaser: 2000, Flanger: 2000, Wobble: 12, SideChain: 8, TapeStop: 50, Echo: 4, PitchShift: 12 };
	const TYPES = new Set(['Retrigger', 'Gate', 'Flanger', 'Phaser', 'BitCrusher', 'Wobble', 'SideChain', 'Echo', 'TapeStop', 'PitchShift']);
	function parseDefines(defs) { // '#define_fx name type=Retrigger;waveLength=1/8;...'
		const out = {};
		for (const line of defs || []) {
			const m = /^#define_(fx|filter)\s+(\S+)\s+(.*)$/.exec(line.trim());
			if (!m) continue;
			const kv = {};
			for (const part of m[3].split(';')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
			out[m[1] + ':' + m[2]] = kv;
		}
		return out;
	}
	const frac = (s) => { if (!s) return NaN; const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s); return m ? +m[1] / +m[2] : parseFloat(s); };
	function parseEffect(str, defines) {
		if (!str) return null;
		const parts = String(str).split(';').map(s => s.trim());
		let name = parts[0], p0 = parts[1] !== undefined && parts[1] !== '' ? parseInt(parts[1], 10) : NaN, p1 = parts[2] !== undefined ? parseInt(parts[2], 10) : NaN;
		if (!TYPES.has(name)) {
			const d = defines && defines['fx:' + name];
			if (!d || !TYPES.has(d.type)) return null;
			const wl = frac(d.waveLength);
			if (!Number.isFinite(p0) && wl > 0) p0 = Math.round(1 / wl);
			if (!Number.isFinite(p1) && d.feedbackLevel) p1 = Math.round(parseFloat(d.feedbackLevel) * (d.feedbackLevel.includes('%') ? 1 : 100));
			name = d.type;
		}
		if (!Number.isFinite(p0)) p0 = DEFAULT_P[name] ?? 0;
		if (!Number.isFinite(p1)) p1 = name === 'Echo' ? 60 : 0;
		return { type: name, p0, p1 };
	}
	function filterKind(v, defines) {
		v = String(v || 'peak').trim();
		if (v === 'peak' || v === 'lpf1' || v === 'hpf1') return v;
		if (v === 'bitc' || v === 'fx;bitc') return 'bitc';
		const d = defines && defines['filter:' + v];
		if (d && d.type) return ({ PeakingFilter: 'peak', LowPassFilter: 'lpf1', HighPassFilter: 'hpf1', BitCrusher: 'bitc' })[d.type] || 'peak';
		return 'peak';
	}

	// --- chart -> schedule (all times in song seconds)
	const ENV_RATE = 240; // laser filter envelope samples per second
	function buildSchedule(ed) {
		const ch = ed.chart, tm = ed.timing, S = (t) => ed.songTimeOf(t);
		const defines = parseDefines(ch.defs);
		const holds = [[], []];
		ch.fx.forEach((lane, li) => lane.forEach(n => {
			if (!(n.l > 0) || !n.fx) return;
			const e = parseEffect(n.fx, defines); if (!e) return;
			const bpm = tm.bpmAt(n.t), bp = K.lastAtOrBefore(ch.bpm, n.t);
			holds[li].push({ s: S(n.t), e: S(n.t + n.l), type: e.type, p0: e.p0, p1: e.p1, whole: 240 / bpm, tp: S(bp ? (ch.bpm.indexOf(bp) === 0 ? 0 : bp.t) : 0) });
		}));
		const steps = (arr, init, conv) => { const out = [{ s: -1e9, v: init }]; for (const p of arr) out.push({ s: S(p.t), v: conv(p.v) }); return out; };
		const filters = steps(ch.filterType, filterKind(ch.meta.filtertype, defines), v => filterKind(v, defines));
		const pg = (v) => K.clamp((parseFloat(v) || 0) / 100, 0, 1);
		const mixes = steps(ch.pfilterGain, pg(ch.meta.pfiltergain === undefined || ch.meta.pfiltergain === '' ? 50 : ch.meta.pfiltergain), pg);
		// laser filter input: max over lanes of the knob position (L: 0 at left, R: 0 at right), USC Scoring::m_GetLaserOutputRaw
		let end = 0;
		for (const lane of ch.laser) if (lane.length) end = Math.max(end, K.sectionEndTick(lane[lane.length - 1]));
		const t0 = S(0), t1 = S(end) + 0.5;
		const n = Math.max(1, Math.ceil((t1 - t0) * ENV_RATE) + 1);
		const env = new Float32Array(n), act = new Uint8Array(n);
		if (end > 0) {
			const ptr = [0, 0];
			let out = 0, src = 0, tgt = 0, since = 1;
			for (let k = 0; k < n; k++) {
				const tick = ed.tickOfSong(t0 + k / ENV_RATE);
				let raw = 0, any = false;
				for (let li = 0; li < 2; li++) {
					const arr = ch.laser[li];
					while (ptr[li] < arr.length && K.sectionEndTick(arr[ptr[li]]) < tick) ptr[li]++;
					const s = arr[ptr[li]]; if (!s || tick < s.t) continue;
					const lp = s.pts[s.pts.length - 1];
					if (tick >= s.t + lp.ry) continue; // past the last point (or in a final slam)
					const v = K.laserValueAt(s, Math.floor(tick)); if (v === null) continue;
					any = true;
					let p = v / 50; if (li === 1) p = 1 - p;
					raw = Math.max(raw, p);
				}
				// USC smooths changes over 0.1 s
				since += 1 / ENV_RATE;
				if (raw !== tgt) { src = src + (tgt - src) * Math.min(1, since / 0.1); tgt = raw; since = 0; }
				out = src + (tgt - src) * Math.min(1, since / 0.1);
				env[k] = out; act[k] = any ? 1 : 0;
			}
		}
		return { holds, filters, mixes, env: { t0, rate: ENV_RATE, v: env, a: act } };
	}

	// --- AudioWorklet (runs on the audio thread; serialised with toString)
	function WORKLET() {
		const easeInExpo = (t) => { const i = 1 - t; return 3 * i * i * t * 0.05 + 3 * i * t * t * 0.035 + t * t * t; };
		const easeOutCubic = (t) => { const i = 1 - t; return 3 * i * i * t * 0.61 + 3 * i * t * t * 1 + t * t * t; };
		class BQF {
			constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [0, 0, 0, 0]; }
			_set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
			lowPass(q, f, sr) { q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
			highPass(q, f, sr) { q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
			allPass(q, f, sr) { q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set(1 - al, -2 * c, 1 + al, 1 + al, -2 * c, 1 - al); }
			peaking(q, f, g, sr) { q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, g / 40); this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A); }
			highShelf(q, f, g, sr) {
				q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, g / 40), s = 2 * Math.sqrt(A) * al;
				this._set(A * ((A + 1) + (A - 1) * c + s), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - s), (A + 1) - (A - 1) * c + s, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - s);
			}
			copyCoef(o) { this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2; }
			run(x) { const z = this.z, y = this.b0 * x + this.b1 * z[0] + this.b2 * z[1] - this.a1 * z[2] - this.a2 * z[3]; z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y; return y; }
		}
		// Every DSP: process(L, R, i0, i1, ctx) on samples [i0, i1) of the block; ctx = {sr, rate, pos (song s per sample), pcm}
		const DSPS = {
			BitCrusher(o) { // period in 44.1k samples
				const st = { dur: 0, hl: 0, hr: 0, period: 0, mix: o.mix ?? 1 };
				st.set = (p, sr) => { st.period = Math.floor(sr / 44100 * p * 65536); };
				st.set(o.p0, o.sr);
				st.process = (L, R, a, b) => { for (let i = a; i < b; i++) { st.dur += 65536; if (st.dur > st.period) { st.hl = L[i]; st.hr = R[i]; st.dur -= st.period; } L[i] = st.hl * st.mix + L[i] * (1 - st.mix); R[i] = st.hr * st.mix + R[i] * (1 - st.mix); } };
				return st;
			},
			Gate(o) {
				const len = Math.max(2, Math.floor(o.whole / Math.max(1, o.p0) * o.sr / o.rate)), gating = 0.5, half = Math.floor(len * gating);
				const fd = Math.min(0.05, gating * 0.5), fin = Math.max(1, Math.floor(half * fd)), fout = Math.floor(half * (1 - fd));
				const st = { cur: Math.floor(o.elapsed * o.sr / o.rate) % len, mix: 0.9, low: 0.1 };
				st.process = (L, R, a, b) => {
					for (let i = a; i < b; i++) {
						let c = 1;
						if (st.cur < half) { if (st.cur > fout) c = 1 - (st.cur - fout) / fin; }
						else { const t = st.cur - half; c = t > fout ? (t - fout) / fin : 0; }
						c = c * (1 - st.low) + st.low; c = c * st.mix + (1 - st.mix);
						L[i] *= c; R[i] *= c;
						st.cur = (st.cur + 1) % len;
					}
				};
				return st;
			},
			TapeStop(o) {
				const len = Math.max(1, Math.floor(16 / Math.max(1, o.p0) * o.sr / o.rate));
				const bl = [], br = [];
				const st = { cur: 0, idx: 0, mix: 1 };
				st.process = (L, R, a, b) => {
					for (let i = a; i < b; i++) {
						const r = 1 - st.cur / len;
						if (r <= 0) { L[i] = 0; R[i] = 0; continue; }
						bl.push(L[i]); br.push(R[i]);
						const j = Math.floor(st.idx);
						L[i] = bl[j] * st.mix + L[i] * (1 - st.mix); R[i] = br[j] * st.mix + R[i] * (1 - st.mix);
						st.idx += r; st.cur++;
					}
				};
				return st;
			},
			Retrigger(o) {
				const len = Math.max(1, Math.floor(o.whole / Math.max(1, o.p0) * o.sr / o.rate)), gateLen = Math.floor(len * 0.7);
				const reset = o.whole * 0.5, base = o.tp;
				const st = { cur: Math.floor(o.elapsed * o.sr / o.rate) % len, mix: 1, start: o.start };
				st.process = (L, R, a, b, ctx) => {
					const pcm = ctx.pcm; if (!pcm) return;
					for (let i = a; i < b; i++) {
						const now = ctx.pos[i];
						const off = reset > 0 ? Math.floor((now - base) / reset + 1e-9) * reset : st.start - base;
						const p = (base + off + st.cur * ctx.rate / ctx.sr) * pcm.sr;
						const g = st.cur > gateLen ? 0 : 1;
						const k = Math.floor(p), f = p - k;
						let sl = 0, sr = 0;
						if (k >= 0 && k + 1 < pcm.n) { sl = pcm.l[k] + (pcm.l[k + 1] - pcm.l[k]) * f; sr = pcm.r[k] + (pcm.r[k + 1] - pcm.r[k]) * f; }
						L[i] = g * sl * st.mix + L[i] * (1 - st.mix); R[i] = g * sr * st.mix + R[i] * (1 - st.mix);
						st.cur = (st.cur + 1) % len;
					}
				};
				return st;
			},
			Echo(o) {
				const len = Math.max(1, Math.floor(o.whole / Math.max(1, o.p0) * o.sr / o.rate));
				const dl = new Float32Array(len), dr = new Float32Array(len);
				const st = { off: 0, loops: 0, fb: o.p1 / 100, mix: 1 };
				st.process = (L, R, a, b) => {
					for (let i = a; i < b; i++) {
						if (st.loops > 0) { L[i] = dl[st.off] * st.mix; R[i] = dr[st.off] * st.mix; }
						dl[st.off] = L[i] * st.fb; dr[st.off] = R[i] * st.fb;
						if (++st.off >= len) { st.off = 0; st.loops++; }
					}
				};
				return st;
			},
			Wobble(o) {
				const len = Math.max(1, Math.floor(o.whole / Math.max(1, o.p0) * o.sr / o.rate));
				const f = [new BQF(), new BQF()];
				const st = { cur: Math.floor(o.elapsed * o.sr / o.rate) % len, mix: 0.8, q: 1.414, fmin: 500, fmax: 20000 };
				st.process = (L, R, a, b, ctx) => {
					for (let i = a; i < b; i++) {
						const x = easeInExpo(Math.abs(2 * st.cur / len - 1));
						f[0].lowPass(st.q, st.fmin + (st.fmax - st.fmin) * x, ctx.sr); f[1].copyCoef(f[0]);
						L[i] = f[0].run(L[i]) * st.mix + L[i] * (1 - st.mix); R[i] = f[1].run(R[i]) * st.mix + R[i] * (1 - st.mix);
						st.cur = (st.cur + 1) % len;
					}
				};
				return st;
			},
			Phaser(o) {
				const len = Math.max(1, Math.floor(o.whole * 0.5 * o.sr / o.rate)), stages = 6;
				const ap = [[], []]; for (let j = 0; j < stages; j++) { ap[0].push(new BQF()); ap[1].push(new BQF()); }
				const hs = [new BQF(), new BQF()];
				const st = { cur: Math.floor(o.elapsed * o.sr / o.rate) % len, mix: 0.5, fmin: 1500, fmax: 20000, q: 0.707, fb: 0.35, width: 0.75, za: [0, 0] };
				hs[0].highShelf(1.5, Math.sqrt(st.fmin * st.fmax), -8, o.sr); hs[1].copyCoef(hs[0]);
				const coef = new BQF();
				st.process = (L, R, a, b, ctx) => {
					for (let i = a; i < b; i++) {
						const fr = [Math.abs(2 * (st.cur / len) - 1), Math.abs(2 * ((st.cur / len + st.width) % 1) - 1)];
						for (let c = 0; c < 2; c++) {
							const X = c ? R : L, x = X[i];
							coef.allPass(st.q, Math.pow(st.fmin, fr[c]) * Math.pow(st.fmax, 1 - fr[c]), ctx.sr);
							let y = st.fb * st.za[c] + x;
							for (let j = 0; j < stages; j++) { ap[c][j].copyCoef(coef); y = ap[c][j].run(y); }
							st.za[c] = y;
							y = (st.mix / 2) * y + (1 - st.mix / 2) * x;
							X[i] = st.mix * hs[c].run(y) + (1 - st.mix) * y;
						}
						st.cur = (st.cur + 1) % len;
					}
				};
				return st;
			},
			Flanger(o) {
				const len = Math.max(1, Math.floor(o.whole * 2 * o.sr / o.rate));
				const m = o.sr / 44100, min = Math.floor(30 * m), max = Math.floor((30 + 45) * m), depth = max - min, bl = (max + 1);
				const dl = new Float32Array(bl), dr = new Float32Array(bl);
				const st = { t: 0, off: 0, fb: 0.6, width: 0, vol: 0.75, mix: 0.8 };
				const cl = (v) => v < -1 ? -1 : v > 1 ? 1 : v;
				st.process = (L, R, a, b) => {
					const g = st.mix * st.vol + (1 - st.mix);
					for (let i = a; i < b; i++) {
						let f = (st.t / (len * 2)) % 1; f = Math.abs(f * 2 - 1);
						const dL = Math.floor(max - depth * f); let dR = dL + Math.floor(st.width * depth); if (dR > max) dR = max - (dR - max);
						const pl = ((st.off - dL) % bl + bl) % bl, pr = ((st.off - dR) % bl + bl) % bl;
						const xl = L[i], xr = R[i];
						dl[st.off] = cl((st.fb * dl[pl] + xl) * g); dr[st.off] = cl((st.fb * dr[pr] + xr) * g);
						L[i] = cl((st.mix * dl[pl] + xl) * g); R[i] = cl((st.mix * dr[pr] + xr) * g);
						if (++st.off >= bl) st.off = 0;
						st.t++;
					}
				};
				return st;
			},
			SideChain(o) {
				const k = o.sr / o.rate, len = Math.floor(o.whole / 4 * k), at = Math.floor(0.010 * k), ht = Math.floor(0.050 * k), rt = Math.floor(o.whole / 16 * k);
				const st = { t: Math.floor(o.elapsed * k) % (len + 1), mix: 1, ratio: 5 };
				st.process = (L, R, a, b) => {
					if (!len) return;
					for (let i = a; i < b; i++) {
						let v;
						if (st.t < at) v = 1 - st.t / at; else if (st.t < at + ht) v = 0; else if (st.t < at + ht + rt) v = (st.t - at - ht) / rt; else v = 1;
						const g = st.mix * ((1 / st.ratio) + (1 - 1 / st.ratio) * v) + (1 - st.mix);
						L[i] *= g; R[i] *= g;
						if (++st.t > len) st.t = 0;
					}
				};
				return st;
			},
			PitchShift(o) { // two-tap delay line pitch shifter (USC uses SoundTouch; this is a light stand-in)
				const W = Math.floor(0.05 * o.sr), N = W * 2 + 4;
				const dl = new Float32Array(N), dr = new Float32Array(N);
				const st = { w: 0, ph: 0, mix: 1, ratio: Math.pow(2, Math.max(-48, Math.min(48, o.p0)) / 12) };
				const rd = (d, p) => { const k = Math.floor(p), f = p - k, a = ((k % N) + N) % N, b = (a + 1) % N; return d[a] + (d[b] - d[a]) * f; };
				st.process = (L, R, a, b) => {
					const step = (1 - st.ratio) / W;
					for (let i = a; i < b; i++) {
						dl[st.w] = L[i]; dr[st.w] = R[i];
						st.ph = (st.ph + step) % 1; if (st.ph < 0) st.ph += 1;
						const p2 = (st.ph + 0.5) % 1, g1 = Math.sin(Math.PI * st.ph), g2 = Math.sin(Math.PI * p2);
						const r1 = st.w - 1 - st.ph * W, r2 = st.w - 1 - p2 * W;
						L[i] = (rd(dl, r1) * g1 + rd(dl, r2) * g2) * st.mix + L[i] * (1 - st.mix);
						R[i] = (rd(dr, r1) * g1 + rd(dr, r2) * g2) * st.mix + R[i] * (1 - st.mix);
						st.w = (st.w + 1) % N;
					}
				};
				return st;
			},
		};
		const findStep = (arr, s) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s <= s) lo = m + 1; else hi = m; } return arr[Math.max(0, lo - 1)].v; };

		class KsmFx extends AudioWorkletProcessor {
			constructor(options) {
				super();
				this.pcm = null; this.play = null; this.sched = null; this.fxOn = true;
				const init = options && options.processorOptions; // used for offline rendering / tests
				if (init) { this.pcm = init.pcm || null; this.sched = init.sched || null; this.play = init.play || null; }
				this.lane = [null, null]; this.laser = null;
				this.L = new Float32Array(128); this.R = new Float32Array(128); this.pos = new Float64Array(128);
				this.port.onmessage = (e) => {
					const m = e.data;
					if (m.cmd === 'pcm') this.pcm = m.pcm;
					else if (m.cmd === 'play') { this.play = m; this.lane = [null, null]; this.laser = null; }
					else if (m.cmd === 'stop') { this.play = null; this.lane = [null, null]; this.laser = null; }
					else if (m.cmd === 'sched') { this.sched = m.sched; this.lane = [null, null]; this.laser = null; }
					else if (m.cmd === 'fx') this.fxOn = m.on;
				};
			}
			process(inputs, outputs) {
				const out = outputs[0], oL = out[0], oR = out[1] || out[0], n = oL.length;
				const P = this.play, pcm = this.pcm;
				if (!P || !pcm) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
				const sr = sampleRate, L = this.L, R = this.R, pos = this.pos;
				let any = false;
				for (let i = 0; i < n; i++) {
					const fr = currentFrame + i - P.frame;
					if (fr < 0) { L[i] = 0; R[i] = 0; pos[i] = -1e9; continue; }
					const s = P.song + fr * P.rate / sr; pos[i] = s;
					const p = s * pcm.sr, k = Math.floor(p), f = p - k;
					if (k >= 0 && k + 1 < pcm.n) { L[i] = pcm.l[k] + (pcm.l[k + 1] - pcm.l[k]) * f; R[i] = pcm.r[k] + (pcm.r[k + 1] - pcm.r[k]) * f; any = true; }
					else { L[i] = 0; R[i] = 0; }
				}
				const S = this.sched;
				if (S && this.fxOn && pos[n - 1] > -1e8) {
					const ctx = { sr, rate: P.rate, pos, pcm };
					const s0 = pos[0] > -1e8 ? pos[0] : pos[n - 1];
					// FX hold effects
					for (let li = 0; li < 2; li++) {
						const hs = S.holds[li]; let lo = 0, hi = hs.length;
						while (lo < hi) { const m = (lo + hi) >> 1; if (hs[m].s <= s0) lo = m + 1; else hi = m; }
						const h = hs[lo - 1] && s0 < hs[lo - 1].e ? hs[lo - 1] : (hs[lo] && hs[lo].s < pos[n - 1] ? hs[lo] : null);
						if (!h) { this.lane[li] = null; continue; }
						if (!this.lane[li] || this.lane[li].h !== h) {
							const mk = DSPS[h.type];
							this.lane[li] = mk ? { h, d: mk({ sr, rate: P.rate, p0: h.p0, p1: h.p1, whole: h.whole, tp: h.tp, start: h.s, elapsed: Math.max(0, s0 - h.s) }) } : { h, d: null };
						}
						const d = this.lane[li].d; if (!d) continue;
						let a = 0; while (a < n && pos[a] < h.s) a++;
						let b = a; while (b < n && pos[b] < h.e) b++;
						if (b > a) d.process(L, R, a, b, ctx);
					}
					// laser filter
					const E = S.env, x = (s0 - E.t0) * E.rate, k = Math.floor(x);
					let input = 0, active = false;
					if (k >= 0 && k + 1 < E.v.length) { active = E.a[k] === 1; input = E.v[k] + (E.v[k + 1] - E.v[k]) * (x - k); }
					const kind = findStep(S.filters, s0), mix0 = findStep(S.mixes, s0);
					const skipZero = kind !== 'none';
					if (active && !(input <= 0 && skipZero)) {
						if (!this.laser || this.laser.kind !== kind) {
							this.laser = { kind, f: [new BQF(), new BQF()], bc: kind === 'bitc' ? DSPS.BitCrusher({ sr, p0: 0, mix: 1 }) : null };
						}
						const Ls = this.laser;
						let mix = mix0; if (input < 0.1) mix *= input / 0.1;
						if (kind === 'bitc') { Ls.bc.set(Math.floor(45 * input), sr); Ls.bc.process(L, R, 0, n); }
						else {
							if (kind === 'lpf1') Ls.f[0].lowPass((7 + 3 * input) * mix + 0.1, 10000 + (700 - 10000) * easeOutCubic(input), sr);
							else if (kind === 'hpf1') Ls.f[0].highPass((10 - 5 * input) * mix + 0.1, 80 + (2000 - 80) * easeInExpo(input), sr);
							else { if (input > 0.8) mix *= 1 - (input - 0.8) / 0.2; Ls.f[0].peaking(1 - 0.2 * input, 80 + (8000 - 80) * easeInExpo(input), 20 * mix, sr); }
							Ls.f[1].copyCoef(Ls.f[0]);
							for (let i = 0; i < n; i++) { L[i] = Ls.f[0].run(L[i]); R[i] = Ls.f[1].run(R[i]); }
						}
					} else this.laser = null;
				}
				// USC-style limiter: effects such as resonant laser filters can push past full scale
				const lim = this.lim || (this.lim = { g: 1, rel: 0.1 * sr, t: 1e9, peak: 1 });
				for (let i = 0; i < n; i++) {
					let g = 1;
					if (lim.t < lim.rel) { const u = 1 - lim.t / lim.rel; g = (1 / lim.peak) * u + (1 - u); }
					const pk = Math.max(Math.abs(L[i]), Math.abs(R[i]));
					oL[i] = L[i] * g; if (oR !== oL) oR[i] = R[i] * g;
					if (pk > 1 / g) { lim.peak = pk; lim.t = 0; } else lim.t++;
				}
				return true;
			}
		}
		registerProcessor('ksm-fx', KsmFx);
	}
	const WORKLET_SRC = '(' + WORKLET.toString() + ')();';
	// Load the worklet module: a data: URL works from file:// pages (blob: URLs do not), blob: as a fallback
	async function addWorklet(ctx) {
		const data = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC);
		try { await ctx.audioWorklet.addModule(data); }
		catch (e) { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))); }
	}
	return { parseEffect, parseDefines, filterKind, buildSchedule, WORKLET_SRC, addWorklet };
})();
