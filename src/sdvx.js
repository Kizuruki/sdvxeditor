/* ============================================================================
 * SOUND VOLTEX export and import: .vox chart (format 12 or 10), .2dx audio
 * (MS-ADPCM WAV in a 2DX container), music_db entry (Shift-JIS XML), jackets,
 * all in one .zip laid out like the game's data/music folder. Mappings follow the user's working pair
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
	const SE_CODE = { clap: 3, clap_punchy: 3, clap_impact: 2, snare: 5, snare_lo: 4 };
	// FX hold effect -> #FXBUTTON EFFECT INFO line (the mapping lives in fx.js, so playback in "SOUND VOLTEX" mode matches)
	function fxLine(e, warn) {
		if (e.type === 'Phaser' && !e.sv) warn('Phaser has no SDVX equivalent; exported as Flanger.');
		const p = KSMFX.sdvxParams(e);
		return p ? KSMFX.svLine(p) : null;
	}

	function buildVox(chartIn, opts = {}) {
		const warnings = [];
		const warn = (msg, t) => { if (!warnings.some(w => w.msg === msg)) warnings.push({ t: t || 0, msg }); };
		const c = K.toUsc(chartIn, warnings, 'SOUND VOLTEX'); // no curves, rotation folded into tilt
		const tm = new K.Timing(c);
		const edge = opts.laserEdge || 124;
		const V12 = (opts.format || 12) >= 12; // 12 = current games (decimal laser positions, explicit spin lengths); 10 = older tools
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
		sec('FORMAT VERSION', [V12 ? '12' : '10']);
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
		sec('TAB EFFECT INFO', KSMFX.TAB_STD.map(r => KSMFX.svLine(r, true)));
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
		// lasers running an FX effect (a #define_filter with an FX type) -> "auto tab" spans over the lasers, one pair per effect
		const laserSpans = [];
		for (const lane of c.laser) for (const s of lane) laserSpans.push([s.t, K.sectionEndTick(s)]);
		laserSpans.sort((a, b) => a[0] - b[0]);
		const merged = [];
		for (const iv of laserSpans) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push(iv.slice()); }
		const fsteps = [{ t: 0, v: KSMFX.filterKind(c.meta.filtertype, defines) }, ...c.filterType.map(p => ({ t: p.t, v: KSMFX.filterKind(p.v, defines) }))];
		const autoRows = [], autoPair = new Map();
		fsteps.forEach((f, i) => {
			const base = KSMFX.kindBase(f.v); if (!base.startsWith('fx:')) return;
			const t0 = f.t, t1 = i + 1 < fsteps.length ? fsteps[i + 1].t : Infinity;
			const [type, a, b] = base.slice(3).split(';');
			const p = KSMFX.sdvxParams({ type, p0: +a, p1: +b, sv: KSMFX.kindSv(f.v) });
			if (!p) { warn('Laser effect "' + type + '" has no SDVX equivalent and was left out.', t0); return; }
			const line = KSMFX.svLine(p);
			for (const [s0, s1] of merged) {
				const a0 = Math.max(s0, t0), a1 = Math.min(s1, t1); if (a1 <= a0) continue;
				if (!autoPair.has(line)) { autoPair.set(line, 2 + pairRows.length / 3); pairRows.push(line, '0,\t0,\t0,\t0,\t0,\t0,\t0', ''); }
				autoRows.push(`${pos(a0)}\t${cells(a1 - a0)}\t${autoPair.get(line)}`);
			}
		});
		L.push('#FXBUTTON EFFECT INFO', ...pairRows, '#END', '');
		const assign = []; for (let i = 0; i < 12; i++) assign.push(i + ',\t0,\t0.00,\t0.00', i + ',\t0,\t0.00,\t0.00');
		sec('TAB PARAM ASSIGN INFO', assign);
		sec('REVERB EFFECT PARAM', []);
		L.push('//====================================', '// TRACK INFO', '//====================================', '');
		// lasers
		const filterAt = (t) => { const p = K.lastAtOrBefore(c.filterType, t); return KSMFX.tabCode(KSMFX.filterKind(p ? p.v : c.meta.filtertype, defines)); };
		const spinAt = new Map(c.spins.map(s => [s.t, s]));
		const usedSpins = new Set();
		// SDVX has no spin direction: the game turns with the slam the roll sits on (the importer reads it back the same
		// way: spin dir = -slam dir). When several slams share the spin's tick, use one that goes the right way.
		const spinSlam = new Map();
		for (const pass of [true, false]) for (const lane of c.laser) for (const sec of lane) for (const p of sec.pts) {
			const sp = spinAt.get(sec.t + p.ry); if (!sp || spinSlam.has(sp) || p.v === p.vf) continue;
			if (!pass || Math.sign(p.vf - p.v) === -sp.dir) spinSlam.set(sp, p);
		}
		// SDVX spin durations include the overshoot, so they are twice the KSH length
		const rollCode = (s) => {
			const beats = 2 * s.l / 240;
			if (V12) return s.kind === 'spin' ? [6, Math.max(1, Math.round(beats * 10))] : [7, Math.max(1, Math.round(beats * 10))]; // length in 1/10 beats
			if (s.kind !== 'spin') return [5, 0]; // half spin / swing -> 3-beat swing
			return [[[2, 2], [3, 3], [1, 7]].reduce((best, [code, b]) => Math.abs(b - beats) < Math.abs(best[1] - beats) ? [code, b] : best, [2, 2])[0], 0];
		};
		const laserTrack = (lane) => {
			const rows = [];
			for (const s of c.laser[lane]) {
				const range = s.wide ? 2 : 1, last = s.pts.length - 1;
				const val = (v) => { v = K.clamp(v, 0, 50); return v <= 0 ? 0 : Math.ceil(v * (edge + 1) / 50 - 1e-9) - 1; }; // same as the reference conversion: 1->2, 2->4, 25->62, 47->117, 50->124
				const row = (t, v, node, roll, fc) => V12
					? `${pos(t)}\t${(K.clamp(v, 0, 50) / 50).toFixed(6)}\t${node}\t${roll[0]}\t${fc}\t${range}\t0\t0\t${roll[1]}`
					: `${pos(t)}\t${val(v)}\t${node}\t${roll[0]}\t${fc}\t${range}\t0`;
				s.pts.forEach((p, i) => {
					const t = s.t + p.ry, fc = filterAt(t);
					if (p.v !== p.vf) {
						const sp = spinAt.get(t); let roll = [0, 0];
						if (sp && spinSlam.get(sp) === p) { roll = rollCode(sp); usedSpins.add(sp); }
						rows.push(row(t, p.v, i === 0 ? 1 : 0, roll, fc));
						rows.push(row(t, p.vf, i === last ? 2 : 0, [0, 0], fc));
					} else rows.push(row(t, p.v, i === 0 ? 1 : i === last ? 2 : 0, [0, 0], fc));
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
		L.push('#TRACK AUTO TAB', ...autoRows, '#END', '');
		sep();
		// SPCONTROLER: camera graphs
		const sp = ['001,01,00\tRealize\t3\t0\t36.12\t60.12\t110.12\t0.00', '001,01,00\tRealize\t4\t0\t0.62\t0.72\t1.03\t0.00',
			'001,01,00\tAIRL_ScaX\t1\t0\t0.00\t1.00\t0.00\t0.00', '001,01,00\tAIRR_ScaX\t1\t0\t0.00\t2.00\t0.00\t0.00'];
		const graph = (name, pts, conv) => {
			const num = pts.filter(p => typeof p.v === 'number');
			if (!num.length || num.every(p => p.v === 0 && (p.vf === undefined || p.vf === 0))) return;
			// like the game's own files: one row per segment, from the start of the chart to its end position
			const first = conv(num[0].v), endT = tm.measureStart(endM);
			if (num[0].t > 0) sp.push(`001,01,00\t${name}\t2\t${cells(num[0].t)}\t${f2(first)}\t${f2(first)}\t0.00\t0.00`);
			num.forEach((p, i) => {
				const q = num[i + 1], a = conv(p.v), b = conv(typeof p.vf === 'number' ? p.vf : p.v);
				if (a !== b) sp.push(`${pos(p.t)}\t${name}\t2\t0\t${f2(a)}\t${f2(b)}\t0.00\t0.00`);
				const until = q ? q.t : endT;
				if (until > p.t) sp.push(`${pos(p.t)}\t${name}\t2\t${cells(until - p.t)}\t${f2(b)}\t${f2(q ? conv(q.v) : b)}\t0.00\t0.00`);
			});
		};
		graph('CAM_RotX', c.cam.zoom_top, CAM.rotX);
		graph('CAM_Radi', c.cam.zoom_bottom, CAM.radi);
		graph('Morphing2', c.cam.center_split, CAM.split);
		// manual tilt (vox +1 = ksh -1.5); tilt=zero spans hold the lane flat
		const tiltSpans = [];
		for (let i = 0; i < c.tilt.length; i++) {
			const p = c.tilt[i], q = c.tilt[i + 1];
			const after = p.vf !== undefined ? p.vf : p.v;
			if (typeof p.v === 'number') {
				const a = CAM.tiltOut(p.v), b = typeof after === 'number' ? CAM.tiltOut(after) : CAM.tiltOut(p.v);
				if (a !== b) tiltSpans.push(`${pos(p.t)}\tTilt\t2\t0\t${f2(a)}\t${f2(b)}\t0.00\t0.00`);
				if (q && typeof after === 'number') tiltSpans.push(`${pos(p.t)}\tTilt\t2\t${cells(q.t - p.t)}\t${f2(b)}\t${f2(typeof q.v === 'number' ? CAM.tiltOut(q.v) : b)}\t0.00\t0.00`);
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
		return { text: L.join(V12 ? '\r\n' : '\n'), warnings };
	}

	// ---------------------------------------------------------------- VOX import
	// Camera / tilt scales shared by import and export. They come from hand-made USC conversions of official
	// charts (e.g. 777 MXM): CAM_RotX 0.5 ~ zoom_top 80 / -0.5 ~ -60, CAM_Radi 1.0 ~ zoom_bottom -130, Tilt 1.0 ~ tilt -1.5.
	const CAM = {
		rotX: (zt) => K.clamp(zt >= 0 ? zt / 140 : zt / 120, -1, 1), zoomTop: (v) => v >= 0 ? v * 140 : v * 120,
		radi: (zb) => K.clamp(zb <= 0 ? -zb / 125 : -zb / 75, -1, 1), zoomBottom: (v) => v >= 0 ? -v * 125 : -v * 75,
		tiltOut: (t) => -t / 1.5, tiltIn: (v) => -v * 1.5,
		split: (cs) => cs / 100 * 0.75, splitIn: (v) => v / 0.75 * 100,
	};
	// KSH effect string ('Retrigger;8', 'Echo;4;60', ...) -> parameters of an equivalent #define_fx / #define_filter
	function kshDefParams(ksh) {
		const [type, a, b] = ksh.split(';');
		let def = 'type=' + type;
		if (/Retrigger|Gate|Wobble|Echo/.test(type) && a) def += ';waveLength=1/' + a;
		if (type === 'Echo' && b) def += ';feedbackLevel=' + b + '%';
		if (type === 'BitCrusher' && a) def += ';reduction=' + a + 'samples;amount=' + a + 'samples'; // KSM reads reduction, USC reads amount
		if (type === 'PitchShift' && a) def += ';pitch=' + a;
		if (type === 'TapeStop' && a) def += ';speed=' + a + '%';
		return def;
	}
	// FX pair line -> KSH effect string (inverse of fxLine)
	function fxFromLine(f, warn) {
		const n = (i) => parseFloat(f[i]);
		switch (+f[0]) {
			case 1: { const N = Math.max(1, Math.round(4 * n(1) / (n(3) || 2))); return n(4) < 0.95 ? 'Echo;' + N + ';' + Math.round(n(4) * 100) : 'Retrigger;' + N; }
			case 8: { const N = Math.max(1, Math.round(4 * n(1) / (n(3) || 2))); return 'Echo;' + N + ';' + Math.round(K.clamp(n(4), 0, 1) * 100); }
			case 2: return 'Gate;' + Math.max(1, Math.round(2 * n(2) / (n(3) || 1)));
			case 3: return 'Flanger';
			case 4: return 'TapeStop;' + K.clamp(Math.round(22 / (n(3) || 0.44)), 1, 100);
			case 10: warn('"Tape Stop Ex" FX were imported as plain TapeStop.'); return 'TapeStop;50';
			case 5: return 'SideChain';
			case 6: return 'Wobble;' + Math.max(1, Math.round(n(6) * 3));
			case 7: return 'BitCrusher;' + Math.round(n(2));
			case 9: return 'PitchShift;' + Math.round(n(2));
			case 13: return n(2) ? 'PitchShift;' + Math.round(n(2)) : null;
			case 11: case 12: warn('Low/high-pass FX holds have no KSH equivalent and were left without an effect.'); return null;
		}
		return null;
	}
	function importVox(text, fileName) {
		const warnings = [];
		const warn = (msg, t) => { if (!warnings.some(w => w.msg === msg)) warnings.push({ t: t || 0, msg }); };
		const S = {}; let sec = null;
		for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
			const ci = line.indexOf('//'); if (ci >= 0) line = line.slice(0, ci);
			if (!line.trim()) { if (sec && S[sec]) S[sec].push(null); continue; } // blank lines separate FX pairs
			if (line.startsWith('#')) { const nm = line.trim().slice(1); if (nm === 'END') sec = null; else { sec = nm; S[sec] = S[sec] || []; } continue; }
			if (sec) S[sec].push(line.split('\t').map(x => x.trim().replace(/,$/, '')));
		}
		const rows = (name) => (S[name] || []).filter(Boolean);
		const ver = parseInt((rows('FORMAT VERSION')[0] || ['10'])[0], 10) || 10;
		const res = parseInt((rows('BEAT RESOLUTION')[0] || ['48'])[0], 10) || 48; // cells per quarter note
		const c = K.newChart(); const id = () => K.nid();
		// time signatures first: positions depend on them
		c.sig = [];
		for (const r of rows('BEAT INFO')) { const m = parseInt(r[0], 10) - 1; if (!c.sig.some(x => x.m === m)) c.sig.push({ id: id(), m, n: +r[1], d: +r[2] }); }
		if (!c.sig.length || c.sig[0].m !== 0) c.sig.unshift({ id: id(), m: 0, n: 4, d: 4 });
		K.sortByT(c.sig.map(x => (x.t = x.m, x))); c.sig.sort((a, b) => a.m - b.m); c.sig.forEach(x => delete x.t);
		let tm = new K.Timing(c);
		const tick = (p) => {
			const [m, b, cc] = String(p).split(',').map(Number);
			const ms = tm.measureOf(tm.measureStart(m - 1));
			const perCell = 240 / res; // ticks per cell
			return Math.round(ms.start + (b - 1) * 960 / ms.d + cc * perCell);
		};
		// BPM and pauses ("4-" starts a stop that lasts until the next BPM row)
		const bpmRows = rows('BPM INFO').map(r => ({ t: tick(r[0]), v: parseFloat(r[1]), stop: String(r[2]).includes('-') })).sort((a, b) => a.t - b.t);
		c.bpm = []; c.stops = [];
		bpmRows.forEach((r, i) => {
			const last = c.bpm[c.bpm.length - 1];
			if (!last || Math.abs(last.v - r.v) > 1e-6) c.bpm.push({ id: id(), t: c.bpm.length ? r.t : 0, v: r.v });
			if (r.stop) { const nx = bpmRows[i + 1]; if (nx && nx.t > r.t) c.stops.push({ id: id(), t: r.t, l: nx.t - r.t }); }
		});
		if (!c.bpm.length) c.bpm.push({ id: id(), t: 0, v: 120 });
		tm = new K.Timing(c);
		c.meta.t = K.autoDispBpm(c);
		// FX effect pairs (index 2 = first pair); a pair's first non-empty effect is used
		const pairs = []; let cur = [];
		for (const r of (S['FXBUTTON EFFECT INFO'] || [])) { if (r === null) { if (cur.length) pairs.push(cur); cur = []; } else cur.push(r); }
		if (cur.length) pairs.push(cur);
		// Effects become #define_fx / #define_filter lines carrying the exact SDVX row ("sdvx=..."), so playback in
		// SOUND VOLTEX mode and a re-export use the original parameters; USC / KSM use the KSH approximation.
		const defLines = [], defNames = new Map(), usedNames = new Set();
		const define = (kind, label, params, f) => {
			const key = kind + '|' + f.join(',');
			if (defNames.has(key)) return defNames.get(key);
			const stem = label.replace(/[^A-Za-z0-9]+/g, '_').replace(/_$/, '');
			let name = stem, k = 2; while (usedNames.has(name)) name = stem + '_' + k++;
			usedNames.add(name); defNames.set(key, name);
			defLines.push('#define_' + kind + ' ' + name + ' ' + params + ';sdvx=' + f.join(','));
			return name;
		};
		const pairFx = pairs.map(p => { for (const f of p) if (+f[0] !== 0) { const ksh = fxFromLine(f, warn); return ksh ? { ksh, f } : null; } return null; });
		const tabFx = rows('TAB EFFECT INFO').map(f => {
			const base = ({ 1: 'lpf1', 2: 'hpf1', 3: 'bitc' })[+f[0]]; if (!base) return 'peak';
			const v = f.map(Number), std = KSMFX.TAB_STD[{ lpf1: 0, hpf1: 2, bitc: 4 }[base]];
			if (base === 'bitc' || (std.length === v.length && std.every((x, j) => Math.abs(x - v[j]) < 1e-6))) return base;
			return define('filter', 'SV_' + (base === 'lpf1' ? 'LPF' : 'HPF') + '_' + Math.round(v[2]) + '_' + Math.round(v[3]) + '_Q' + v[4], 'type=' + (base === 'lpf1' ? 'LowPassFilter' : 'HighPassFilter'), f);
		});
		// BT / FX
		const SE_IN = { 2: 'clap_impact', 3: 'clap', 4: 'snare_lo', 5: 'snare' };
		[3, 4, 5, 6].forEach((tr, lane) => { c.bt[lane] = rows('TRACK' + tr).map(r => ({ id: id(), t: tick(r[0]), l: Math.round((+r[1] || 0) * 240 / res) })).sort((a, b) => a.t - b.t); });
		[[2, 0], [7, 1]].forEach(([tr, lane]) => {
			c.fx[lane] = rows('TRACK' + tr).map(r => {
				const n = { id: id(), t: tick(r[0]), l: Math.round((+r[1] || 0) * 240 / res) };
				const code = +r[2] || 0;
				if (n.l > 0 && code >= 2) { const e = pairFx[code - 2]; if (e) n.fx = define('fx', 'SV_' + e.ksh, kshDefParams(e.ksh), e.f); }
				if (n.l === 0 && SE_IN[code]) n.se = SE_IN[code];
				else if (n.l === 0 && code && code !== 255) warn('Some FX chip sounds have no KSM equivalent and were left out.', n.t);
				return n;
			}).sort((a, b) => a.t - b.t);
		});
		// lasers
		const laserRows = [rows('TRACK1'), rows('TRACK8')];
		let maxRaw = 0; if (ver < 12) for (const lr of laserRows) for (const r of lr) maxRaw = Math.max(maxRaw, +r[1]);
		const scale = ver >= 12 ? 50 : 50 / (maxRaw <= 124 && maxRaw > 100 ? 124 : 127);
		const filterEvents = []; // {t, code}
		const DEF_ROLL = { 1: 7, 2: 2, 3: 3, 4: 12, 5: 3, 6: 7, 7: 3 };
		laserRows.forEach((lr, lane) => {
			let sec = null; const out = [];
			const finish = () => { if (sec && sec.pts.length) out.push(simplifyLaser(sec)); sec = null; };
			for (let i = 0; i < lr.length; i++) {
				const r = lr[i], t = tick(r[0]), v = (+r[1]) * scale, node = +r[2], roll = +r[3] || 0, fcode = +r[4] || 0, wide = +r[5] === 2;
				const lenCol = ver >= 13 ? r[9] : r[8];
				if (node === 1 || !sec) { finish(); sec = { t, wide, pts: [] }; }
				const ry = t - sec.t, last = sec.pts[sec.pts.length - 1];
				if (last && last.ry === ry) last.vf = v; // second row on the same tick: slam
				else sec.pts.push({ ry, v, vf: v });
				filterEvents.push({ t, code: fcode });
				if (roll) {
					const nx = lr[i + 1], dir = nx && tick(nx[0]) === t ? Math.sign((+nx[1]) * scale - v) || 1 : 1;
					const len = +lenCol || 0, beats = roll >= 6 ? (len ? len / 10 : DEF_ROLL[roll]) : (len || DEF_ROLL[roll]);
					if (!c.spins.some(x => x.t === t)) c.spins.push({ id: id(), t, kind: roll === 5 || roll === 7 ? 'half' : 'spin', dir: -dir, l: Math.max(60, Math.round(beats / 2 * 240)), amp: 250, rep: 3, dec: 2 });
				}
				if (node === 2) finish();
			}
			finish();
			c.laser[lane] = out.map(sc => ({ id: id(), t: sc.t, wide: sc.wide, pts: sc.pts.map(p => ({ id: id(), ry: p.ry, v: p.v, vf: p.vf, a: 0, b: 0 })) })).sort((a, b) => a.t - b.t);
		});
		c.spins.sort((a, b) => a.t - b.t);
		// laser effects: per-node filter codes, plus "auto tab" spans that run an FX effect on the lasers
		const autoTab = rows('TRACK AUTO TAB').map(r => ({ t: tick(r[0]), e: tick(r[0]) + Math.round((+r[1] || 0) * 240 / res), fx: pairFx[(+r[2] || 0) - 2] })).filter(a => a.fx);
		const filterName = (code) => code === 0 || code === 6 ? 'peak' : (tabFx[code - 1] || 'peak');
		filterEvents.sort((a, b) => a.t - b.t);
		const changes = [];
		let curF = 'peak';
		const autoAt = (t) => autoTab.find(a => t >= a.t && t < a.e);
		const pts = [...new Set([...filterEvents.map(e => e.t), ...autoTab.flatMap(a => [a.t, a.e])])].sort((a, b) => a - b);
		let fi = 0, base = 'peak';
		for (const t of pts) {
			while (fi < filterEvents.length && filterEvents[fi].t <= t) base = filterName(filterEvents[fi++].code);
			const at = autoAt(t);
			let want = base;
			if (at) {
				const name = define('filter', 'AT_' + at.fx.ksh, kshDefParams(at.fx.ksh), at.fx.f);
				want = name;
			}
			if (want !== curF) { changes.push({ id: id(), t, v: want }); curF = want; }
		}
		c.filterType = changes.filter((e, i) => !(i === 0 && e.t === 0 && e.v === 'peak'));
		c.defs = defLines;
		if (autoTab.length) warn('Laser "auto tab" effects were imported as custom laser effects (#define_filter); USC plays them, KSM v1 may not.');
		// camera (SPCONTROLER segments)
		const graphs = {};
		for (const r of rows('SPCONTROLER')) {
			const name = r[1], t = tick(r[0]), len = Math.round((+r[3] || 0) * 240 / res), a = parseFloat(r[4]), b = parseFloat(r[5]);
			if (!['CAM_RotX', 'CAM_Radi', 'Tilt', 'Morphing2'].includes(name)) { if (!['Realize', 'AIRL_ScaX', 'AIRR_ScaX'].includes(name)) warn('SPCONTROLER "' + name + '" has no KSH equivalent and was skipped.', t); continue; }
			(graphs[name] = graphs[name] || []).push({ t, len, a, b });
		}
		const toGraph = (segs, conv, round) => {
			const out = []; segs.sort((x, y) => x.t - y.t || x.len - y.len);
			const fmt = (v) => round ? Math.round(v) : Math.round(v * 100) / 100;
			const put = (t, v) => { const l = out[out.length - 1]; if (l && l.t === t) { if (l.v !== v) l.vf = v; else delete l.vf; } else if (!l || (l.vf ?? l.v) !== v || true) out.push({ id: id(), t, v, a: 0, b: 0 }); };
			for (const sg of segs) { put(sg.t, fmt(conv(sg.a))); if (sg.len > 0) put(sg.t + sg.len, fmt(conv(sg.b))); }
			// drop points that sit on a straight line between their neighbours
			return out.filter((p, i) => {
				const q = out[i - 1], n = out[i + 1];
				if (!q || !n || p.vf !== undefined || q.vf !== undefined) return true;
				const lin = q.v + (n.v - q.v) * (p.t - q.t) / (n.t - q.t);
				return Math.abs(lin - p.v) > 0.01;
			});
		};
		if (graphs.CAM_RotX) c.cam.zoom_top = toGraph(graphs.CAM_RotX, CAM.zoomTop, true);
		if (graphs.CAM_Radi) c.cam.zoom_bottom = toGraph(graphs.CAM_Radi, CAM.zoomBottom, true);
		if (graphs.Morphing2) c.cam.center_split = toGraph(graphs.Morphing2, CAM.splitIn, true);
		// tilt: modes, then manual segments (auto tilt comes back after a manual series ends)
		const tilt = [];
		for (const r of rows('TILT MODE INFO')) { const t = tick(r[0]), m = +r[1]; tilt.push({ id: id(), t, v: m === 2 ? 'keep_bigger' : m === 1 ? 'bigger' : 'normal', a: 0, b: 0 }); }
		if (graphs.Tilt) {
			const segs = graphs.Tilt.sort((x, y) => x.t - y.t);
			let i = 0;
			while (i < segs.length) {
				let j = i; while (j + 1 < segs.length && segs[j + 1].t <= segs[j].t + segs[j].len) j++;
				const series = toGraph(segs.slice(i, j + 1), CAM.tiltIn, false);
				const endT = segs[j].t + segs[j].len;
				const mode = K.lastAtOrBefore(tilt.filter(p => typeof p.v === 'string'), endT);
				for (const p of series) { const k = tilt.findIndex(x => x.t === p.t); if (k >= 0) tilt.splice(k, 1); tilt.push(p); }
				const lastP = series[series.length - 1];
				if (lastP) lastP.vf = mode ? mode.v : 'normal';
				i = j + 1;
			}
		}
		c.tilt = tilt.sort((a, b) => a.t - b.t).filter((p, i, arr) => !(i === 0 && p.t === 0 && p.v === 'normal' && arr.length === 1));
		// header
		const fbase = String(fileName || 'chart.vox').replace(/\.vox$/i, '');
		const m = /_(\d)([naeimuhgvx])$/i.exec(fbase);
		c.meta.title = fbase.replace(/^\d+_/, '').replace(/_\d[a-z]$/i, '');
		c.meta.difficulty = m ? ({ 1: 'light', 2: 'challenge', 3: 'extended' })[m[1]] || 'infinite' : 'infinite';
		c.meta.pfiltergain = '50'; c.meta.chokkakuvol = '50'; c.meta.filtertype = 'peak'; c.meta.o = '0';
		warnings.push({ t: 0, msg: 'Imported from SOUND VOLTEX .vox (format ' + ver + '). Title, artist and level are not stored in .vox files; set them in the Chart tab and load the song audio.' });
		return { chart: c, warnings };
	}
	// thin dense laser samples (v12 stores curves every few cells) so the chart stays editable and valid KSH:
	// keep slams and corners, drop points that lie on a straight line within half a laser step, keep points > 1/32 apart
	function simplifyLaser(sec) {
		const P = sec.pts;
		const keep = new Array(P.length).fill(false);
		keep[0] = keep[P.length - 1] = true;
		P.forEach((p, i) => { if (p.v !== p.vf) { keep[i] = true; } });
		const rdp = (a, b) => {
			if (b <= a + 1) return;
			const pa = P[a], pb = P[b];
			let worst = -1, wd = 0.6;
			for (let i = a + 1; i < b; i++) {
				const p = P[i], lin = pa.vf + (pb.v - pa.vf) * (p.ry - pa.ry) / (pb.ry - pa.ry);
				const d = Math.max(Math.abs(p.v - lin), Math.abs(p.vf - lin));
				if (d > wd) { wd = d; worst = i; }
			}
			if (worst >= 0) { keep[worst] = true; rdp(a, worst); rdp(worst, b); }
		};
		let a = 0;
		for (let i = 1; i < P.length; i++) if (keep[i]) { rdp(a, i); a = i; }
		let out = P.filter((_, i) => keep[i]);
		// KSH reads two different values closer than 1/32 as a slam: thin those
		out = out.filter((p, i) => { const q = out[i - 1]; return !q || p.v !== p.vf || i === out.length - 1 || p.ry - q.ry > 30; });
		for (let i = out.length - 1; i > 0; i--) { const p = out[i], q = out[i - 1]; if (p.v === p.vf && q.v === q.vf && p.ry - q.ry <= 30 && i - 1 > 0) out.splice(i - 1, 1); }
		return { t: sec.t, wide: sec.wide, pts: out.map(p => ({ ...p, v: Math.round(p.v), vf: Math.round(p.vf) })) };
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
	function chartEntry(o, sl, on) {
		const T = (name, v, type) => `<${name}${type ? ` __type="${type}"` : ''}>${xmlEsc(v)}</${name}>`;
		return `      <${sl.id}>\n` + [
			T('difnum', on ? o.difnum : 0, 'u8'), T('illustrator', on ? o.illustrator : ''), T('effected_by', on ? o.effector : ''),
			T('price', -1, 's32'), T('limited', 3, 'u8'), T('jacket_print', -2, 's32'), T('jacket_mask', 0, 's32'), T('max_exscore', 0, 's32'),
		].map(x => '        ' + x).join('\n') + '\n        <radar>\n' + ['notes', 'peak', 'tsumami', 'tricky', 'hand_trip', 'one_hand'].map(k => '          ' + T(k, 0, 'u16')).join('\n') + `\n        </radar>\n      </${sl.id}>`;
	}
	function musicEntry(o) {
		const T = (name, v, type) => `<${name}${type ? ` __type="${type}"` : ''}>${xmlEsc(v)}</${name}>`;
		const charts = SLOTS.map(sl => chartEntry(o, sl, sl.id === o.slot)).join('\n');
		const info = [
			T('title_name', o.title), T('title_yomigana', o.titleYomi || o.title), T('artist_name', o.artist), T('artist_yomigana', o.artistYomi || o.artist),
			T('ascii', o.ascii), T('bpm_max', Math.round(o.bpmMax * 100), 'u32'), T('bpm_min', Math.round(o.bpmMin * 100), 'u32'),
			T('distribution_date', o.date, 'u32'), T('volume', o.volume, 'u16'), T('bg_no', o.bgNo ?? 2, 'u16'), T('genre', 0, 'u32'),
			T('is_fixed', 1, 'u8'), T('version', o.version, 'u8'), T('demo_pri', 0, 's8'), T('inf_ver', o.infVer, 'u8'),
		].map(x => '      ' + x).join('\n');
		return `  <music id="${o.id}">\n    <info>\n${info}\n    </info>\n    <difficulty>\n${charts}\n    </difficulty>\n  </music>\n`;
	}
	function musicDb(o) { return `<?xml version="1.0" encoding="shift-jis"?>\n<mdb>\n${musicEntry(o)}</mdb>\n`; }

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
	// Zip layout = the game's own data/music/<id>_<name>/ folder, plus the music_db entry to paste into data/others/music_db.xml.
	async function buildPackage(chart, o, progress) {
		const files = [], warnings = [];
		const stem = pad(o.id, 4) + '_' + o.ascii, slot = SLOTS.find(s => s.id === o.slot), dir = stem + '/';
		const vox = buildVox(chart, { laserEdge: o.laserEdge, format: o.format });
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
			const pl = (o.previewLen > 0 ? o.previewLen : 10000) / 1000;
			const [pl0, pr0] = sliceAudio(buf, (o.previewMs || 0) / 1000, pl, 0.3, 1.5);
			files.push({ name: dir + stem + '_pre.2dx', data: make2dx(stem + '_pre.2dx', encodeAdpcmWav(pl0, pr0, 44100)) });
		} else if (!o.existing) warnings.push({ t: 0, msg: 'No audio loaded: the .2dx files were not created.' });
		if (o.jacket) {
			progress && progress('Making jackets…');
			const j = await jacketPngs(o.jacket, { n: 300, s: 108, b: 676 });
			const jb = 'jk_' + pad(o.id, 4) + '_' + slot.n;
			files.push({ name: dir + jb + '.png', data: j.n }, { name: dir + jb + '_b.png', data: j.b }, { name: dir + jb + '_s.png', data: j.s });
		} else warnings.push({ t: 0, msg: 'No jacket image chosen: this chart will show a blank jacket.' });
		const bad = new Set();
		const date = o.date || Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
		const xml = o.existing
			? '<!-- Song ' + o.id + ' is already in data/others/music_db.xml. In its <difficulty> section, replace the <' + slot.id + '> ... </' + slot.id + '> block with this one. -->\r\n' + chartEntry({ ...o, date }, slot, true).replace(/\n/g, '\r\n')
			: '<!-- Paste the <music> element below into data/others/music_db.xml, just before the closing </mdb> line. Keep that file in Shift-JIS. -->\r\n' + musicEntry({ ...o, date }).replace(/\n/g, '\r\n');
		files.push({ name: 'music_db entry (' + stem + ').xml', data: sjisEncode('<?xml version="1.0" encoding="shift-jis"?>\r\n' + xml, bad) });
		if (bad.size) warnings.push({ t: 0, msg: 'These characters cannot be written in Shift-JIS and became "?": ' + [...bad].join(' ') });
		files.push({ name: 'README.txt', data: new TextEncoder().encode(
			'1. Copy the folder "' + stem + '" into your game\'s data/music folder' + (o.existing ? ' (merge it with the existing folder of song ' + o.id + ').' : '.') + '\r\n' +
			'2. Open data/others/music_db.xml (Shift-JIS) and ' + (o.existing ? 'replace the <' + slot.id + '> block of song ' + o.id + ' with the one in "music_db entry (' + stem + ').xml".' : 'paste the <music> element from "music_db entry (' + stem + ').xml" just before </mdb>. The song id ' + o.id + ' must not be used by another song.') + '\r\n' +
			'   (If you use data_mods / LayeredFS instead, the same entry can go in data_mods/<mod>/others/music_db.merged.xml inside <mdb> ... </mdb>.)\r\n' +
			'3. Chart slot: ' + slot.label + ' (' + stem + '_' + slot.n + slot.l + '.vox).\r\n' +
			'Audio is .2dx (MS-ADPCM). The game also loads .2dx songs (older songs use it); if yours does not play, convert the song to .s3v (WMA Pro) with another tool and keep the same file names.\r\n\r\n' +
			(warnings.length ? 'Notes from the export:\r\n' + warnings.map(w => '- ' + w.msg).join('\r\n') + '\r\n' : '')) });
		return { blob: zip(files), files, warnings, stem };
	}

	return { SLOTS, KSH_DIFF_SLOT, CAM, importVox, buildVox, encodeAdpcmWav, decodeAdpcmWav, make2dx, sliceAudio, sjisEncode, musicDb, zip, crc32, buildPackage };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SDVX;
