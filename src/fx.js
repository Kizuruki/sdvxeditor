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
	// "sdvx=3,75.00,2.00,0.50,90,2.00" in a #define_fx / #define_filter keeps the exact SOUND VOLTEX parameters
	// of an imported chart (USC and KSM ignore keys they do not know).
	const svOf = (d) => {
		if (!d || !d.sdvx) return null;
		const v = String(d.sdvx).split(/[,\s]+/).filter(Boolean).map(Number);
		return v.length > 1 && v.every(Number.isFinite) ? v : null;
	};
	function fromDefine(d) { // a #define_fx / #define_filter with an FX type -> {type, p0, p1, sv}
		const wl = frac(d.waveLength);
		let p0 = wl > 0 ? Math.round(1 / wl) : NaN, p1 = NaN;
		if (d.type === 'BitCrusher') p0 = parseInt(d.amount ?? d.reduction, 10);
		if (d.type === 'PitchShift') p0 = parseFloat(d.pitch);
		if (d.type === 'TapeStop') p0 = parseInt(d.speed, 10);
		if (d.feedbackLevel) p1 = Math.round(parseFloat(d.feedbackLevel) * (d.feedbackLevel.includes('%') ? 1 : 100));
		if (!Number.isFinite(p0)) p0 = DEFAULT_P[d.type] ?? 0;
		if (!Number.isFinite(p1)) p1 = d.type === 'Echo' ? 60 : 0;
		return { type: d.type, p0, p1, sv: svOf(d) };
	}
	function parseEffect(str, defines) {
		if (!str) return null;
		const parts = String(str).split(';').map(s => s.trim());
		let name = parts[0], p0 = parts[1] !== undefined && parts[1] !== '' ? parseInt(parts[1], 10) : NaN, p1 = parts[2] !== undefined ? parseInt(parts[2], 10) : NaN;
		if (!TYPES.has(name)) {
			const d = defines && defines['fx:' + name];
			if (!d || !TYPES.has(d.type)) return null;
			const e = fromDefine(d);
			if (Number.isFinite(p0) || Number.isFinite(p1)) e.sv = null; // parameters overridden on the note
			if (Number.isFinite(p0)) e.p0 = p0;
			if (Number.isFinite(p1)) e.p1 = p1;
			return e;
		}
		if (!Number.isFinite(p0)) p0 = DEFAULT_P[name] ?? 0;
		if (!Number.isFinite(p1)) p1 = name === 'Echo' ? 60 : 0;
		return { type: name, p0, p1, sv: null };
	}
	// laser effect kind: 'peak' | 'lpf1' | 'hpf1' | 'bitc' | 'fx:<Type>;<p0>;<p1>' (a #define_filter using an FX effect, e.g. Retrigger),
	// optionally followed by '|' and the SOUND VOLTEX parameters of an imported chart
	function filterKind(v, defines) {
		v = String(v || 'peak').trim();
		if (v === 'peak' || v === 'lpf1' || v === 'hpf1') return v;
		if (v === 'bitc' || v === 'fx;bitc') return 'bitc';
		const d = defines && defines['filter:' + v];
		if (d && d.type) {
			const sv = svOf(d), tail = sv ? '|' + sv.join(',') : '';
			const basic = ({ PeakingFilter: 'peak', LowPassFilter: 'lpf1', HighPassFilter: 'hpf1' })[d.type];
			if (basic) return basic + (basic === 'peak' ? '' : tail);
			if (TYPES.has(d.type)) { const e = fromDefine(d); return 'fx:' + e.type + ';' + e.p0 + ';' + e.p1 + tail; }
		}
		return 'peak';
	}
	const kindBase = (k) => String(k).split('|')[0];
	const kindSv = (k) => { const i = String(k).indexOf('|'); return i < 0 ? null : k.slice(i + 1).split(',').map(Number); };

	// ---- SOUND VOLTEX parameters (#FXBUTTON EFFECT INFO / #TAB EFFECT INFO rows as numbers, effect id first).
	// Used by the .vox export and by the "sounds like SOUND VOLTEX" playback mode, so the preview plays what the game would.
	function sdvxParams(e) {
		if (!e) return null;
		if (e.sv) return e.sv;
		const half = (n) => Math.max(1, Math.round(n / 2)), r2 = (v) => Math.round(v * 100) / 100;
		const cl = (v, a, b) => Math.max(a, Math.min(b, v));
		switch (e.type) {
			case 'Retrigger': return [1, half(e.p0), 95, 2, 1, 0.85, 0.15];
			case 'Gate': return [2, 100, half(e.p0), 1];
			case 'Phaser': // no SDVX phaser
			case 'Flanger': return [3, 80, 2, 0.5, 90, 2];
			case 'TapeStop': return [4, 100, 8, r2(cl(22 / Math.max(1, e.p0), 0.1, 2))];
			case 'SideChain': return [5, 90, 1, 45, 50, 60];
			case 'Wobble': return [6, 0, 1, 100, 500, 20000, r2(Math.max(1, e.p0) / 3), 1.41];
			case 'BitCrusher': return [7, 100, cl(Math.round(e.p0), 1, 30)];
			case 'Echo': return [8, half(e.p0), 100, 2, r2(cl(e.p1 / 100, 0.1, 1)), 0.85, 0.15, 0];
			case 'PitchShift': return [9, 100, r2(e.p0)];
		}
		return null;
	}
	// the five #TAB EFFECT INFO rows every official chart uses (laser LPF / HPF / bitcrush)
	const TAB_STD = [[1, 90, 400, 18000, 0.7], [1, 90, 600, 15000, 5], [2, 90, 40, 5000, 0.7], [2, 90, 40, 2000, 3], [3, 100, 30]];
	const TAB_DEFAULT = { lpf1: 0, hpf1: 2, bitc: 4 };
	const tabParams = (kind) => { const b = kindBase(kind); if (!(b in TAB_DEFAULT)) return null; return kindSv(kind) || TAB_STD[TAB_DEFAULT[b]]; };
	// laser node effect column (C4): 0 = built-in peak filter, 1..5 = #TAB EFFECT INFO row
	const tabCode = (kind) => {
		const p = tabParams(kind); if (!p) return 0;
		const i = TAB_STD.findIndex(r => r.length === p.length && r.every((x, j) => Math.abs(x - p[j]) < 1e-6));
		return i >= 0 ? i + 1 : TAB_DEFAULT[kindBase(kind)] + 1;
	};
	// SDVX column layout per effect id (i = integer, f = 2 decimals)
	const SV_COLS = { 1: 'iifffff', 2: 'ifif', 3: 'ifffif', 4: 'ifff', 5: 'iffiii', 6: 'iiifffff', 7: 'ifi', 8: 'iiffffff', 9: 'iff', 10: 'ifffff', 11: 'iffff', 12: 'iffff', 13: 'ifff' };
	const TAB_COLS = { 1: 'iffff', 2: 'iffff', 3: 'ifi' };
	function svLine(p, tab) {
		const cols = (tab ? TAB_COLS : SV_COLS)[p[0]] || 'i' + 'f'.repeat(p.length - 1);
		return p.map((v, i) => { if ((cols[i] || 'f') === 'i') return String(Math.round(v)); const s = (Math.round(v * 100) / 100).toFixed(2); return s === '-0.00' ? '0.00' : s; }).join(',\t');
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
			holds[li].push({ s: S(n.t), e: S(n.t + n.l), type: e.type, p0: e.p0, p1: e.p1, whole: 240 / bpm, tp: S(bp ? (ch.bpm.indexOf(bp) === 0 ? 0 : bp.t) : 0), sv: sdvxParams(e) });
		}));
		const steps = (arr, init, conv) => { const out = [{ s: -1e9, v: init }]; for (const p of arr) out.push({ s: S(p.t), v: conv(p.v) }); return out; };
		const filters = steps(ch.filterType, filterKind(ch.meta.filtertype, defines), v => filterKind(v, defines));
		// FX-type laser effects need the tempo where they start (lengths are in notes)
		ch.filterType.forEach((p, i) => { const f = filters[i + 1]; const bp = K.lastAtOrBefore(ch.bpm, p.t); f.whole = 240 / tm.bpmAt(p.t); f.tp = S(bp ? (ch.bpm.indexOf(bp) === 0 ? 0 : bp.t) : 0); });
		filters[0].whole = 240 / tm.bpmAt(0); filters[0].tp = S(0);
		for (const f of filters) { // SOUND VOLTEX parameters of the laser effect
			const b = kindBase(f.v);
			if (b.startsWith('fx:')) { const [type, a, c] = b.slice(3).split(';'); f.sv = sdvxParams({ type, p0: +a, p1: +c, sv: kindSv(f.v) }); }
			else f.sv = tabParams(f.v);
		}
		// tempo map for SOUND VOLTEX effects: BPM, time signature numerator, and where the last change of either was (Retrigger's grid)
		const tempo = [];
		for (const b of ch.bpm) tempo.push({ t: b.t });
		for (const g of ch.sig) tempo.push({ t: tm.measureStart(g.m) });
		tempo.push({ t: 0 });
		tempo.sort((a, b) => a.t - b.t);
		const tempoS = [];
		for (const x of tempo) {
			if (tempoS.length && tempoS[tempoS.length - 1].t === x.t) continue;
			const sg = tm.measureOf(x.t);
			tempoS.push({ t: x.t, s: S(x.t), bpm: tm.bpmAt(x.t), num: sg.n || 4 });
		}
		const pg = (v) => K.clamp((parseFloat(v) || 0) / 100, 0, 1);
		const mixes = steps(ch.pfilterGain, pg(ch.meta.pfiltergain === undefined || ch.meta.pfiltergain === '' ? 50 : ch.meta.pfiltergain), pg);
		// laser filter input: max over lanes of the knob position (L: 0 at left, R: 0 at right), USC Scoring::m_GetLaserOutputRaw
		let end = 0;
		for (const lane of ch.laser) if (lane.length) end = Math.max(end, K.sectionEndTick(lane[lane.length - 1]));
		const t0 = S(0), t1 = S(end) + 0.5;
		const n = Math.max(1, Math.ceil((t1 - t0) * ENV_RATE) + 1);
		const env = new Float32Array(n), act = new Uint8Array(n);
		const lane = [new Float32Array(n).fill(-1), new Float32Array(n).fill(-1)]; // raw knob per lane (R mirrored), -1 = no laser
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
					lane[li][k] = p;
					raw = Math.max(raw, p);
				}
				// USC smooths changes over 0.1 s
				since += 1 / ENV_RATE;
				if (raw !== tgt) { src = src + (tgt - src) * Math.min(1, since / 0.1); tgt = raw; since = 0; }
				out = src + (tgt - src) * Math.min(1, since / 0.1);
				env[k] = out; act[k] = any ? 1 : 0;
			}
		}
		return { holds, filters, mixes, tempo: tempoS, env: { t0, rate: ENV_RATE, v: env, a: act, l: lane[0], r: lane[1] } };
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
			bandPass(q, f, sr) { q = Math.max(q, 0.01); const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set(al, 0, -al, 1 + al, -2 * c, 1 - al); }
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
		const findStepItem = (arr, s) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s <= s) lo = m + 1; else hi = m; } return arr[Math.max(0, lo - 1)]; };
		const findStep = (arr, s) => findStepItem(arr, s).v;

		// ---- SOUND VOLTEX effect engine. Behaviour follows community reverse-engineering notes of the game's audio
		// engine (written from those descriptions, not from their code). The game runs at 44.1 kHz in 512-sample
		// blocks; phases here are derived from song seconds, so effects stay in place after seeking and at any rate.
		const G = 44100, GB = 512;
		const clampv = (v, a, b) => v < a ? a : v > b ? b : v;
		const mixOf = (v) => clampv(+v || 0, 0, 100) / 100;
		const tmp = [0, 0];
		const rdPcm = (pcm, s, o) => { const p = s * pcm.sr, k = Math.floor(p), f = p - k; if (k >= 0 && k + 1 < pcm.n) { o[0] = pcm.l[k] + (pcm.l[k + 1] - pcm.l[k]) * f; o[1] = pcm.r[k] + (pcm.r[k + 1] - pcm.r[k]) * f; } else { o[0] = 0; o[1] = 0; } };
		const gIndex = (s, start) => Math.max(0, (s - start) * G); // position in game samples since the effect started
		// Retrigger (id 1, locked to the song's grid) and Echo / Retrigger Ex (id 8, starts at the note):
		// count, mix, length (beats), feedback, gate, release. Each cycle replays its first slice `count` times, fading by feedback.
		function svRetrig(P, o, grid) {
			const cnt = clampv(Math.round(P[0]), 1, 32), m = mixOf(P[1]);
			const lenSec = clampv(P[2] * 60 / o.bpm, 0.1, 8), fb = clampv(P[3], 0.1, 1), gt = clampv(P[4], 0.1, 1), rel = clampv(P[5], 0, 1);
			const seg = Math.max(1, Math.floor(Math.floor(lenSec * G) / cnt)), gateLen = Math.floor(seg * gt), fadeLen = Math.floor(gateLen * rel), cyc = seg * cnt;
			const g = []; for (let k = 0; k < 32; k++) g.push(Math.pow(fb, k));
			let start = o.start;
			if (grid) { // a note that starts mid-cycle joins the cycle partway through (and may replay audio from before the note)
				const spb = Math.trunc(2646000 / o.bpm), spm = spb * o.num, period = Math.trunc(spb * P[2]);
				if (spb > 0 && spm > 0 && period > 0) {
					let off = (Math.round((o.start - o.anchor) * G) % spm) % period;
					if (off < 0 || off > period - GB) off = 0;
					start -= off / G;
				}
			}
			return { process(L, R, a, b, ctx) {
				for (let i = a; i < b; i++) {
					const t = gIndex(ctx.pos[i], start), c = t % cyc, rep = Math.floor(c / seg), rem = c - rep * seg;
					let w = rem > gateLen ? 0 : g[rep];
					if (w && fadeLen > 0 && rem > gateLen - fadeLen) w *= 1 - (rem - gateLen + fadeLen) / fadeLen;
					if (!w) { tmp[0] = 0; tmp[1] = 0; } else if (rep === 0) { tmp[0] = L[i]; tmp[1] = R[i]; } else rdPcm(ctx.pcm, ctx.pos[i] - rep * seg / G, tmp);
					L[i] = (1 - m) * L[i] + m * w * tmp[0]; R[i] = (1 - m) * R[i] + m * w * tmp[1];
				}
			} };
		}
		// sample-and-hold on a grid that restarts every 512-sample block (Bit Crusher, laser bitcrush)
		function svHold(m, o) {
			const st = { rate: 1, key: -1, hl: 0, hr: 0 };
			st.process = (L, R, a, b, ctx) => {
				for (let i = a; i < b; i++) {
					const g = Math.floor(gIndex(ctx.pos[i], o.start)), key = g - (g % GB) % st.rate;
					if (key !== st.key) { st.key = key; st.hl = L[i]; st.hr = R[i]; }
					L[i] = (1 - m) * L[i] + m * st.hl; R[i] = (1 - m) * R[i] + m * st.hr;
				}
			};
			return st;
		}
		function svPitch(mix, semis, o) {
			let a = +semis || 0;
			if (a >= -12) { a = Math.min(a, 12); if (a < 0) a = Math.min(a, -1); } else a = -12;
			if (a > 0 && a < 1) a = 1;
			if (!a) return null;
			const d = DSPS.PitchShift({ sr: o.sr, p0: a }); d.mix = mixOf(mix); return d;
		}
		const SV = {
			1: (P, o) => svRetrig(P, o, true),
			8: (P, o) => svRetrig(P, o, false),
			2(P, o) { // Gate: mix, steps, period (beats). The steps alternate loud / quiet.
				const m = mixOf(P[0]), steps = clampv(Math.round(P[1]), 1, 32), period = Math.max(1, Math.floor(clampv(P[2] * 60 / o.bpm, 0.1, 4) * G)), stepLen = Math.max(1, Math.floor(period / steps));
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const t = Math.floor(gIndex(ctx.pos[i], o.start)) % period, idx = Math.floor(t / stepLen) & 15;
						const k = (1 - m) + m * (idx & 1 ? 4 : 32) * 0.0322;
						L[i] *= k; R[i] *= k;
					}
				} };
			},
			3(P, o) { // Flanger: mix, delay (ms), rate (cycles per measure), depth (%), stages (passes, fractional top pass)
				const m = mixOf(P[0]), d = clampv(P[1], 0.1, 3) * 44.1, secPerMeasure = o.num * 60 / o.bpm;
				const rate = Math.max(P[2] / secPerMeasure, 0) * 0.5, depth = clampv(Math.round(P[3]), 0, 100) / 100 * d, st = clampv(P[4], 0, 4), top = Math.ceil(st);
				if (!(rate > 0)) return null;
				const wrap = 22050 / rate, quarter = 11025 / rate, w = rate * 2 * Math.PI / G, sc = o.sr / G;
				const N = Math.ceil((d + depth) * sc) + 4, bufs = [];
				for (let p = 0; p <= top; p++) bufs.push([new Float32Array(N), new Float32Array(N)]);
				const pa = m - (1 - m) * (top - st), pb = (top - st) * m + (1 - m);
				const tap = (buf, q) => { if (q < 0) q = 0; const k = Math.floor(q), f = q - k, i0 = k % N; return buf[i0] + (buf[(k + 1) % N] - buf[i0]) * f; };
				let wc = 0;
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const c = gIndex(ctx.pos[i], o.start) % wrap, c2 = (c + quarter) % wrap;
						const dl = (Math.sin(c * w) * depth + d) * sc, dr = (Math.sin(c2 * w) * depth + d) * sc;
						let xl = L[i], xr = R[i];
						for (let p = top; p >= 0; p--) {
							const B = bufs[p]; B[0][wc % N] = xl; B[1][wc % N] = xr;
							const yl = tap(B[0], wc - dl), yr = tap(B[1], wc - dr);
							if (p === top) { xl = pa * yl + pb * xl; xr = pa * yr + pb * xr; }
							else { xl = m * yl + (1 - m) * xl; xr = m * yr + (1 - m) * xr; }
						}
						if (st >= 1) { xl *= 1.5; xr *= 1.5; }
						L[i] = xl; R[i] = xr; wc++;
					}
				} };
			},
			4(P, o) { // Tape Stop: mix, speed (1-10), duration (seconds). Hyperbolic slow-down and a linear fade to silence.
				const m = mixOf(P[0]), speed = clampv(P[1], 1, 10), total = clampv(P[2], 0.1, 2) * G, step = 1 / total;
				let gDone = 0, idx = 0, fr = 0, cur = 0;
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const g = Math.floor(gIndex(ctx.pos[i], o.start));
						if (g + 1 >= total) { L[i] *= 1 - m; R[i] *= 1 - m; continue; }
						if (g < gDone - 1) { gDone = 0; idx = 0; fr = 0; }
						while (gDone <= g) { if (fr < 1) { const before = idx; idx++; fr += before * step * speed + 1; } fr -= 1; cur = idx; gDone++; }
						const env = 1 - g * step;
						rdPcm(ctx.pcm, o.start + cur / G, tmp);
						L[i] = (1 - m) * L[i] + m * tmp[0] * env; R[i] = (1 - m) * R[i] + m * tmp[1] * env;
					}
				} };
			},
			10(P, o) { // Tape Stop Ex: mix, speed, duration, pre-roll, window (beats): a spin-up from half volume
				const m = mixOf(P[0]), speed = clampv(P[1], 1, 10), spb = 60 / o.bpm, floor = 0.5;
				const dur = clampv(P[2] * spb, 0.1, 2) * G, pre = Math.max(P[3] * spb, 0) * G, win = clampv(P[4] * spb, 0.1, 2) * G, on = Math.ceil(Math.min(pre, dur));
				let gDone = -1, phase = 0, fr = 0, env = floor, idx = 0;
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const g = Math.floor(gIndex(ctx.pos[i], o.start));
						if (g < on) continue;
						if (g > pre + win) { L[i] *= 1 - m; R[i] *= 1 - m; continue; }
						if (gDone < on - 1 || g < gDone) { gDone = on - 1; phase = 0; fr = 0; }
						while (gDone < g) { gDone++; env = Math.min((phase / win) * (1 - floor) + floor, 1); if (fr < 1) { phase++; fr = Math.max(fr + (win - phase) * speed / win + 1, 1); } fr -= 1; idx = phase; }
						rdPcm(ctx.pcm, o.start + (on + idx) / G, tmp);
						L[i] = m * env * tmp[0] + (1 - m) * L[i]; R[i] = m * env * tmp[1] + (1 - m) * R[i];
					}
				} };
			},
			5(P, o) { // Side Chain: mix, period (beats), attack / hold / release (% of the period)
				const m = mixOf(P[0]), N = Math.max(1, Math.floor(Math.max(P[1] * 60 / o.bpm, 0.1) * G));
				const A = Math.max(1, Math.floor(clampv(Math.round(P[2]), 0, 100) * 0.002 * N)), H = Math.floor(clampv(Math.round(P[3]), 0, 100) * 0.003 * N), Rl = Math.max(1, Math.floor(clampv(Math.round(P[4]), 0, 100) * 0.005 * N));
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const t = Math.floor(gIndex(ctx.pos[i], o.start)) % N;
						const g = t < A ? 1 - t / A : t < A + H ? 0 : t < A + H + Rl ? (t - H - A) / Rl : 1, k = (1 - m) + m * g;
						L[i] *= k; R[i] *= k;
					}
				} };
			},
			6(P, o) { // Wobble: filter (0 LPF, 1 HPF, 2 BPF), wave (0 saw up, 1 saw down, 2 sine, 3 triangle, 4 square), mix, freq A, freq B, rate (per beat), Q
				const ft = Math.round(P[0]), wt = Math.round(P[1]), m = mixOf(P[2]);
				const lo = Math.max(1, Math.min(P[3], P[4])), hi = Math.max(P[3], P[4]), ratio = hi / lo, Q = Math.max(P[6], 0.1);
				const period = Math.max((60 / o.bpm) / Math.max(P[5], 1e-3), 0.1) * G;
				const trim = 1 - Q * 0.04, gB = Q <= 1 ? Math.max(Q + 0.9, 0.1) : (Q * 0.2 + 2 > 4 ? 3 : Q * 0.2 + 2);
				const f = [new BQF(), new BQF()];
				let lastBlk = -1;
				return { process(L, R, a, b, ctx) {
					for (let i = a; i < b; i++) {
						const blk = Math.floor(gIndex(ctx.pos[i], o.start) / GB);
						if (blk !== lastBlk) { // the LFO and filter update once per block, like the game
							lastBlk = blk;
							const counter = (blk * GB) % period, ph = counter / period;
							let fq = wt === 0 ? lo + ph * (hi - lo) : wt === 1 ? hi - ph * (hi - lo) : wt === 2 ? lo * Math.pow(ratio, (Math.sin(ph * 2 * Math.PI) + 1) * 0.5)
								: wt === 3 ? lo * Math.pow(ratio, ph < 0.5 ? 2 * ph : 2 - 2 * ph) : counter >= period / 2 ? hi : lo;
							fq = clampv(fq, 1, ctx.sr * 0.49);
							if (ft === 1) f[0].highPass(Q, fq, ctx.sr); else if (ft === 2) f[0].bandPass(Q, fq, ctx.sr); else f[0].lowPass(Q, fq, ctx.sr);
							f[1].copyCoef(f[0]);
						}
						const yl = f[0].run(L[i]), yr = f[1].run(R[i]);
						if (ft === 2) { L[i] = (1 - m) * L[i] + m * yl * gB; R[i] = (1 - m) * R[i] + m * yr * gB; }
						else { L[i] = ((1 - m) * L[i] + m * yl) * trim; R[i] = ((1 - m) * R[i] + m * yr) * trim; }
					}
				} };
			},
			7(P, o) { const h = svHold(mixOf(P[0]), o); h.rate = clampv(Math.round(P[1]), 1, 30); return h; }, // Bit Crusher: mix, rate
			9: (P, o) => svPitch(P[0], P[1], o), // Pitch Shift: mix, semitones
			13: (P, o) => Math.abs(P[2] - 1) < 1e-6 ? svPitch(P[0], P[1], o) : null, // Pitch & Speed (pitch only)
		};
		const mkSV = (p, o) => { const f = p && SV[Math.round(p[0])]; return f ? f(p.slice(1), o) : null; };
		// laser LPF / HPF / bitcrush from #TAB EFFECT INFO, swept by the knob (v = 0..1)
		function svTab(P, o) {
			const id = Math.round(P[0]), m = mixOf(P[1]);
			if (id === 3) { const h = svHold(m, o); return { process(L, R, a, b, ctx, v) { h.rate = Math.trunc(clampv(v, 0, 1) * 29 + 1); h.process(L, R, a, b, ctx); } }; }
			const lo = Math.max(P[2], 1), ratio = P[3] / lo, Q = Math.max(P[4], 0.1), trim = 1 - Q * 0.04, f = [new BQF(), new BQF()];
			return { process(L, R, a, b, ctx, v) {
				v = clampv(v, 0, 1);
				const fq = clampv(lo * Math.pow(ratio, id === 1 ? 1 - v : v), 1, ctx.sr * 0.49);
				if (id === 1) f[0].lowPass(Q, fq, ctx.sr); else f[0].highPass(Q, fq, ctx.sr);
				f[1].copyCoef(f[0]);
				for (let i = a; i < b; i++) { L[i] = ((1 - m) * L[i] + m * f[0].run(L[i])) * trim; R[i] = ((1 - m) * R[i] + m * f[1].run(R[i])) * trim; }
			} };
		}
		// the built-in laser filter: a peaking EQ whose centre, width and gain come from the knob (0..127)
		const PEAK_FC = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 100, 106, 112, 118, 124, 130, 136, 142, 148, 154, 160, 166, 172, 178, 184, 190, 196, 202, 232, 262, 292, 322,
			352, 382, 412, 442, 472, 522, 572, 622, 672, 722, 772, 822, 872, 922, 972, 1022, 1072, 1122, 1172, 1222, 1272, 1322, 1372, 1422, 1472, 1522, 1572, 1622, 1672, 1722, 1772, 1822,
			1872, 1922, 1972, 2022, 2072, 2122, 2172, 2222, 2272, 2322, 2372, 2422, 2472, 2522, 2572, 2622, 2672, 2722, 2772, 2822, 2872, 2922, 2972, 3022, 3072, 3122, 3172, 3222, 3272, 3322, 3372, 3422,
			3472, 3522, 3572, 3622, 3672, 3852, 4032, 4212, 4392, 4572, 4752, 4932, 5112, 5292, 5472, 5652, 5832, 6012, 6192, 6372, 6552, 6732, 6912, 7400, 7700, 8000, 8400, 8800, 9270, 9750, 10240, 10800];
		function peakEq(bq, v, sr) {
			const fc = clampv(PEAK_FC[v], 80, 16000);
			let bw, gain;
			if (fc < 200) bw = gain = fc * 0.075; else if (fc < 1000) bw = gain = 15; else { bw = 15 - (fc - 1000) * 0.0003; gain = 15 - (fc - 1000) * 0.0005; }
			if (v < 4) gain = 0;
			if (!gain) { bq._set(1, 0, 0, 1, 0, 0); return; }
			const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * fc / sr, sn = Math.sin(w0), cs = Math.cos(w0);
			const al = sn * Math.sinh(0.5 * Math.LN2 * (Math.max(bw, 1) / 12) * w0 / sn); // bandwidth in semitones
			bq._set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
		}
		// the game also lowers the music while the knob is turned (chased at 0.33 per second)
		const duckTarget = (v) => v < 4 ? 1 : v < 95 ? 0.8 - (v - 4) * 0.0025274728 : v < 100 ? 0.57 : v < 120 ? 0.57 + (v - 100) * 0.011500001 : 0.8;

		class KsmFx extends AudioWorkletProcessor {
			constructor(options) {
				super();
				this.pcm = null; this.play = null; this.sched = null; this.fxOn = true; this.mode = 'sdvx';
				const init = options && options.processorOptions; // used for offline rendering / tests
				if (init) { this.pcm = init.pcm || null; this.sched = init.sched || null; this.play = init.play || null; if (init.mode) this.mode = init.mode; }
				this._reset();
				this.L = new Float32Array(128); this.R = new Float32Array(128); this.pos = new Float64Array(128);
				this.dL = new Float32Array(128); this.dR = new Float32Array(128);
				this.W = [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128), new Float32Array(128)]];
				this.port.onmessage = (e) => {
					const m = e.data;
					if (m.cmd === 'pcm') this.pcm = m.pcm;
					else if (m.cmd === 'play') { this.play = m; this._reset(); }
					else if (m.cmd === 'stop') { this.play = null; this._reset(); }
					else if (m.cmd === 'sched') { this.sched = m.sched; this._reset(); }
					else if (m.cmd === 'fx') this.fxOn = m.on;
					else if (m.cmd === 'mode') { this.mode = m.mode; this._reset(); }
				};
			}
			_reset() { this.lane = [null, null]; this.laser = null; this.peak = null; }
			_holdAt(hs, s0, s1) {
				let lo = 0, hi = hs.length;
				while (lo < hi) { const m = (lo + hi) >> 1; if (hs[m].s <= s0) lo = m + 1; else hi = m; }
				return hs[lo - 1] && s0 < hs[lo - 1].e ? hs[lo - 1] : (hs[lo] && hs[lo].s < s1 ? hs[lo] : null);
			}
			_svOpts(S, s, sr) {
				const T = S.tempo || [];
				let k = 0; while (k + 1 < T.length && T[k + 1].s <= s + 1e-6) k++;
				const t = T[k] || { s: 0, bpm: 120, num: 4 };
				return { sr, start: s, bpm: t.bpm || 120, num: t.num || 4, anchor: t.s };
			}
			process(inputs, outputs) {
				const out = outputs[0], oL = out[0], oR = out[1] || out[0], n = oL.length;
				const P = this.play, pcm = this.pcm;
				if (!P || !pcm) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
				const sr = sampleRate, L = this.L, R = this.R, pos = this.pos;
				for (let i = 0; i < n; i++) {
					const fr = currentFrame + i - P.frame;
					if (fr < 0) { L[i] = 0; R[i] = 0; pos[i] = -1e9; continue; }
					const s = P.song + fr * P.rate / sr; pos[i] = s;
					const p = s * pcm.sr, k = Math.floor(p), f = p - k;
					if (k >= 0 && k + 1 < pcm.n) { L[i] = pcm.l[k] + (pcm.l[k + 1] - pcm.l[k]) * f; R[i] = pcm.r[k] + (pcm.r[k + 1] - pcm.r[k]) * f; }
					else { L[i] = 0; R[i] = 0; }
				}
				const S = this.sched;
				if (S && this.fxOn && pos[n - 1] > -1e8) {
					const ctx = { sr, rate: P.rate, pos, pcm };
					if (this.mode === 'usc') this._usc(L, R, n, ctx, S); else this._sdvx(L, R, n, ctx, S);
				}
				// limiter: effects such as resonant laser filters can push past full scale
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
			// USC: FX holds run in lane order and stack; the laser filter follows the smoothed knob, scaled by pfiltergain
			_usc(L, R, n, ctx, S) {
				const pos = ctx.pos, sr = ctx.sr, P = { rate: ctx.rate };
				const s0 = pos[0] > -1e8 ? pos[0] : pos[n - 1];
				for (let li = 0; li < 2; li++) {
					const h = this._holdAt(S.holds[li], s0, pos[n - 1]);
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
				const E = S.env, x = (s0 - E.t0) * E.rate, k = Math.floor(x);
				let input = 0, active = false;
				if (k >= 0 && k + 1 < E.v.length) { active = E.a[k] === 1; input = E.v[k] + (E.v[k + 1] - E.v[k]) * (x - k); }
				const fstep = findStepItem(S.filters, s0), kind = fstep.v.split('|')[0], mix0 = findStep(S.mixes, s0);
				if (active && kind.startsWith('fx:')) {
					// a laser running an FX effect (SDVX "auto tab"): runs while the laser is held, at its own parameters
					if (!this.laser || this.laser.kind !== kind) {
						const [type, a, b] = kind.slice(3).split(';'), mk = DSPS[type];
						this.laser = { kind, d: mk ? mk({ sr, rate: P.rate, p0: +a, p1: +b, whole: fstep.whole || 2, tp: fstep.tp || 0, start: s0, elapsed: 0 }) : null };
					}
					if (this.laser.d) this.laser.d.process(L, R, 0, n, ctx);
				} else if (active && input > 0) {
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
			// SOUND VOLTEX: FX holds read the dry track (where FX-L and FX-R overlap, the later note wins); a laser's
			// tab effect or borrowed FX effect chains after them; the built-in peak filter and the music duck come last.
			_sdvx(L, R, n, ctx, S) {
				const pos = ctx.pos, sr = ctx.sr, s0 = pos[0] > -1e8 ? pos[0] : pos[n - 1], s1 = pos[n - 1];
				const dL = this.dL, dR = this.dR; dL.set(L); dR.set(R);
				let used = 0;
				for (let li = 0; li < 2; li++) {
					const h = this._holdAt(S.holds[li], s0, s1);
					if (!h || !h.sv) { this.lane[li] = null; continue; }
					if (!this.lane[li] || this.lane[li].h !== h) this.lane[li] = { h, d: mkSV(h.sv, this._svOpts(S, h.s, sr)), a: 0, b: 0 };
					const st = this.lane[li]; if (!st.d) continue;
					let a = 0; while (a < n && pos[a] < h.s) a++;
					let b = a; while (b < n && pos[b] < h.e) b++;
					if (b <= a) continue;
					const W = this.W[li]; W[0].set(dL); W[1].set(dR);
					st.d.process(W[0], W[1], a, b, ctx); st.a = a; st.b = b; used |= 1 << li;
				}
				if (used) for (let i = 0; i < n; i++) {
					let pick = -1;
					for (let li = 0; li < 2; li++) { const st = this.lane[li]; if ((used >> li & 1) && i >= st.a && i < st.b && (pick < 0 || st.h.s >= this.lane[pick].h.s)) pick = li; }
					if (pick >= 0) { L[i] = this.W[pick][0][i]; R[i] = this.W[pick][1][i]; }
				}
				// lasers
				const E = S.env;
				const knobAt = (arr, s) => { const x = (s - E.t0) * E.rate, k = Math.floor(x); if (!arr || k < 0 || k + 1 >= arr.length) return -1; const a0 = arr[k], a1 = arr[k + 1]; return a0 < 0 ? -1 : a1 < 0 ? a0 : a0 + (a1 - a0) * (x - k); };
				const kl = knobAt(E.l, s0), kr = knobAt(E.r, s0);
				const fstep = findStepItem(S.filters, s0), kind = fstep.v, base = kind.split('|')[0];
				const isFx = base.startsWith('fx:'), isTab = base === 'lpf1' || base === 'hpf1' || base === 'bitc';
				if ((kl >= 0 || kr >= 0) && (isFx || isTab) && fstep.sv) {
					if (!this.laser || this.laser.step !== fstep) { const o = this._svOpts(S, s0, sr); this.laser = { step: fstep, d: isFx ? mkSV(fstep.sv, o) : svTab(fstep.sv, o) }; }
					if (this.laser.d) this.laser.d.process(L, R, 0, n, ctx, kr >= 0 ? kr : kl); // VOL-R's run overwrites VOL-L's
				} else this.laser = null;
				// built-in peak filter: off while a tab effect is selected, otherwise 80 ms behind the knob (max of both lasers)
				const peakOk = (s) => { const b = findStepItem(S.filters, s).v.split('|')[0]; return b === 'peak' || b.startsWith('fx:'); };
				let v = 0;
				if (peakOk(s0) && peakOk(s0 - 0.08)) v = Math.max(0, knobAt(E.l, s0 - 0.08), knobAt(E.r, s0 - 0.08));
				const vi = clampv(Math.trunc(v * 127), 0, 127);
				const pq = this.peak || (this.peak = { f: [new BQF(), new BQF()], duck: 1, v: -1 });
				if (vi !== pq.v) { pq.v = vi; peakEq(pq.f[0], vi, sr); pq.f[1].copyCoef(pq.f[0]); }
				const d0 = pq.duck, stp = 0.33 * n / sr * ctx.rate;
				pq.duck = d0 + clampv(duckTarget(vi) - d0, -stp, stp);
				for (let i = 0; i < n; i++) { const g = d0 + (pq.duck - d0) * (i + 1) / n; L[i] = pq.f[0].run(L[i]) * g; R[i] = pq.f[1].run(R[i]) * g; }
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
	return { parseEffect, parseDefines, filterKind, kindBase, kindSv, sdvxParams, svLine, tabParams, tabCode, TAB_STD, buildSchedule, WORKLET_SRC, addWorklet };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = KSMFX;
