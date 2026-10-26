/* ============================================================================
 * SOUND VOLTEX export: .vox chart (format 10), .2dx audio (MS-ADPCM WAV in a
 * 2DX container), music_db entry (Shift-JIS XML), jackets, all in one .zip
 * laid out for data_mods. Mappings follow the user's working pair
 * (mxm.ksh -> 2811_custom_5m.vox) and the community VOX format notes.
 * ========================================================================== */
const SDVX = (() => {
	const SLOTS = [
		{ id: 'novice', n: 1, l: 'n', label: '1 NOVICE' }, { id: 'advanced', n: 2, l: 'a', label: '2 ADVANCED' },
		{ id: 'exhaust', n: 3, l: 'e', label: '3 EXHAUST' }, { id: 'infinite', n: 4, l: 'i', label: '4 INF / GRV / HVN / VVD / XCD' },
		{ id: 'maximum', n: 5, l: 'm', label: '5 MAXIMUM' }, { id: 'ultimate', n: 6, l: 'u', label: '6 ULTIMATE' },
	];
	const KSH_DIFF_SLOT = { light: 'novice', challenge: 'advanced', extended: 'exhaust', infinite: 'maximum' };
	const pad = (n, w) => String(n).padStart(w, '0');
	const f2 = (v) => { const s = (Math.round(v * 100) / 100).toFixed(2); return s === '-0.00' ? '0.00' : s; };

	// ---------------------------------------------------------------- VOX
	// laser filter -> #TAB EFFECT INFO index (0 = built-in peak filter)
	const FILTER_CODE = { peak: 0, lpf1: 1, hpf1: 3, bitc: 5 };
	const TAB_EFFECTS = [
		'1,\t90.00,\t400.00,\t18000.00,\t0.70', '1,\t90.00,\t600.00,\t15000.00,\t5.00',
		'2,\t90.00,\t40.00,\t5000.00,\t0.70', '2,\t90.00,\t40.00,\t2000.00,\t3.00', '3,\t100.00,\t30'];
	const SE_CODE = { clap: 3, clap_punchy: 3, clap_impact: 2, snare: 5, snare_lo: 4 };
	// FX hold effect -> #FXBUTTON EFFECT INFO line
	function fxLine(e, warn) {
		const half = (n) => Math.max(1, Math.round(n / 2));
		switch (e.type) {
			case 'Retrigger': return `1,\t${half(e.p0)},\t95.00,\t2.00,\t1.00,\t0.85,\t0.15`;
			case 'Gate': return `2,\t100.00,\t${half(e.p0)},\t1.00`;
			case 'Phaser': warn('Phaser has no SDVX equivalent; exported as Flanger.');
			// falls through
			case 'Flanger': return '3,\t80.00,\t2.00,\t0.50,\t90,\t2.00';
			case 'TapeStop': return `4,\t100.00,\t8.00,\t${f2(K.clamp(22 / Math.max(1, e.p0), 0.1, 2))}`;
			case 'SideChain': return '5,\t90.00,\t1.00,\t45,\t50,\t60';
			case 'Wobble': return `6,\t0,\t1,\t100.00,\t500.00,\t20000.00,\t${f2(Math.max(1, e.p0) / 3)},\t1.41`;
			case 'BitCrusher': return `7,\t100.00,\t${K.clamp(Math.round(e.p0), 1, 30)}`;
			case 'Echo': return `8,\t${half(e.p0)},\t100.00,\t2.00,\t${f2(K.clamp(e.p1 / 100, 0.1, 1))},\t0.85,\t0.15,\t0.00`;
			case 'PitchShift': return `9,\t100.00,\t${f2(e.p0)}`;
		}
		return null;
	}

	function buildVox(chartIn, opts = {}) {
		const warnings = [];
		const warn = (msg, t) => { if (!warnings.some(w => w.msg === msg)) warnings.push({ t: t || 0, msg }); };
		const c = K.toUsc(chartIn, warnings); // no curves, rotation folded into tilt
		const tm = new K.Timing(c);
		const edge = opts.laserEdge || 124;
		const pos = (t) => {
			t = Math.max(0, Math.round(t / 5) * 5);
			const ms = tm.measureOf(t), cpb = 192 / ms.d, cells = Math.round((t - ms.start) / 5);
			const beat = Math.floor(cells / cpb), cell = cells - beat * cpb;
			return pad(ms.m + 1, 3) + ',' + pad(beat + 1, 2) + ',' + pad(cell, 2);
		};
		const cells = (l) => Math.round(l / 5);
		const L = [];
		const sec = (name, rows) => { L.push('#' + name, ...rows, '#END', ''); };
		const sep = () => L.push('//====================================', '');
		L.push('//====================================', '// SOUND VOLTEX OUTPUT TEXT FILE', '//====================================', '');
		sec('FORMAT VERSION', ['10']);
		sec('BEAT INFO', c.sig.map(s => pos(tm.measureStart(s.m)) + '\t' + s.n + '\t' + s.d));
		// BPM changes; stops become pauses ("4-") that end with the BPM restated
		const bpmRows = c.bpm.map(b => ({ t: b.t, s: pos(b.t) + '\t' + b.v.toFixed(4) + '\t4' }));
		for (const st of c.stops) {
			bpmRows.push({ t: st.t, s: pos(st.t) + '\t' + tm.bpmAt(st.t).toFixed(4) + '\t4-' });
			bpmRows.push({ t: st.t + st.l, s: pos(st.t + st.l) + '\t' + tm.bpmAt(st.t + st.l).toFixed(4) + '\t4' });
		}
		if (c.stops.length) warn('Stops are written as SDVX pauses; check them in game.');
		sec('BPM INFO', bpmRows.sort((a, b) => a.t - b.t).map(r => r.s));
		// auto-tilt modes
		const tiltRows = [];
		for (const p of c.tilt) {
			const v = typeof p.v === 'string' ? p.v : null; if (!v) continue;
			tiltRows.push(pos(p.t) + '\t' + (v.startsWith('keep') ? 2 : /bigger|biggest/.test(v) ? 1 : 0));
		}
		sec('TILT MODE INFO', tiltRows);
		sec('LYRIC INFO', []);
		let end = 0;
		for (const l of [...c.bt, ...c.fx]) for (const n of l) end = Math.max(end, n.t + n.l);
		for (const l of c.laser) for (const s of l) end = Math.max(end, K.sectionEndTick(s));
		const endM = tm.measureOf(end).m + 2;
		sec('END POSITION', [pos(tm.measureStart(endM))]);
		sec('TAB EFFECT INFO', TAB_EFFECTS);
		// FX hold effects: one pair per hold, in time order (L before R)
		const defines = KSMFX.parseDefines(c.defs);
		const holds = [];
		c.fx.forEach((lane, li) => lane.forEach(n => { if (n.l > 0) holds.push({ n, li }); }));
		holds.sort((a, b) => a.n.t - b.n.t || a.li - b.li);
		const pairRows = [], holdIdx = new Map();
		for (const hd of holds) {
			const e = hd.n.fx ? KSMFX.parseEffect(hd.n.fx, defines) : null;
			const line = e ? fxLine(e, warn) : null;
			if (hd.n.fx && !line) warn('FX effect "' + hd.n.fx + '" has no SDVX equivalent and was left out.', hd.n.t);
			if (!line) { holdIdx.set(hd.n, 0); continue; }
			holdIdx.set(hd.n, 2 + pairRows.length / 3);
			pairRows.push(line, '0,\t0,\t0,\t0,\t0,\t0,\t0', '');
		}
		L.push('#FXBUTTON EFFECT INFO', ...pairRows, '#END', '');
		const assign = []; for (let i = 0; i < 12; i++) assign.push(i + ',\t0,\t0.00,\t0.00', i + ',\t0,\t0.00,\t0.00');
		sec('TAB PARAM ASSIGN INFO', assign);
		sec('REVERB EFFECT PARAM', []);
		L.push('//====================================', '// TRACK INFO', '//====================================', '');
		// lasers
		const filterAt = (t) => { const p = K.lastAtOrBefore(c.filterType, t); const v = KSMFX.filterKind(p ? p.v : c.meta.filtertype, defines); return FILTER_CODE[v] ?? 0; };
		const spinAt = new Map(c.spins.map(s => [s.t, s]));
		const usedSpins = new Set();
		const rollCode = (s) => {
			if (s.kind !== 'spin') return 5; // half spin / swing -> 3-beat swing
			const beats = 2 * s.l / 240; // SDVX durations include the overshoot: twice the KSH length
			return [[2, 2], [3, 3], [1, 7]].reduce((best, [code, b]) => Math.abs(b - beats) < Math.abs(best[1] - beats) ? [code, b] : best, [2, 2])[0];
		};
		const laserTrack = (lane) => {
			const rows = [];
			for (const s of c.laser[lane]) {
				const range = s.wide ? 2 : 1, last = s.pts.length - 1;
				const val = (v) => { v = K.clamp(v, 0, 50); return v <= 0 ? 0 : Math.ceil(v * (edge + 1) / 50 - 1e-9) - 1; }; // same as the reference conversion: 1->2, 2->4, 25->62, 47->117, 50->124
				s.pts.forEach((p, i) => {
					const t = s.t + p.ry, fc = filterAt(t);
					if (p.v !== p.vf) {
						const sp = spinAt.get(t); let roll = 0;
						if (sp) { roll = rollCode(sp); usedSpins.add(sp); }
						rows.push(`${pos(t)}\t${val(p.v)}\t${i === 0 ? 1 : 0}\t${roll}\t${fc}\t${range}\t0`);
						rows.push(`${pos(t)}\t${val(p.vf)}\t${i === last ? 2 : 0}\t0\t${fc}\t${range}\t0`);
					} else rows.push(`${pos(t)}\t${val(p.v)}\t${i === 0 ? 1 : i === last ? 2 : 0}\t0\t${fc}\t${range}\t0`);
				});
			}
			return rows;
		};
		const fxTrack = (lane) => c.fx[lane].map(n => n.l > 0 ? `${pos(n.t)}\t${cells(n.l)}\t${holdIdx.get(n) || 0}` : `${pos(n.t)}\t0\t${n.se ? (SE_CODE[n.se.split(';')[0]] || 0) : 0}`);
		const btTrack = (lane) => c.bt[lane].map(n => `${pos(n.t)}\t${cells(n.l)}\t0`);
		const tracks = [laserTrack(0), fxTrack(0), btTrack(0), btTrack(1), btTrack(2), btTrack(3), fxTrack(1), laserTrack(1)];
		tracks.forEach((rows, i) => { L.push('#TRACK' + (i + 1), ...rows, '#END', ''); sep(); });
		for (const sp of c.spins) if (!usedSpins.has(sp)) warn('A spin that is not on a slam was left out (SDVX spins start on slams).', sp.t);
		if (c.fx.some(l => l.some(n => n.l === 0 && n.se && !SE_CODE[n.se.split(';')[0]]))) warn('Custom FX chip sounds (sample files) have no SDVX equivalent and were left out.');
		L.push('#TRACK AUTO TAB', '#END', '');
		sep();
		// SPCONTROLER: camera graphs
		const sp = ['001,01,00\tRealize\t3\t0\t36.12\t60.12\t110.12\t0.00', '001,01,00\tRealize\t4\t0\t0.62\t0.72\t1.03\t0.00',
			'001,01,00\tAIRL_ScaX\t1\t0\t0.00\t1.00\t0.00\t0.00', '001,01,00\tAIRR_ScaX\t1\t0\t0.00\t2.00\t0.00\t0.00'];
		const graph = (name, pts, conv) => {
			const num = pts.filter(p => typeof p.v === 'number');
			if (!num.length || num.every(p => p.v === 0 && (p.vf === undefined || p.vf === 0))) return;
			const first = conv(num[0].v);
			sp.push(`001,01,00\t${name}\t2\t0\t${f2(first)}\t${f2(first)}\t0.00\t0.00`);
			if (num[0].t > 0) sp.push(`001,01,00\t${name}\t2\t${cells(num[0].t)}\t${f2(first)}\t${f2(first)}\t0.00\t0.00`);
			num.forEach((p, i) => {
				const q = num[i + 1], a = conv(p.v), b = conv(typeof p.vf === 'number' ? p.vf : p.v);
				if (a !== b) sp.push(`${pos(p.t)}\t${name}\t2\t0\t${f2(a)}\t${f2(b)}\t0.00\t0.00`);
				if (q) sp.push(`${pos(p.t)}\t${name}\t2\t${cells(q.t - p.t)}\t${f2(b)}\t${f2(conv(q.v))}\t0.00\t0.00`);
			});
		};
		graph('CAM_RotX', c.cam.zoom_top, v => Math.tanh(v / 100));
		graph('CAM_Radi', c.cam.zoom_bottom, v => -Math.tanh(v / 100));
		graph('Morphing2', c.cam.center_split, v => v / 100 * 0.75);
		// manual tilt (vox +1 = ksh -1); tilt=zero spans hold the lane flat
		const tiltSpans = [];
		for (let i = 0; i < c.tilt.length; i++) {
			const p = c.tilt[i], q = c.tilt[i + 1];
			const after = p.vf !== undefined ? p.vf : p.v;
			if (typeof p.v === 'number') {
				const a = -p.v, b = typeof after === 'number' ? -after : -p.v;
				if (a !== b) tiltSpans.push(`${pos(p.t)}\tTilt\t2\t0\t${f2(a)}\t${f2(b)}\t0.00\t0.00`);
				if (q && typeof after === 'number') tiltSpans.push(`${pos(p.t)}\tTilt\t2\t${cells(q.t - p.t)}\t${f2(b)}\t${f2(typeof q.v === 'number' ? -q.v : b)}\t0.00\t0.00`);
			} else if (after === 'zero') {
				const until = q ? q.t : tm.measureStart(endM);
				tiltSpans.push(`${pos(p.t)}\tTilt\t2\t${cells(until - p.t)}\t0.00\t0.00\t0.00\t0.00`);
			}
		}
		sp.push(...tiltSpans);
		if (c.cam.zoom_side.some(p => p.v !== 0 || (p.vf || 0) !== 0)) warn('SDVX has no sideways lane shift: Zoom Side (and slam kicks) are left out.');
		if (c.cam.scroll_speed.length) warn('scroll_speed is not exported to SDVX.');
		if (chartIn.cam.center_split.length) warn('center_split is exported as SDVX lane split (Morphing2); the amount is approximate.');
		if (chartIn.pfilterGain.length) warn('pfiltergain changes are not exported (SDVX laser effects have fixed strength).');
		L.push('#SPCONTROLER', ...sp, '#END', '');
		sep();
		return { text: L.join('\n'), warnings };
	}

	// ---------------------------------------------------------------- MS-ADPCM WAV + 2DX
	const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
	const COEF1 = [256, 512, 0, 192, 240, 460, 392], COEF2 = [0, -256, 0, 64, 0, -208, -232];
	const BLOCK = 1024, SPB = 1012;
	const s16 = (v) => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
	// encode one channel's block with a given predictor and starting step; returns {pred, delta, s1, s2, nib, err}
	function encBlock(x, off, pred, delta0, keep) {
		const c1 = COEF1[pred], c2 = COEF2[pred];
		const x0 = x[off], x1 = x[off + 1];
		let s2 = x0, s1 = x1, delta = delta0; // header: sample2 is played first
		const nib = keep ? new Int8Array(SPB - 2) : null;
		let err = 0;
		for (let k = 2; k < SPB; k++) {
			const xs = x[off + k];
			const p = (s1 * c1 + s2 * c2) >> 8;
			let code = Math.round((xs - p) / delta);
			code = code < -8 ? -8 : code > 7 ? 7 : code;
			const y = s16(p + code * delta);
			err += (xs - y) * (xs - y);
			if (nib) nib[k - 2] = code;
			delta = (delta * ADAPT[code & 15]) >> 8; if (delta < 16) delta = 16;
			s2 = s1; s1 = y;
		}
		return { pred, delta: delta0, s1: x1, s2: x0, nib, err };
	}
	// pick the predictor / starting step with the smallest error over the whole block
	function bestBlock(x, off) {
		let d = 0; for (let k = 2; k < 18; k++) d += Math.abs(x[off + k] - x[off + k - 1]);
		const base = Math.max(16, Math.round(d / 16));
		let bp = 0, be = Infinity;
		for (let p = 0; p < 7; p++) { const r = encBlock(x, off, p, base, false); if (r.err < be) { be = r.err; bp = p; } }
		let bd = base;
		for (const m of [0.35, 0.6, 1.7, 3]) {
			const dl = Math.min(32767, Math.max(16, Math.round(base * m)));
			const r = encBlock(x, off, bp, dl, false); if (r.err < be) { be = r.err; bd = dl; }
		}
		return encBlock(x, off, bp, bd, true);
	}
	function encodeAdpcmWav(left, right, sr) {
		const n = left.length, nb = Math.max(1, Math.ceil(n / SPB));
		const toI = (f) => { const a = new Int16Array(nb * SPB); for (let i = 0; i < n; i++) { const v = f[i]; a[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767); } return a; };
		const L16 = toI(left), R16 = toI(right);
		const out = new Uint8Array(nb * BLOCK), dv = new DataView(out.buffer);
		for (let b = 0; b < nb; b++) {
			const off = b * SPB, base = b * BLOCK;
			const enc = [bestBlock(L16, off), bestBlock(R16, off)];
			out[base] = enc[0].pred; out[base + 1] = enc[1].pred;
			dv.setInt16(base + 2, enc[0].delta, true); dv.setInt16(base + 4, enc[1].delta, true);
			dv.setInt16(base + 6, enc[0].s1, true); dv.setInt16(base + 8, enc[1].s1, true);
			dv.setInt16(base + 10, enc[0].s2, true); dv.setInt16(base + 12, enc[1].s2, true);
			for (let k = 0; k < SPB - 2; k++) out[base + 14 + k] = ((enc[0].nib[k] & 15) << 4) | (enc[1].nib[k] & 15);
		}
		// RIFF: fmt (MS ADPCM, 7 coefficients), fact, LIST/INFO, data -- same layout as the game's own files
		const fmt = new Uint8Array(50), fv = new DataView(fmt.buffer);
		fv.setUint16(0, 2, true); fv.setUint16(2, 2, true); fv.setUint32(4, sr, true); fv.setUint32(8, 16000, true);
		fv.setUint16(12, BLOCK, true); fv.setUint16(14, 4, true); fv.setUint16(16, 32, true); fv.setUint16(18, SPB, true); fv.setUint16(20, 7, true);
		for (let i = 0; i < 7; i++) { fv.setInt16(22 + i * 4, COEF1[i], true); fv.setInt16(24 + i * 4, COEF2[i], true); }
		const info = new TextEncoder().encode('INFOISFT\x0e\x00\x00\x00Lavf58.76.100\x00');
		const chunks = [['fmt ', fmt], ['fact', new Uint8Array(new Uint32Array([nb * SPB]).buffer)], ['LIST', info], ['data', out]];
		let size = 4; for (const [, d] of chunks) size += 8 + d.length + (d.length & 1);
		const wav = new Uint8Array(8 + size), wv = new DataView(wav.buffer);
		const str = (o, s) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
		str(0, 'RIFF'); wv.setUint32(4, size, true); str(8, 'WAVE');
		let p = 12;
		for (const [id, d] of chunks) { str(p, id); wv.setUint32(p + 4, d.length, true); wav.set(d, p + 8); p += 8 + d.length + (d.length & 1); }
		return wav;
	}
	// decoder (used by tests and to double-check output)
	function decodeAdpcmWav(wav) {
		const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		let p = 12, data = null, ch = 2, ba = BLOCK, spb = SPB;
		while (p + 8 <= wav.length) {
			const id = String.fromCharCode(...wav.subarray(p, p + 4)), sz = dv.getUint32(p + 4, true);
			if (id === 'fmt ') { ch = dv.getUint16(p + 10, true); ba = dv.getUint16(p + 20, true); spb = dv.getUint16(p + 26, true); }
			if (id === 'data') data = wav.subarray(p + 8, p + 8 + sz);
			p += 8 + sz + (sz & 1);
		}
		const nb = Math.floor(data.length / ba), outs = [new Float32Array(nb * spb), new Float32Array(nb * spb)];
		const dd = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let b = 0; b < nb; b++) {
			const o = b * ba, st = [];
			for (let c = 0; c < ch; c++) st.push({ pr: data[o + c], d: dd.getInt16(o + ch + c * 2, true), s1: dd.getInt16(o + ch * 3 + c * 2, true), s2: dd.getInt16(o + ch * 5 + c * 2, true) });
			for (let c = 0; c < ch; c++) { outs[c][b * spb] = st[c].s2 / 32768; outs[c][b * spb + 1] = st[c].s1 / 32768; }
			let k = 2;
			for (let i = o + ch * 7; i < o + ba; i++) {
				const nibs = [data[i] >> 4, data[i] & 15];
				for (let j = 0; j < 2; j++) {
					const c = ch === 2 ? j : 0, s = st[c]; let nb4 = nibs[j]; const code = nb4 >= 8 ? nb4 - 16 : nb4;
					const pr = (s.s1 * COEF1[s.pr] + s.s2 * COEF2[s.pr]) >> 8;
					const y = s16(pr + code * s.d);
					s.d = Math.max(16, (s.d * ADAPT[nb4]) >> 8); s.s2 = s.s1; s.s1 = y;
					outs[c][b * spb + k] = y / 32768;
					if (ch === 1 || j === 1) k++;
				}
			}
		}
		return { left: outs[0], right: outs[1], samples: nb * spb };
	}
	function make2dx(name, wav) {
		const head = 72 + 4, out = new Uint8Array(head + 24 + wav.length), dv = new DataView(out.buffer);
		const nm = new TextEncoder().encode(name).subarray(0, 16); out.set(nm, 0);
		dv.setUint32(16, head, true); dv.setUint32(20, 1, true); dv.setUint32(72, head, true);
		out.set([0x32, 0x44, 0x58, 0x39], head); // "2DX9"
		dv.setUint32(head + 4, 24, true); dv.setUint32(head + 8, wav.length, true);
		out.set([0x31, 0x32, 0xff, 0xff, 0x40, 0, 0, 0, 0, 0, 0, 0], head + 12);
		out.set(wav, head + 24);
		return out;
	}
	// cut [start, start+len) seconds of an AudioBuffer (negative start pads with silence), optional fades
	function sliceAudio(buf, start, len, fadeIn, fadeOut) {
		const sr = buf.sampleRate, n = Math.max(1, Math.round(len * sr)), s0 = Math.round(start * sr);
		const outs = [new Float32Array(n), new Float32Array(n)];
		for (let c = 0; c < 2; c++) {
			const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), o = outs[c];
			for (let i = 0; i < n; i++) { const k = s0 + i; o[i] = k >= 0 && k < src.length ? src[k] : 0; }
			const fi = Math.round((fadeIn || 0) * sr), fo = Math.round((fadeOut || 0) * sr);
			for (let i = 0; i < fi && i < n; i++) o[i] *= i / fi;
			for (let i = 0; i < fo && i < n; i++) o[n - 1 - i] *= i / fo;
		}
		return outs;
	}

	// ---------------------------------------------------------------- Shift-JIS, music_db
	let SJIS = null;
	function sjisEncode(str, bad) {
		if (!SJIS) {
			SJIS = new Map();
			const dec = new TextDecoder('shift_jis');
			for (let b = 0xa1; b <= 0xdf; b++) SJIS.set(dec.decode(new Uint8Array([b])), [b]);
			for (let lead = 0x81; lead <= 0xfc; lead++) {
				if (lead > 0x9f && lead < 0xe0) continue;
				for (let tr = 0x40; tr <= 0xfc; tr++) {
					if (tr === 0x7f) continue;
					const ch = dec.decode(new Uint8Array([lead, tr]));
					if (ch.length === 1 && ch !== '�' && !SJIS.has(ch)) SJIS.set(ch, [lead, tr]);
				}
			}
		}
		const out = [];
		for (const ch of str) {
			const cp = ch.codePointAt(0);
			if (cp < 0x80) { out.push(cp); continue; }
			const m = SJIS.get(ch);
			if (m) out.push(...m); else { out.push(0x3f); if (bad) bad.add(ch); }
		}
		return new Uint8Array(out);
	}
	const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	function musicDb(o) {
		const T = (name, v, type) => `<${name}${type ? ` __type="${type}"` : ''}>${xmlEsc(v)}</${name}>`;
		const charts = SLOTS.map(sl => {
			const on = sl.id === o.slot;
			return `      <${sl.id}>\n` + [
				T('difnum', on ? o.difnum : 0, 'u8'), T('illustrator', on ? o.illustrator : ''), T('effected_by', on ? o.effector : ''),
				T('price', -1, 's32'), T('limited', 3, 'u8'), T('jacket_print', -2, 's32'), T('jacket_mask', 0, 's32'), T('max_exscore', 0, 's32'),
			].map(x => '        ' + x).join('\n') + '\n        <radar>\n' + ['notes', 'peak', 'tsumami', 'tricky', 'hand_trip', 'one_hand'].map(k => '          ' + T(k, 0, 'u16')).join('\n') + `\n        </radar>\n      </${sl.id}>`;
		}).join('\n');
		const info = [
			T('title_name', o.title), T('title_yomigana', o.titleYomi || o.title), T('artist_name', o.artist), T('artist_yomigana', o.artistYomi || o.artist),
			T('ascii', o.ascii), T('bpm_max', Math.round(o.bpmMax * 100), 'u32'), T('bpm_min', Math.round(o.bpmMin * 100), 'u32'),
			T('distribution_date', o.date, 'u32'), T('volume', o.volume, 'u16'), T('bg_no', o.bgNo ?? 2, 'u16'), T('genre', 0, 'u32'),
			T('is_fixed', 1, 'u8'), T('version', o.version, 'u8'), T('demo_pri', 0, 's8'), T('inf_ver', o.infVer, 'u8'),
		].map(x => '      ' + x).join('\n');
		return `<?xml version="1.0" encoding="shift-jis"?>\n<mdb>\n  <music id="${o.id}">\n    <info>\n${info}\n    </info>\n    <difficulty>\n${charts}\n    </difficulty>\n  </music>\n</mdb>\n`;
	}

	// ---------------------------------------------------------------- zip (store only)
	let CRC = null;
	function crc32(d) {
		if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
		let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	}
	function zip(files) { // [{name, data: Uint8Array}]
		const enc = new TextEncoder(), parts = [], central = [];
		let off = 0;
		const now = new Date(), dt = ((now.getFullYear() - 1980) << 25) | ((now.getMonth() + 1) << 21) | (now.getDate() << 16) | (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
		for (const f of files) {
			const nm = enc.encode(f.name), crc = crc32(f.data);
			const h = new Uint8Array(30 + nm.length), v = new DataView(h.buffer);
			v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
			v.setUint32(10, dt, true); v.setUint32(14, crc, true); v.setUint32(18, f.data.length, true); v.setUint32(22, f.data.length, true);
			v.setUint16(26, nm.length, true); h.set(nm, 30);
			const cd = new Uint8Array(46 + nm.length), w = new DataView(cd.buffer);
			w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true);
			w.setUint32(12, dt, true); w.setUint32(16, crc, true); w.setUint32(20, f.data.length, true); w.setUint32(24, f.data.length, true);
			w.setUint16(28, nm.length, true); w.setUint32(42, off, true); cd.set(nm, 46);
			parts.push(h, f.data); central.push(cd); off += h.length + f.data.length;
		}
		const cdSize = central.reduce((a, b) => a + b.length, 0);
		const e = new Uint8Array(22), ev = new DataView(e.buffer);
		ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
		ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
		return new Blob([...parts, ...central, e], { type: 'application/zip' });
	}

	// ---------------------------------------------------------------- package
	async function jacketPngs(file, sizes) {
		const img = await createImageBitmap(file);
		const out = {};
		for (const [key, s] of Object.entries(sizes)) {
			const cv = document.createElement('canvas'); cv.width = s; cv.height = s;
			const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high';
			const m = Math.min(img.width, img.height); g.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
			const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
			out[key] = new Uint8Array(await blob.arrayBuffer());
		}
		return out;
	}
	// o: {id, ascii, slot, difnum, version, infVer, volume, laserEdge, title, artist, titleYomi, artistYomi, illustrator, effector, jacket(File), audioBytes(ArrayBuffer), offsetMs, previewMs, previewLen, bpmMin, bpmMax}
	async function buildPackage(chart, o, progress) {
		const files = [], warnings = [];
		const stem = pad(o.id, 4) + '_' + o.ascii, slot = SLOTS.find(s => s.id === o.slot), dir = o.ascii + '/music/' + stem + '/';
		const vox = buildVox(chart, { laserEdge: o.laserEdge });
		warnings.push(...vox.warnings);
		files.push({ name: dir + stem + '_' + slot.n + slot.l + '.vox', data: new TextEncoder().encode(vox.text) });
		if (o.audioBytes) {
			progress && progress('Decoding audio at 44.1 kHz…');
			const ac = new OfflineAudioContext(2, 44100, 44100);
			const buf = await ac.decodeAudioData(o.audioBytes.slice(0));
			const start = (o.offsetMs || 0) / 1000;
			progress && progress('Encoding song (MS-ADPCM)…'); await new Promise(r => setTimeout(r, 30));
			const [l, r] = sliceAudio(buf, start, buf.duration - start, 0, 0);
			files.push({ name: dir + stem + '.2dx', data: make2dx(stem + '.2dx', encodeAdpcmWav(l, r, 44100)) });
			progress && progress('Encoding preview…'); await new Promise(r2 => setTimeout(r2, 30));
			const pl = (o.previewLen > 0 ? o.previewLen : 15000) / 1000;
			const [pl0, pr0] = sliceAudio(buf, (o.previewMs || 0) / 1000, pl, 0.3, 1.5);
			files.push({ name: dir + stem + '_pre.2dx', data: make2dx(stem + '_pre.2dx', encodeAdpcmWav(pl0, pr0, 44100)) });
		} else warnings.push({ t: 0, msg: 'No audio loaded: the .2dx files were not created.' });
		if (o.jacket) {
			progress && progress('Making jackets…');
			const j = await jacketPngs(o.jacket, { n: 300, s: 108, b: 676, t: 128 });
			const jb = 'jk_' + pad(o.id, 4) + '_' + slot.n;
			files.push({ name: dir + jb + '.png', data: j.n }, { name: dir + jb + '_s.png', data: j.s }, { name: dir + jb + '_b.png', data: j.b });
			files.push({ name: o.ascii + '/graphics/s_jacket00_ifs/' + jb + '_t.png', data: j.t });
		} else warnings.push({ t: 0, msg: 'No jacket image chosen: the game will show a blank jacket.' });
		const bad = new Set();
		const db = sjisEncode(musicDb({ ...o, date: o.date || Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')) }), bad);
		if (bad.size) warnings.push({ t: 0, msg: 'These characters cannot be written in Shift-JIS and became "?": ' + [...bad].join(' ') });
		files.push({ name: o.ascii + '/others/music_db.merged.xml', data: db });
		files.push({ name: o.ascii + '/README.txt', data: new TextEncoder().encode(
			'Copy the "' + o.ascii + '" folder into your game\'s data_mods folder (LayeredFS).\r\n' +
			'Song id ' + o.id + ', chart slot ' + slot.label + '.\r\n' +
			'others/music_db.merged.xml holds this song\'s entry; if your setup merges music_db files by hand, add the <music> element to your music_db.xml.\r\n\r\n' +
			(warnings.length ? 'Notes from the export:\r\n' + warnings.map(w => '- ' + w.msg).join('\r\n') + '\r\n' : '')) });
		return { blob: zip(files), files, warnings };
	}

	return { SLOTS, KSH_DIFF_SLOT, buildVox, encodeAdpcmWav, decodeAdpcmWav, make2dx, sliceAudio, sjisEncode, musicDb, zip, crc32, buildPackage };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SDVX;
