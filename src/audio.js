/* ============================================================================
 * Audio engine
 * The AudioContext clock is the single source of truth for playback time:
 *  - music is an AudioBufferSourceNode started at an exact context time
 *  - hitsounds are scheduled ahead on the same clock (sample accurate)
 *  - the visual playhead is derived from getOutputTimestamp(), i.e. what is
 *    coming out of the speakers right now, smoothed against performance.now()
 * ========================================================================== */
class AudioEngine {
	constructor() {
		this.ctx = null;
		this.buffer = null; this.fileName = '';
		this.src = null; this.playing = false;
		this.rate = 1;
		this.vol = { music: 0.8, hit: 0.55, game: 0.7, metro: 0.0 };
		this.peaks = null;               // waveform mip levels [{bucket(s), data: Float32Array}]
		this.scheduled = [];
		this.t0Ctx = 0; this.t0Song = 0;
		this.offEMA = null; this.lastSong = -Infinity;
		this.userLatency = 0;            // seconds, visual compensation from settings
	}
	ensure() {
		if (!this.ctx) {
			const AC = window.AudioContext || window.webkitAudioContext;
			this.ctx = new AC({ latencyHint: 'interactive' });
			this.musicGain = this.ctx.createGain(); this.musicGain.connect(this.ctx.destination);
			this.hitGain = this.ctx.createGain(); this.hitGain.connect(this.ctx.destination);
			this.gameGain = this.ctx.createGain(); this.gameGain.connect(this.ctx.destination);
			this.metroGain = this.ctx.createGain(); this.metroGain.connect(this.ctx.destination);
			this.applyVolumes();
			this.sounds = this._makeSounds();
			this._initWorklet();
		}
		if (this.ctx.state === 'suspended') this.ctx.resume();
		return this.ctx;
	}
	applyVolumes() {
		if (!this.ctx) return;
		this.musicGain.gain.value = this.vol.music;
		this.hitGain.gain.value = this.vol.hit;
		this.gameGain.gain.value = this.vol.game ?? 0.7;
		this.metroGain.gain.value = this.vol.metro;
	}
	get duration() { return this.buffer ? this.buffer.duration : 0; }
	// The music runs through an AudioWorklet that also renders FX hold / laser effects (see fx.js).
	// Falls back to a plain AudioBufferSourceNode if worklets are unavailable.
	_initWorklet() {
		const ctx = this.ctx;
		this.fxNode = null; this.pcmSent = false;
		if (!ctx.audioWorklet || typeof KSMFX === 'undefined') return;
		this.workletReady = KSMFX.addWorklet(ctx).then(() => {
			this.fxNode = new AudioWorkletNode(ctx, 'ksm-fx', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
			this.fxNode.connect(this.musicGain);
			this.fxNode.port.postMessage({ cmd: 'fx', on: this.fxEnabled !== false });
			if (this.buffer) this._sendPcm();
			if (this.pendingSched) this.fxNode.port.postMessage({ cmd: 'sched', sched: this.pendingSched });
		}).catch((e) => { console.warn('FX worklet unavailable, effects disabled', e); this.fxNode = null; });
	}
	_sendPcm() {
		const b = this.buffer; if (!this.fxNode || !b) return;
		const l = b.getChannelData(0).slice(), r = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice();
		this.fxNode.port.postMessage({ cmd: 'pcm', pcm: { l, r, n: b.length, sr: b.sampleRate } }, [l.buffer, r.buffer]);
		this.pcmSent = true;
	}
	get fxReady() { return !!(this.fxNode && this.pcmSent); }
	setSchedule(sched) { this.pendingSched = sched; if (this.fxNode) this.fxNode.port.postMessage({ cmd: 'sched', sched }); }
	setFxEnabled(on) { this.fxEnabled = on; if (this.fxNode) this.fxNode.port.postMessage({ cmd: 'fx', on }); }

	async load(arrayBuffer, name) {
		const ctx = this.ensure();
		const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
		this.buffer = buf; this.fileName = name || '';
		this.pcmSent = false;
		this._buildPeaks();
		if (this.fxNode) this._sendPcm();
		return buf;
	}

	_buildPeaks() {
		const b = this.buffer, n = b.length, ch = b.numberOfChannels;
		const B = 64; // base bucket in samples
		const m = Math.ceil(n / B), base = new Float32Array(m);
		const chans = []; for (let c = 0; c < ch; c++) chans.push(b.getChannelData(c));
		for (let i = 0; i < m; i++) {
			let mx = 0; const s0 = i * B, s1 = Math.min(n, s0 + B);
			for (let c = 0; c < ch; c++) { const d = chans[c]; for (let s = s0; s < s1; s += 2) { const v = d[s] < 0 ? -d[s] : d[s]; if (v > mx) mx = v; } }
			base[i] = mx;
		}
		const levels = [{ bucket: B, data: base }];
		let cur = base, bucket = B;
		while (cur.length > 64) {
			const nx = new Float32Array(Math.ceil(cur.length / 2));
			for (let i = 0; i < nx.length; i++) nx[i] = Math.max(cur[2 * i], cur[2 * i + 1] || 0);
			bucket *= 2; levels.push({ bucket, data: nx }); cur = nx;
		}
		this.peaks = { sr: b.sampleRate, levels };
	}
	// max amplitude in [t0, t1] seconds (song time)
	peakAt(t0, t1) {
		const P = this.peaks; if (!P) return 0;
		const span = Math.max(1, (t1 - t0) * P.sr);
		let L = 0; while (L + 1 < P.levels.length && P.levels[L + 1].bucket <= span) L++;
		const lv = P.levels[L], d = lv.data;
		let i0 = Math.floor(t0 * P.sr / lv.bucket), i1 = Math.floor(t1 * P.sr / lv.bucket);
		if (i1 < 0 || i0 >= d.length) return 0;
		i0 = Math.max(0, i0); i1 = Math.min(d.length - 1, i1);
		let mx = 0; for (let i = i0; i <= i1; i++) if (d[i] > mx) mx = d[i];
		return mx;
	}

	play(songTime, rate) {
		const ctx = this.ensure();
		this.stop();
		this.rate = rate || 1;
		const when = ctx.currentTime + 0.05;
		this.t0Ctx = when; this.t0Song = songTime;
		this.offEMA = null; this.lastSong = -Infinity;
		if (this.buffer && songTime < this.buffer.duration && this.fxReady) {
			this.fxNode.port.postMessage({ cmd: 'play', frame: Math.round(when * ctx.sampleRate), song: songTime, rate: this.rate });
			this.workletPlaying = true;
		} else if (this.buffer && songTime < this.buffer.duration) {
			const src = ctx.createBufferSource();
			src.buffer = this.buffer;
			src.playbackRate.value = this.rate;
			src.connect(this.musicGain);
			if (songTime >= 0) src.start(when, songTime);
			else src.start(when + (-songTime) / this.rate, 0);
			this.src = src;
		}
		this.playing = true;
	}
	stop() {
		if (this.src) { try { this.src.stop(); } catch (e) { } this.src.disconnect(); this.src = null; }
		if (this.workletPlaying && this.fxNode) { this.fxNode.port.postMessage({ cmd: 'stop' }); this.workletPlaying = false; }
		for (const s of this.scheduled) { try { s.stop(); } catch (e) { } }
		this.scheduled = [];
		this.playing = false;
	}
	// Context time that is audible right now (output latency compensated), smoothed
	_audibleCtxTime() {
		const ctx = this.ctx, perf = performance.now() / 1000;
		let est;
		if (ctx.getOutputTimestamp) {
			const ts = ctx.getOutputTimestamp();
			if (ts && ts.contextTime > 0 && ts.performanceTime > 0) est = ts.contextTime + (perf - ts.performanceTime / 1000);
		}
		if (est === undefined) est = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
		// Smooth small timestamp jitter, but follow real jumps (audio glitches) immediately
		const off = perf - est;
		if (this.offEMA === null || Math.abs(off - this.offEMA) > 0.008) this.offEMA = off;
		else this.offEMA += (off - this.offEMA) * 0.1;
		return perf - this.offEMA;
	}
	songTimeNow() {
		if (!this.playing) return null;
		let s = this.t0Song + (this._audibleCtxTime() - this.t0Ctx) * this.rate - this.userLatency;
		if (s < this.lastSong && this.lastSong - s < 0.03) s = this.lastSong; // keep monotonic
		this.lastSong = s;
		return s;
	}
	// Context time at which a given song time will be heard
	ctxTimeFor(songTime) { return this.t0Ctx + (songTime - this.t0Song) / this.rate; }
	schedule(kind, songTime, gain, bus) {
		const ctx = this.ctx; if (!ctx || !this.playing) return;
		const when = this.ctxTimeFor(songTime);
		if (when < ctx.currentTime - 0.002) return;
		const s = ctx.createBufferSource();
		s.buffer = this.sounds[kind] || this.sounds[kind.startsWith('slam') ? 'slam_normal' : 'fx'];
		let node = s;
		if (gain !== undefined && gain !== 1) { const g = ctx.createGain(); g.gain.value = gain; s.connect(g); node = g; }
		node.connect(kind === 'metro' || kind === 'metroHi' ? this.metroGain : bus === 'game' ? this.gameGain : this.hitGain);
		s.start(Math.max(when, ctx.currentTime));
		s.onended = () => { const i = this.scheduled.indexOf(s); if (i >= 0) this.scheduled.splice(i, 1); };
		this.scheduled.push(s);
	}
	click() { // UI feedback sound when placing notes (not timing critical)
		if (!this.ctx || !this.sounds) return;
		const s = this.ctx.createBufferSource(); s.buffer = this.sounds.bt;
		const g = this.ctx.createGain(); g.gain.value = 0.35; s.connect(g); g.connect(this.hitGain); s.start();
	}

	_makeSounds() {
		const sr = this.ctx.sampleRate;
		const mk = (dur, fn) => {
			const n = Math.ceil(sr * dur), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
			let seed = 1234567;
			const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
			for (let i = 0; i < n; i++) d[i] = fn(i / sr, rnd);
			return b;
		};
		return {
			// bright click/clap for BT
			bt: mk(0.06, (t, r) => { const e = Math.exp(-t * 70); return (r() * 0.55 + Math.sin(2 * Math.PI * 2400 * t) * 0.45) * e * 0.9; }),
			// lower, fuller clap for FX
			fx: mk(0.09, (t, r) => { const e = Math.exp(-t * 45); return (r() * 0.6 + Math.sin(2 * Math.PI * 900 * t) * 0.5) * e * 0.9; }),
			// laser slams (chokkakuse: normal / up / down / swing)
			slam_normal: mk(0.16, (t, r) => { const e = Math.exp(-t * 22) * Math.min(1, t * 400); return r() * e * 0.8 + Math.sin(2 * Math.PI * (500 - t * 1800) * t) * e * 0.4; }),
			slam_up: mk(0.18, (t, r) => { const e = Math.exp(-t * 18) * Math.min(1, t * 400); return r() * e * 0.45 + Math.sin(2 * Math.PI * (300 + t * 2600) * t) * e * 0.6; }),
			slam_down: mk(0.2, (t, r) => { const e = Math.exp(-t * 16) * Math.min(1, t * 400); return r() * e * 0.45 + Math.sin(2 * Math.PI * (900 - t * 2200) * t) * e * 0.6; }),
			slam_swing: mk(0.3, (t, r) => { const e = Math.sin(Math.PI * Math.min(1, t / 0.3)) * Math.exp(-t * 6); return r() * e * 0.7; }),
			// FX chip key sounds (fx-l_se / fx-r_se)
			se_clap: mk(0.22, (t, r) => { const b = (k) => Math.max(0, 1 - Math.abs(t - k) * 200); const e = Math.exp(-t * 18) + b(0.008) + b(0.016); return r() * Math.min(1.2, e) * 0.7; }),
			se_clap_punchy: mk(0.18, (t, r) => { const e = Math.exp(-t * 28); return r() * e * 0.8 + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 40) * 0.5; }),
			se_clap_impact: mk(0.3, (t, r) => { const e = Math.exp(-t * 12); return r() * e * 0.75 + Math.sin(2 * Math.PI * (120 - t * 100) * t) * Math.exp(-t * 15) * 0.7; }),
			se_snare: mk(0.25, (t, r) => { const e = Math.exp(-t * 16); return r() * e * 0.6 + Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 30) * 0.5; }),
			se_snare_lo: mk(0.28, (t, r) => { const e = Math.exp(-t * 13); return r() * e * 0.5 + Math.sin(2 * Math.PI * 150 * t) * Math.exp(-t * 25) * 0.6; }),
			metro: mk(0.04, (t) => Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t * 90) * 0.8),
			metroHi: mk(0.05, (t) => Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-t * 80) * 0.9),
		};
	}
}
