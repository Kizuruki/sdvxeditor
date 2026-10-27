/* ============================================================================
 * KSM Chart Editor - core
 * Chart model, timing math and KSH (K-Shoot MANIA) import/export.
 * Pure logic, no DOM, so it can be unit-tested in Node and ported to C++.
 *
 * KSH semantics follow libkson (github.com/kshootmania/libkson) KshIOIn/KshIOOut:
 *   - 240 ticks per beat (960 per 4/4 measure), same as KSON "pulses"
 *   - laser positions are integers 0..50 (KSH characters 0-9A-Za-o)
 *   - a laser point with v != vf is a slam; in KSH it is written as a 1/32 segment
 * ========================================================================== */
(function (root) {
'use strict';

const RES = 240;               // ticks per beat
const MEAS4 = RES * 4;         // ticks per 4/4 measure
const LASER_MAX = 50;
const SLAM_LEN = MEAS4 / 32;   // 30 ticks - KSH laser segments this short are slams
const KSH_LEN = MEAS4 / 192;   // 5 ticks - KSH lengths (stop, spin) use 192 per measure

let _nextId = 1;
const nid = () => _nextId++;

const CAM_KEYS = ['zoom_top', 'zoom_bottom', 'zoom_side', 'center_split', 'rotation_deg', 'scroll_speed'];
const TILT_AUTO = ['normal', 'bigger', 'biggest', 'keep_normal', 'keep_bigger', 'keep_biggest', 'zero'];

// Header keys in the order libkson / KSM write them
const HEADER_KEYS = ['title', 'title_translit', 'title_img', 'artist', 'artist_translit', 'artist_img', 'effect',
	'jacket', 'illustrator', 'difficulty', 'level', 't', 'to', 'm', 'mvol', 'o', 'bg', 'layer', 'v', 'vo', 'po',
	'plength', 'pfiltergain', 'filtertype', 'chokkakuautovol', 'chokkakuvol', 'pfilterdelay', 'total', 'information',
	'icon', 'ver', 'ver_compat'];

// FX hold audio effects. "params" are the ;-separated values after the name.
const FX_EFFECTS = [
	{ name: 'Retrigger', params: [{ label: 'Wave 1/n', def: 8 }] },
	{ name: 'Gate', params: [{ label: 'Wave 1/n', def: 4 }] },
	{ name: 'Flanger', params: [] },
	{ name: 'PitchShift', params: [{ label: 'Pitch (12=1oct)', def: 12 }] },
	{ name: 'BitCrusher', params: [{ label: 'Reduction', def: 5 }] },
	{ name: 'Phaser', params: [] },
	{ name: 'Wobble', params: [{ label: 'Wave 1/n', def: 12 }] },
	{ name: 'TapeStop', params: [{ label: 'Speed', def: 50 }] },
	{ name: 'Echo', params: [{ label: 'Wave 1/n', def: 4 }, { label: 'Feedback %', def: 60 }] },
	{ name: 'SideChain', params: [] },
];
const LEGACY_FX_CHARS = {
	S: 'Retrigger;8', V: 'Retrigger;12', T: 'Retrigger;16', W: 'Retrigger;24', U: 'Retrigger;32',
	G: 'Gate;4', H: 'Gate;8', K: 'Gate;12', I: 'Gate;16', L: 'Gate;24', J: 'Gate;32',
	F: 'Flanger', P: 'PitchShift;12', B: 'BitCrusher;5', Q: 'Phaser', X: 'Wobble;12', A: 'TapeStop', D: 'SideChain',
};
const FX_WITH_PARAM = new Set(['Retrigger', 'Gate', 'Wobble', 'PitchShift', 'BitCrusher', 'TapeStop', 'Echo']);
const LASER_FILTERS = ['peak', 'lpf1', 'hpf1', 'bitc', 'fx', 'fx;bitc'];
const SLAM_SOUNDS = ['up', 'down', 'swing', 'mute'];
const FX_CHIP_SOUNDS = ['clap', 'clap_punchy', 'clap_impact', 'snare', 'snare_lo'];
const BG_PRESETS = ['desert', 'grass', 'night', 'deepsea', 'sky', 'sunset', 'ocean', 'flame', 'cyber', 'space', 'mars', 'cloudy', 'fantasy'];
const LAYER_PRESETS = ['arrow', 'smoke', 'wave', 'techno', 'snow', 'sakura', 'hidden'];
const DIFFICULTIES = ['light', 'challenge', 'extended', 'infinite'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function lowerBound(arr, t) { // first index with arr[i].t >= t
	let lo = 0, hi = arr.length;
	while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
	return lo;
}
function upperBound(arr, t) { // first index with arr[i].t > t
	let lo = 0, hi = arr.length;
	while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid + 1; else hi = mid; }
	return lo;
}
function lastAtOrBefore(arr, t) { const i = upperBound(arr, t) - 1; return i >= 0 ? arr[i] : null; }
function findAt(arr, t) { const i = lowerBound(arr, t); return (i < arr.length && arr[i].t === t) ? arr[i] : null; }
function insertSorted(arr, obj) { arr.splice(upperBound(arr, obj.t), 0, obj); return obj; }
function sortByT(arr) { return arr.sort((a, b) => a.t - b.t); }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtNum(v) { // libkson FormatDouble: 3 decimals, trailing zeros removed
	v = round3(v);
	let s = v.toFixed(3);
	s = s.replace(/0+$/, '').replace(/\.$/, '');
	if (s === '-0') s = '0';
	return s;
}
function parseIntKsh(s, def = 0) { const v = parseInt(String(s).trim(), 10); return Number.isFinite(v) ? v : def; }
function parseFloatKsh(s, def = 0) { const v = parseFloat(String(s).trim()); return Number.isFinite(v) ? v : def; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function charToLaserX(c) {
	if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
	if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + 10;
	if (c >= 'a' && c <= 'o') return c.charCodeAt(0) - 97 + 36;
	return 0;
}
function laserXToChar(x) {
	if (x >= 0 && x <= 9) return String.fromCharCode(48 + x);
	if (x >= 10 && x <= 35) return String.fromCharCode(65 + x - 10);
	if (x >= 36 && x <= 50) return String.fromCharCode(97 + x - 36);
	return '0';
}
// Laser value (0..50) to horizontal track position (0 = left knob lane centre, 1 = right knob lane centre)
function laserPos(v, wide) {
	if (!wide) return v / LASER_MAX;
	let g = v / LASER_MAX;
	if (v === 12) g = 0.25; else if (v === 37) g = 0.75; // libkson wide-laser zero fix
	return (g - 0.5) * 2 + 0.5;
}
function posToLaserX(pos, wide) { // inverse of laserPos, rounded to the KSH grid
	const g = wide ? (pos - 0.5) / 2 + 0.5 : pos;
	if (wide) {
		if (Math.abs(g - 0.25) < 0.005) return 12;
		if (Math.abs(g - 0.75) < 0.005) return 37;
	}
	return clamp(Math.round(g * LASER_MAX), 0, LASER_MAX);
}

// Quadratic bezier easing used by KSH/KSON curves (port of libkson EvaluateCurve)
function evalCurve(a, b, x) {
	if (Math.round(a * 1e8) === Math.round(b * 1e8)) return x; // linear
	a = clamp(a, 0, 1); b = clamp(b, 0, 1); x = clamp(x, 0, 1);
	const disc = a * a + x - 2 * a * x;
	const dSqrt = disc >= 0 ? Math.sqrt(disc) : 0;
	const t = a < 0.25 ? (a - dSqrt) / (-1 + 2 * a) : x / (a + dSqrt);
	return clamp(2 * (1 - t) * t * b + t * t, 0, 1);
}
const CURVE_PRESETS = [
	{ id: 'linear', label: 'Linear', a: 0, b: 0 },
	{ id: 'in', label: 'Ease in', a: 0.5, b: 0 },
	{ id: 'out', label: 'Ease out', a: 0.5, b: 1 },
	{ id: 'in2', label: 'Strong in', a: 1, b: 0 },
	{ id: 'out2', label: 'Strong out', a: 0, b: 1 },
];
function isLinear(p) { return !p.a && !p.b || Math.round(p.a * 1e8) === Math.round(p.b * 1e8); }

// ---------------------------------------------------------------------------
// Chart model
// ---------------------------------------------------------------------------
function newChart() {
	const meta = {};
	for (const k of HEADER_KEYS) meta[k] = '';
	Object.assign(meta, {
		difficulty: 'challenge', level: '1', o: '0', bg: 'desert', layer: 'arrow', po: '0', plength: '15000',
		pfiltergain: '50', filtertype: 'peak', chokkakuautovol: '0', chokkakuvol: '50',
	});
	return {
		meta,
		metaExtra: [],                 // unknown header [key, value]
		bt: [[], [], [], []],          // {id, t, l}  l = 0 chip, > 0 hold length
		fx: [[], []],                  // {id, t, l, fx?: effect string for holds, se?: "name;vol" for chips}
		laser: [[], []],               // {id, t, wide, pts: [{id, ry, v, vf, a, b}]}
		bpm: [{ id: nid(), t: 0, v: 120 }],
		sig: [{ id: nid(), m: 0, n: 4, d: 4 }],
		stops: [],                     // {id, t, l}
		cam: { zoom_top: [], zoom_bottom: [], zoom_side: [], center_split: [], rotation_deg: [], scroll_speed: [] },
		tilt: [],                      // {id, t, v: number|auto string, vf?: number|string, a, b}
		spins: [],                     // {id, t, kind: 'spin'|'half'|'swing', dir: -1|1, l (ticks), amp, rep, dec}
		slamSE: [],                    // {id, t, v}  chokkakuse
		slamVol: [],                   // {id, t, v}  chokkakuvol changes in body
		filterType: [],                // {id, t, v}
		pfilterGain: [],               // {id, t, v}
		raw: [],                       // {id, t, k, v}  options/lines kept verbatim (k '' = line, '//' = comment)
		defs: [],                      // '#define_fx ...' / '#define_filter ...' lines
	};
}

// Structural copy: new arrays/containers, same (immutable) item objects. Used for undo snapshots.
function cloneChart(c) {
	return {
		meta: { ...c.meta }, metaExtra: c.metaExtra.map(e => e.slice()),
		bt: c.bt.map(a => a.slice()), fx: c.fx.map(a => a.slice()), laser: c.laser.map(a => a.slice()),
		bpm: c.bpm.slice(), sig: c.sig.slice(), stops: c.stops.slice(),
		cam: Object.fromEntries(CAM_KEYS.map(k => [k, c.cam[k].slice()])),
		tilt: c.tilt.slice(), spins: c.spins.slice(), slamSE: c.slamSE.slice(), slamVol: c.slamVol.slice(),
		filterType: c.filterType.slice(), pfilterGain: c.pfilterGain.slice(), raw: c.raw.slice(), defs: c.defs.slice(),
	};
}

function sectionEndTick(sec) {
	const last = sec.pts[sec.pts.length - 1];
	return sec.t + last.ry + (last.v !== last.vf ? SLAM_LEN : 0);
}

// Laser value at an absolute tick inside a section (vf of a point applies right after it)
function laserValueAt(sec, t) {
	const pts = sec.pts, ry = t - sec.t;
	if (ry < 0 || !pts.length) return null;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i], q = pts[i + 1];
		if (ry === p.ry) return p.vf;
		if (!q) return null;
		if (ry > p.ry && ry < q.ry) {
			const x = (ry - p.ry) / (q.ry - p.ry);
			return p.vf + (q.v - p.vf) * evalCurve(p.a || 0, p.b || 0, x);
		}
	}
	return null;
}

// Graph (camera param / tilt) evaluation. Points {t, v, vf, a, b}; vf undefined == v.
function graphValueAt(pts, t, def) {
	if (!pts.length) return def;
	const i = upperBound(pts, t) - 1;
	if (i < 0) return num(pts[0].v, def);
	const p = pts[i], q = pts[i + 1];
	const pv = num(p.vf !== undefined ? p.vf : p.v, def);
	if (!q || typeof q.v !== 'number') return pv;
	const x = (t - p.t) / (q.t - p.t);
	return pv + (q.v - pv) * evalCurve(p.a || 0, p.b || 0, x);
}
function num(v, def) { return typeof v === 'number' ? v : def; }

// ---------------------------------------------------------------------------
// Timing: ticks <-> seconds (BPM changes) and measures (time signatures)
// ---------------------------------------------------------------------------
class Timing {
	constructor(chart) { this.rebuild(chart); }
	rebuild(chart) {
		const bpms = chart.bpm.length ? chart.bpm : [{ t: 0, v: 120 }];
		this.seg = [];
		let sec = 0, prevT = 0, prevBpm = bpms[0].v;
		for (let i = 0; i < bpms.length; i++) {
			const b = bpms[i], t = i === 0 ? 0 : b.t;
			if (i > 0) sec += (t - prevT) / RES * 60 / prevBpm;
			const bpm = b.v > 0.001 ? b.v : 0.001;
			this.seg.push({ t, sec, bpm });
			prevT = t; prevBpm = bpm;
		}
		// Time signature blocks: {m, t, len, n, d}
		const sigs = chart.sig.length ? chart.sig : [{ m: 0, n: 4, d: 4 }];
		this.blocks = [];
		let t = 0, m = 0, cur = { n: 4, d: 4 };
		for (const s of sigs) {
			if (s.m > m) { t += (s.m - m) * Math.floor(MEAS4 * cur.n / cur.d); m = s.m; }
			cur = s;
			this.blocks.push({ m: s.m, t, len: Math.floor(MEAS4 * s.n / s.d), n: s.n, d: s.d });
		}
		if (!this.blocks.length || this.blocks[0].m !== 0) this.blocks.unshift({ m: 0, t: 0, len: MEAS4, n: 4, d: 4 });
	}
	_seg(t) {
		const s = this.seg; let lo = 0, hi = s.length - 1;
		while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid - 1; }
		return s[lo];
	}
	tickToSec(t) { const s = this._seg(t); return s.sec + (t - s.t) / RES * 60 / s.bpm; }
	secToTick(sec) {
		const s = this.seg; let lo = 0, hi = s.length - 1;
		while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].sec <= sec) lo = mid; else hi = mid - 1; }
		const g = s[lo];
		return g.t + (sec - g.sec) * g.bpm / 60 * RES;
	}
	bpmAt(t) { return this._seg(t).bpm; }
	_blockByM(m) { const b = this.blocks; let i = b.length - 1; while (i > 0 && b[i].m > m) i--; return b[i]; }
	_blockByT(t) { const b = this.blocks; let i = b.length - 1; while (i > 0 && b[i].t > t) i--; return b[i]; }
	measureStart(m) { const b = this._blockByM(m); return b.t + (m - b.m) * b.len; }
	measureOf(t) { // {m, start, len, n, d}
		const b = this._blockByT(t);
		const m = b.m + Math.floor((t - b.t) / b.len);
		return { m, start: b.t + (m - b.m) * b.len, len: b.len, n: b.n, d: b.d };
	}
	sigAt(m) { const b = this._blockByM(m); return { n: b.n, d: b.d }; }
	// Snap a tick to a division (per whole note, e.g. 16 = 1/16) relative to its measure start
	snap(t, div) {
		const step = MEAS4 / div;
		const ms = this.measureOf(Math.max(0, t));
		let s = ms.start + Math.round((t - ms.start) / step) * step;
		if (s > ms.start + ms.len) s = ms.start + ms.len;
		return Math.max(0, Math.round(s));
	}
	stepFrom(t, div, dir) { // next / previous grid tick
		const step = MEAS4 / div;
		const ms = this.measureOf(Math.max(0, t));
		const rel = (t - ms.start) / step;
		let k = dir > 0 ? Math.floor(rel + 1e-6) + 1 : Math.ceil(rel - 1e-6) - 1;
		let n = ms.start + k * step;
		if (dir > 0 && n > ms.start + ms.len) n = ms.start + ms.len;
		if (dir < 0 && n < ms.start && ms.m > 0) { const p = this.measureOf(ms.start - 1); n = p.start + Math.floor((p.len - 1e-6) / step) * step; }
		return Math.max(0, Math.round(n));
	}
}

// Visual (scroll) position in beats, accounting for scroll_speed and stops. For the preview.
class ScrollMap {
	constructor(chart) {
		const sp = chart.cam.scroll_speed, stops = chart.stops;
		const brk = new Set([0]);
		for (const p of sp) brk.add(p.t);
		for (const s of stops) { brk.add(s.t); brk.add(s.t + s.l); }
		this.br = [...brk].sort((a, b) => a - b);
		this.sp = sp; this.stops = stops;
		this.cum = [0];
		for (let i = 1; i < this.br.length; i++) this.cum.push(this.cum[i - 1] + this._integrate(this.br[i - 1], this.br[i]));
	}
	_speed(t) {
		for (const s of this.stops) if (t >= s.t && t < s.t + s.l) return 0;
		return graphValueAt(this.sp, t, 1);
	}
	_integrate(t0, t1) {
		if (t1 <= t0) return 0;
		const n = Math.max(1, Math.min(32, Math.ceil((t1 - t0) / 15)));
		let acc = 0; const h = (t1 - t0) / n;
		for (let i = 0; i < n; i++) acc += this._speed(t0 + (i + 0.5) * h) * h;
		return acc / RES;
	}
	at(t) {
		if (t <= 0) return t / RES * graphValueAt(this.sp, 0, 1);
		const br = this.br; let lo = 0, hi = br.length - 1;
		while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (br[mid] <= t) lo = mid; else hi = mid - 1; }
		return this.cum[lo] + this._integrate(br[lo], t);
	}
}

// ---------------------------------------------------------------------------
// KSH import (port of libkson KshIOIn semantics)
// ---------------------------------------------------------------------------
function decodeKshBytes(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8-bom' };
	try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; }
	catch (e) {
		try { return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' }; }
		catch (e2) { return { text: new TextDecoder('utf-8').decode(u8), encoding: 'utf-8?' }; }
	}
}

function splitOption(line) { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }
function isOptionLine(line) { return line.length >= 2 && line[0] !== '=' && line.indexOf('=', 1) !== -1; }
function normAutoTilt(s) {
	if (s === 'bigger' || s === 'big') return 'bigger';
	if (s === 'biggest') return 'biggest';
	if (s === 'keep_normal') return 'keep_normal';
	if (s === 'keep_bigger' || s === 'keep') return 'keep_bigger';
	if (s === 'keep_biggest') return 'keep_biggest';
	if (s === 'zero') return 'zero';
	return 'normal';
}
function isManualTilt(s) { return s.length > 0 && ((s[0] >= '0' && s[0] <= '9') || s[0] === '-'); }
function composeFx(str, param) {
	if (!param) return str;
	const name = str.split(';')[0];
	return FX_WITH_PARAM.has(name) ? name + ';' + param : name;
}
function parseSpin(s) {
	if (s.length < 3) return null;
	let kind = null, dir = 0;
	if (s[0] === '@') {
		if (s[1] === '(') { kind = 'spin'; dir = -1; } else if (s[1] === ')') { kind = 'spin'; dir = 1; }
		else if (s[1] === '<') { kind = 'half'; dir = -1; } else if (s[1] === '>') { kind = 'half'; dir = 1; }
	} else if (s[0] === 'S') {
		if (s[1] === '<') { kind = 'swing'; dir = -1; } else if (s[1] === '>') { kind = 'swing'; dir = 1; }
	}
	if (!kind) return null;
	if (kind === 'swing') {
		const p = s.slice(2).split(';');
		const g = (i, d) => (p[i] !== undefined && p[i] !== '') ? parseIntKsh(p[i], d) : d;
		return { kind, dir, l: g(0, 192) * KSH_LEN, amp: g(1, 250), rep: g(2, 3), dec: g(3, 2) };
	}
	return { kind, dir, l: parseIntKsh(s.slice(2), 0) * KSH_LEN, amp: 250, rep: 3, dec: 2 };
}

function importKsh(input) {
	const warnings = [];
	const dec = typeof input === 'string' ? { text: input.replace(/^﻿/, ''), encoding: 'text' } : decodeKshBytes(input);
	const lines = dec.text.split('\n');
	const c = newChart();
	for (const k of HEADER_KEYS) c.meta[k] = '';
	c.bpm = []; c.sig = [];
	let li = 0;
	let headerBpm = null;

	// ---- header ----
	for (; li < lines.length; li++) {
		let line = lines[li];
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line === '--') { li++; break; }
		if (!line || line.startsWith('//')) continue;
		if (!isOptionLine(line)) continue;
		const [k, v] = splitOption(line);
		if (k === 'beat') {
			const [n, d] = v.split('/').map(x => parseIntKsh(x, 4));
			c.sig = [{ id: nid(), m: 0, n: n || 4, d: d || 4 }];
		} else if (k in c.meta) {
			c.meta[k] = v;
			if (k === 't') headerBpm = v;
		} else c.metaExtra.push([k, v]);
	}
	const verInt = parseIntKsh(c.meta.ver_compat || c.meta.ver, 0);
	const bpmMap = new Map();
	if (headerBpm !== null && headerBpm.indexOf('-') === -1) {
		let b = round3(parseFloatKsh(headerBpm, 120));
		if (verInt >= 130) b = Math.min(b, 65535);
		bpmMap.set(0, b);
	}
	if (!c.sig.length) c.sig = [{ id: nid(), m: 0, n: 4, d: 4 }];

	// ---- body ----
	const zoomMax = verInt >= 167 ? 65535 : 300;
	const zoomMaxChar = verInt >= 167 ? Infinity : 4;
	const bt = [new Map(), new Map(), new Map(), new Map()];
	const fx = [new Map(), new Map()];
	const lasers = [new Map(), new Map()];
	const prepBT = [null, null, null, null];
	const prepFX = [null, null];
	const prepLaser = [null, null];
	const cam = {}; for (const k of CAM_KEYS) cam[k] = new Map();
	const tilt = new Map(); let lastTiltT = -1;
	const stops = new Map(), spins = new Map(), slamSE = [], slamSESet = new Set();
	const curves = {};
	let curSig = { n: c.sig[0].n, d: c.sig[0].d };
	let curT = 0, mIdx = 0;
	let chartLines = [], optLines = [], commentLines = [], unknownLines = [];
	let sub32Warned = false;

	const graphSet = (map, t, v) => { // InsertGraphPointOrAssignVf
		const e = map.get(t);
		if (e) e.vf = v; else map.set(t, { t, v });
	};
	const publishBT = (lane) => {
		const p = prepBT[lane]; if (!p) return;
		if (!bt[lane].has(p.t)) bt[lane].set(p.t, { t: p.t, l: Math.floor(p.acc) });
		prepBT[lane] = null;
	};
	const publishFX = (lane) => {
		const p = prepFX[lane]; if (!p) return;
		if (!fx[lane].has(p.t)) { const n = { t: p.t, l: Math.floor(p.acc) }; if (p.noteFx !== undefined) n.fx = p.noteFx; fx[lane].set(p.t, n); }
		prepFX[lane] = null;
	};
	const fxEvent = (lane, t, str, param) => {
		const p = prepFX[lane];
		const s = composeFx(str, param);
		if (t === p.t) p.noteFx = s;
		else c.raw.push({ id: nid(), t, k: lane ? 'fx-r' : 'fx-l', v: s });
	};
	const prepareFX = (lane, t, str, param, legacy) => {
		if (!prepFX[lane]) prepFX[lane] = { t, acc: 0, str: undefined, param: undefined, legacy: false };
		const p = prepFX[lane];
		if (legacy) { if (p.str !== str || p.param !== param) fxEvent(lane, t, str, param); }
		else fxEvent(lane, t, str, param);
		p.str = str; p.param = param; p.legacy = legacy;
	};
	const prepareFXPlain = (lane, t) => {
		const p = prepFX[lane];
		if (p && p.legacy) { prepareFX(lane, t, '', '', false); return; }
		if (!p) prepFX[lane] = { t, acc: 0, str: undefined, param: undefined, legacy: false };
	};
	const publishLaser = (lane) => {
		const p = prepLaser[lane]; if (!p) return;
		prepLaser[lane] = null;
		const pts = [...p.pts.entries()].sort((a, b) => a[0] - b[0]);
		if (pts.length < 2) return; // libkson ignores single-point sections
		const out = [];
		for (let i = 0; i < pts.length; i++) {
			const [ry, v] = pts[i];
			const nx = pts[i + 1];
			if (nx) {
				const [nry, nv] = nx;
				if (nry - ry >= 0 && nry - ry <= SLAM_LEN && nv !== v) {
					if (!sub32Warned && nry - ry > 0 && nry - ry < SLAM_LEN) { warnings.push({ t: p.t + ry, msg: 'Slam shorter than 1/32 found; it will be re-saved as a 1/32 slam.' }); sub32Warned = true; }
					out.push({ id: nid(), ry, v, vf: nv, a: 0, b: 0 });
					const nn = pts[i + 2];
					if (!nn || nn[0] - nry > SLAM_LEN || nn[1] === nv) i++;
					continue;
				}
			}
			out.push({ id: nid(), ry, v, vf: v, a: 0, b: 0 });
		}
		if (!lasers[lane].has(p.t)) lasers[lane].set(p.t, { id: nid(), t: p.t, wide: p.wide, pts: out });
	};

	const processMeasure = () => {
		const n = chartLines.length;
		const mlen = Math.floor(MEAS4 * curSig.n / curSig.d);
		if (n > 0) {
			const one = mlen / n;
			const rowT = (i) => curT + Math.floor(i * one);
			if (mlen % n !== 0) warnings.push({ t: curT, msg: `Measure ${mIdx + 1} has ${n} lines which do not divide ${mlen} ticks evenly (timing rounded).` });
			const fxStr = [new Map(), new Map()], fxParam = [new Map(), new Map()], fxSE = [new Map(), new Map()];
			const wide = [new Set(), new Set()], seRow = new Map();
			for (const o of optLines) {
				const t = rowT(o.idx), k = o.k, v = o.v;
				if (k.endsWith('_curve')) {
					const pn = k.slice(0, -6), s = v.indexOf(';');
					if (s !== -1) { (curves[pn] = curves[pn] || new Map()).set(t, { a: parseFloatKsh(v.slice(0, s)), b: parseFloatKsh(v.slice(s + 1)) }); }
					continue;
				}
				switch (k) {
					case 't': {
						if (v.indexOf('-') !== -1) break;
						let b = round3(parseFloatKsh(v, 120)); if (verInt >= 130) b = Math.min(b, 65535);
						bpmMap.set(bpmMap.size === 0 ? 0 : t, b); break;
					}
					case 'stop': { const l = parseIntKsh(v) * KSH_LEN; if (l > 0) stops.set(t, { t, l }); break; }
					case 'zoom_top': case 'zoom_bottom': case 'zoom_side': {
						const s = zoomMaxChar === Infinity ? v : v.slice(0, zoomMaxChar);
						const d = parseIntKsh(s);
						if (Math.abs(d) <= zoomMax || (verInt < 167 && cam[k].has(t))) graphSet(cam[k], t, d);
						break;
					}
					case 'center_split': { const d = parseIntKsh(v); if (Math.abs(d) <= 65535) graphSet(cam[k], t, d); break; }
					case 'scroll_speed': graphSet(cam[k], t, parseFloatKsh(v)); break;
					case 'rotation_deg': { const d = parseFloatKsh(v); if (Math.abs(d) <= 65535) graphSet(cam[k], t, d); break; }
					case 'tilt': {
						if (isManualTilt(v)) {
							const d = round3(parseFloatKsh(v));
							if (Math.abs(d) <= 1000) {
								const last = lastTiltT >= 0 ? tilt.get(lastTiltT) : null;
								if (last && last.t === t && typeof last.v === 'number') last.vf = d;
								else { tilt.set(t, { t, v: d }); lastTiltT = Math.max(lastTiltT, t); }
							}
						} else {
							const a = normAutoTilt(v);
							const last = lastTiltT >= 0 ? tilt.get(lastTiltT) : null;
							if (last && last.t === t && typeof last.v === 'number') last.vf = a;
							else { tilt.set(t, { t, v: a }); lastTiltT = Math.max(lastTiltT, t); }
						}
						break;
					}
					case 'chokkakuvol': c.slamVol.push({ id: nid(), t, v }); break;
					case 'chokkakuse': seRow.set(o.idx, v); break;
					case 'pfiltergain': c.pfilterGain.push({ id: nid(), t, v }); break;
					case 'filtertype': c.filterType.push({ id: nid(), t, v }); break;
					case 'fx-l': fxStr[0].set(o.idx, v); break;
					case 'fx-r': fxStr[1].set(o.idx, v); break;
					case 'fx-l_param1': fxParam[0].set(o.idx, v); break;
					case 'fx-r_param1': fxParam[1].set(o.idx, v); break;
					case 'fx-l_se': fxSE[0].set(o.idx, v); break;
					case 'fx-r_se': fxSE[1].set(o.idx, v); break;
					case 'laserrange_l': if (v === '2x') wide[0].add(o.idx); break;
					case 'laserrange_r': if (v === '2x') wide[1].add(o.idx); break;
					default: c.raw.push({ id: nid(), t, k, v });
				}
			}
			for (let i = 0; i < n; i++) {
				const buf = chartLines[i], t = rowT(i);
				let block = 0, lane = 0;
				for (let j = 0; j < buf.length; j++) {
					const ch = buf[j];
					if (ch === '|') { block++; lane = 0; continue; }
					if (block === 0 && lane < 4) {
						if (ch === '2') { if (!prepBT[lane]) prepBT[lane] = { t, acc: 0 }; prepBT[lane].acc += one; }
						else if (ch === '1') { publishBT(lane); if (!bt[lane].has(t)) bt[lane].set(t, { t, l: 0 }); }
						else publishBT(lane);
					} else if (block === 1 && lane < 2) {
						if (ch === '2') {
							if (!fx[lane].has(t)) { const nt = { t, l: 0 }; if (fxSE[lane].has(i)) nt.se = fxSE[lane].get(i); fx[lane].set(t, nt); }
						} else if (ch === '0') publishFX(lane);
						else if (ch === '1') {
							if (fxStr[lane].has(i)) prepareFX(lane, t, fxStr[lane].get(i), fxParam[lane].get(i) || '', false);
							else prepareFXPlain(lane, t);
							prepFX[lane].acc += one;
						} else {
							const str = LEGACY_FX_CHARS[ch] || '';
							const param = fxParam[lane].has(i) ? fxParam[lane].get(i) : (prepFX[lane] && prepFX[lane].param) || '';
							prepareFX(lane, t, str, param, true);
							prepFX[lane].acc += one;
						}
					} else if (block === 2 && lane < 2) {
						if (ch === '-') publishLaser(lane);
						else if (ch !== ':') {
							const x = charToLaserX(ch);
							if (!prepLaser[lane]) prepLaser[lane] = { t, wide: wide[lane].has(i), pts: new Map() };
							const ry = t - prepLaser[lane].t;
							if (ry >= 0) prepLaser[lane].pts.set(ry, x);
							if (seRow.has(i)) {
								const name = seRow.get(i);
								if (name && !slamSESet.has(name + '@' + t)) { slamSESet.add(name + '@' + t); slamSE.push({ id: nid(), t, v: name }); }
							}
						}
					} else if (block === 2 && lane === 2) {
						const sp = parseSpin(buf.slice(j));
						if (sp && !spins.has(t)) spins.set(t, { t, ...sp });
						break;
					}
					lane++;
				}
			}
			for (const cm of commentLines) c.raw.push({ id: nid(), t: rowT(cm.idx), k: '//', v: cm.v });
			for (const u of unknownLines) c.raw.push({ id: nid(), t: rowT(u.idx), k: '', v: u.v });
		} else if (optLines.length || commentLines.length) {
			warnings.push({ t: curT, msg: `Measure ${mIdx + 1} has options but no chart lines; they were ignored (same as KSM).` });
		}
		chartLines = []; optLines = []; commentLines = []; unknownLines = [];
		curT += mlen; mIdx++;
	};

	for (; li < lines.length; li++) {
		let line = lines[li];
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (!line) continue;
		if (line.startsWith('//')) { commentLines.push({ idx: chartLines.length, v: line.slice(2) }); continue; }
		if (line[0] === '#') {
			if (line.startsWith('#define_fx ') || line.startsWith('#define_filter ')) c.defs.push(line);
			continue;
		}
		if (line.indexOf('|') !== -1) { chartLines.push(line); continue; }
		if (isOptionLine(line)) {
			const [k, v] = splitOption(line);
			if (k === 'beat') {
				const [n, d] = v.split('/').map(x => parseIntKsh(x, 4));
				curSig = { n: n || 4, d: d || 4 };
				const ex = c.sig.find(s => s.m === mIdx);
				if (ex) { ex.n = curSig.n; ex.d = curSig.d; } else c.sig.push({ id: nid(), m: mIdx, n: curSig.n, d: curSig.d });
			} else optLines.push({ idx: chartLines.length, k, v });
			continue;
		}
		if (line === '--') { processMeasure(); continue; }
		unknownLines.push({ idx: chartLines.length, v: line });
	}
	for (let i = 0; i < 4; i++) if (prepBT[i]) { warnings.push({ t: prepBT[i].t, msg: 'Chart does not end with "--"; an unfinished BT hold was dropped.' }); }
	for (let i = 0; i < 2; i++) if (prepFX[i]) { warnings.push({ t: prepFX[i].t, msg: 'Chart does not end with "--"; an unfinished FX hold was dropped.' }); }
	publishLaser(0); publishLaser(1);

	// ---- assemble ----
	const toArr = (map) => sortByT([...map.values()].map(o => ({ id: nid(), ...o })));
	c.bt = bt.map(toArr);
	c.fx = fx.map(toArr);
	c.laser = lasers.map(m => sortByT([...m.values()]));
	c.bpm = sortByT([...bpmMap.entries()].map(([t, v]) => ({ id: nid(), t, v })));
	if (!c.bpm.length) { c.bpm = [{ id: nid(), t: 0, v: 120 }]; warnings.push({ t: 0, msg: 'No BPM found; using 120.' }); }
	c.sig.sort((a, b) => a.m - b.m);
	c.stops = toArr(stops);
	for (const k of CAM_KEYS) c.cam[k] = toArr(cam[k]).map(p => ({ ...p, a: 0, b: 0 }));
	c.tilt = toArr(tilt).map(p => ({ ...p, a: 0, b: 0 }));
	c.spins = toArr(spins);
	c.slamSE = sortByT(slamSE);
	for (const k of ['slamVol', 'filterType', 'pfilterGain', 'raw']) c[k] = c[k].map((e, i) => [e, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(e => e[0]);
	// curves
	for (const [pn, map] of Object.entries(curves)) {
		for (const [t, cv] of map) {
			if (pn === 'laser_l' || pn === 'laser_r') {
				for (const sec of c.laser[pn === 'laser_l' ? 0 : 1]) {
					const p = sec.pts.find(p => p.ry === t - sec.t);
					if (p) { p.a = cv.a; p.b = cv.b; }
				}
			} else {
				const arr = pn === 'tilt' ? c.tilt : c.cam[pn];
				if (!arr) { c.raw.push({ id: nid(), t, k: pn + '_curve', v: cv.a + ';' + cv.b }); continue; }
				const p = findAt(arr, t);
				if (p) { p.a = cv.a; p.b = cv.b; }
			}
		}
	}
	// Display BPM: keep only when it differs from what we'd compute
	if (c.meta.t === autoDispBpm(c)) c.meta.t = '';
	return { chart: c, warnings, encoding: dec.encoding };
}

function autoDispBpm(c) {
	if (!c.bpm.length) return '120';
	let mn = Infinity, mx = -Infinity;
	for (const b of c.bpm) { mn = Math.min(mn, b.v); mx = Math.max(mx, b.v); }
	return Math.round(mn * 1e8) === Math.round(mx * 1e8) ? fmtNum(mn) : fmtNum(mn) + '-' + fmtNum(mx);
}

// ---------------------------------------------------------------------------
// KSH export (port of libkson KshIOOut semantics)
// ---------------------------------------------------------------------------
function laserToKshSegments(sections) {
	const segs = [];
	for (const sec of sections) {
		const pts = sec.pts, wide = !!sec.wide;
		if (!pts.length) continue;
		if (pts.length === 1) {
			const p = pts[0];
			if (p.v !== p.vf) segs.push({ t: sec.t + p.ry, len: SLAM_LEN, sv: p.v, ev: p.vf, start: true, wide });
			else segs.push({ t: sec.t + p.ry, len: 0, sv: p.v, ev: p.v, start: true, wide });
			continue;
		}
		let first = true;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i], q = pts[i + 1], abs = sec.t + p.ry;
			if (p.v !== p.vf) {
				let sl = SLAM_LEN;
				if (q) {
					const dist = q.ry - p.ry;
					if (dist < SLAM_LEN) sl = (q.v === p.vf) ? Math.max(1, Math.floor(dist / 2)) : dist;
					else if (dist <= MEAS4 / 16 && q.v !== p.vf) sl = dist > SLAM_LEN + 20 ? 20 : dist > SLAM_LEN + 15 ? 15 : dist > SLAM_LEN + 10 ? 10 : 5;
				}
				segs.push({ t: abs, len: sl, sv: p.v, ev: p.vf, start: first, wide }); first = false;
				if (q) {
					const se = abs + sl, qa = sec.t + q.ry;
					if (se <= qa) segs.push({ t: se, len: qa - se, sv: p.vf, ev: q.v, start: false, wide });
				}
			} else if (q) {
				segs.push({ t: abs, len: (sec.t + q.ry) - abs, sv: p.v, ev: q.v, start: first, wide }); first = false;
			}
		}
	}
	return segs;
}

function exportKsh(chartIn, opts = {}) {
	const warnings = [];
	const c = opts.usc ? toUsc(chartIn, warnings) : opts.v1 ? toKsmV1(chartIn, warnings) : chartIn;
	const out = [];
	const timing = new Timing(c);
	const m = c.meta;

	// ---- header ----
	const H = (k, v) => out.push(k + '=' + v);
	H('title', m.title);
	if (m.title_translit) H('title_translit', m.title_translit);
	if (m.title_img) H('title_img', m.title_img);
	H('artist', m.artist);
	if (m.artist_translit) H('artist_translit', m.artist_translit);
	if (m.artist_img) H('artist_img', m.artist_img);
	H('effect', m.effect);
	H('jacket', m.jacket);
	H('illustrator', m.illustrator);
	H('difficulty', m.difficulty || 'light');
	H('level', m.level || '1');
	const headerBpm = m.t || autoDispBpm(c);
	H('t', headerBpm);
	if (m.to) H('to', m.to);
	if (m.m) H('m', m.m);
	if (m.mvol !== '') H('mvol', m.mvol);
	H('o', m.o || '0');
	if (m.bg) H('bg', m.bg);
	if (m.layer) H('layer', m.layer);
	if (m.v) { H('v', m.v); H('vo', m.vo || '0'); }
	H('po', m.po || '0');
	H('plength', m.plength || '0');
	if (m.pfiltergain) H('pfiltergain', m.pfiltergain);
	if (m.filtertype) H('filtertype', m.filtertype);
	H('chokkakuautovol', m.chokkakuautovol || '0');
	if (m.chokkakuvol) H('chokkakuvol', m.chokkakuvol);
	if (m.pfilterdelay) H('pfilterdelay', m.pfilterdelay);
	if (m.total) H('total', m.total);
	if (m.information) H('information', m.information);
	if (m.icon) H('icon', m.icon);
	let ver = m.ver || '171', verCompat = m.ver_compat;
	const vi = parseIntKsh(ver, 0);
	if (vi < 160) { if (!verCompat) verCompat = m.ver; ver = '160'; } // we write the >=1.60 FX syntax
	H('ver', ver);
	if (verCompat) H('ver_compat', verCompat);
	for (const [k, v] of c.metaExtra) H(k, v);
	out.push('--');

	// ---- lookups ----
	const segs = [laserToKshSegments(c.laser[0]), laserToKshSegments(c.laser[1])];
	const group = (arr) => { const mp = new Map(); for (const e of arr) { let g = mp.get(e.t); if (!g) mp.set(e.t, g = []); g.push(e); } return mp; };
	const bpmAt = group(c.bpm), stopAt = group(c.stops), tiltAt = group(c.tilt), spinAt = group(c.spins);
	const camAt = {}; for (const k of CAM_KEYS) camAt[k] = group(c.cam[k]);
	const seAt = group(c.slamSE), svolAt = group(c.slamVol), ftAt = group(c.filterType), pfgAt = group(c.pfilterGain), rawAt = group(c.raw);
	const fxStartAt = [group(c.fx[0]), group(c.fx[1])];
	const secAt = [group(c.laser[0]), group(c.laser[1])];
	const laserPtAt = [new Map(), new Map()];
	for (let i = 0; i < 2; i++) for (const s of c.laser[i]) for (const p of s.pts) if (!laserPtAt[i].has(s.t + p.ry)) laserPtAt[i].set(s.t + p.ry, p);

	// Event ticks for per-measure line division (dbl = needs doubled resolution, like libkson)
	const ev = [];
	let maxT = 0;
	const addEv = (t, dbl) => { ev.push({ t, dbl }); if (t > maxT) maxT = t; };
	for (const lanes of [c.bt, c.fx]) for (const lane of lanes) for (const n of lane) { addEv(n.t, n.l > 0); addEv(n.t + n.l, n.l > 0); }
	for (const s of segs) for (const g of s) { addEv(g.t, true); addEv(g.t + g.len, true); }
	for (const arr of [c.bpm, c.stops, c.tilt, c.spins, c.slamSE, c.slamVol, c.filterType, c.pfilterGain, c.raw]) for (const e of arr) addEv(e.t, false);
	for (const k of CAM_KEYS) for (const e of c.cam[k]) addEv(e.t, false);
	ev.sort((a, b) => a.t - b.t);

	const btChar = (lane, p) => {
		const n = findAt(lane, p);
		if (n) return n.l === 0 ? '1' : '2';
		const prev = lastAtOrBefore(lane, p);
		if (prev && p > prev.t && p < prev.t + prev.l) return '2';
		const i = lowerBound(lane, p) - 1; // a hold further back may still cover p if lanes overlap
		for (let k = i - 1; k >= 0 && k >= i - 3; k--) { const q = lane[k]; if (p > q.t && p < q.t + q.l) return '2'; }
		return '0';
	};
	const fxChar = (lane, p) => { const ch = btChar(lane, p); return ch === '1' ? '2' : ch === '2' ? '1' : '0'; };
	const laserChar = (sg, p) => {
		let i = upperBound(sg, p) - 1;
		for (let k = Math.max(0, i - 2); k <= i; k++) {
			const s = sg[k], end = s.t + s.len;
			if (p < s.t || p > end) continue;
			if (p === s.t) return laserXToChar(s.sv);
			if (p === end) return laserXToChar(s.ev);
			return ':';
		}
		return '-';
	};
	const writeGraph = (key, pt, intOnly) => {
		const f = intOnly ? (v) => String(Math.round(v)) : fmtNum;
		const s1 = f(pt.v); out.push(key + '=' + s1);
		if (pt.vf !== undefined && pt.vf !== pt.v) { const s2 = f(pt.vf); if (s2 !== s1) out.push(key + '=' + s2); }
		if (!isLinear(pt)) out.push(key + '_curve=' + fmtNum(pt.a) + ';' + fmtNum(pt.b));
	};
	const fmtTilt = (v) => typeof v === 'number' ? fmtNum(v) : v;

	const writeRow = (p) => {
		for (let i = 0; i < 2; i++) { const g = fxStartAt[i].get(p); if (g && g[0].l === 0 && g[0].se) out.push('fx-' + (i ? 'r' : 'l') + '_se=' + g[0].se); }
		const b = bpmAt.get(p);
		if (b) { const s = fmtNum(Math.min(b[0].v, 65535)); if (!(p === 0 && s === headerBpm)) out.push('t=' + s); }
		const raws = rawAt.get(p);
		if (raws) {
			for (const r of raws) if (r.k === '//') out.push('//' + r.v);
			for (const r of raws) if (r.k === '') out.push(r.v);
			for (const r of raws) if (r.k !== '//' && r.k !== '' && r.k !== 'fx-l' && r.k !== 'fx-r') out.push(r.k + '=' + r.v);
		}
		const cs = camAt.center_split.get(p); if (cs) writeGraph('center_split', cs[0], true);
		const pg = pfgAt.get(p); if (pg) for (const e of pg) out.push('pfiltergain=' + e.v);
		const ft = ftAt.get(p); if (ft) for (const e of ft) out.push('filtertype=' + e.v);
		const sv = svolAt.get(p); if (sv) for (const e of sv) out.push('chokkakuvol=' + e.v);
		const se = seAt.get(p); if (se) out.push('chokkakuse=' + se[0].v);
		const tl = tiltAt.get(p);
		if (tl) {
			const pt = tl[0];
			if (typeof pt.v === 'number') {
				if (!isLinear(pt)) out.push('tilt_curve=' + fmtNum(pt.a) + ';' + fmtNum(pt.b));
				out.push('tilt=' + fmtTilt(pt.v));
				if (pt.vf !== undefined && pt.vf !== pt.v) out.push('tilt=' + fmtTilt(pt.vf));
			} else if (p !== 0 || pt.v !== 'normal') out.push('tilt=' + pt.v);
		}
		for (const k of ['zoom_top', 'zoom_bottom', 'zoom_side']) { const g = camAt[k].get(p); if (g) writeGraph(k, g[0], true); }
		for (let i = 0; i < 2; i++) { const g = secAt[i].get(p); if (g && g[0].wide) out.push('laserrange_' + (i ? 'r' : 'l') + '=2x'); }
		for (let i = 0; i < 2; i++) { const pt = laserPtAt[i].get(p); if (pt && !isLinear(pt)) out.push('laser_' + (i ? 'r' : 'l') + '_curve=' + fmtNum(pt.a) + ';' + fmtNum(pt.b)); }
		const st = stopAt.get(p); if (st) out.push('stop=' + Math.round(st[0].l / KSH_LEN));
		const ss = camAt.scroll_speed.get(p);
		if (ss) { // USC reads scroll_speed as an integer percentage
			if (opts.usc) writeGraph('scroll_speed', { ...ss[0], v: ss[0].v * 100, vf: ss[0].vf !== undefined ? ss[0].vf * 100 : undefined }, true);
			else writeGraph('scroll_speed', ss[0], false);
		}
		const rd = camAt.rotation_deg.get(p); if (rd) writeGraph('rotation_deg', rd[0], false);
		for (let i = 0; i < 2; i++) {
			const key = 'fx-' + (i ? 'r' : 'l');
			const g = fxStartAt[i].get(p);
			if (g && g[0].l > 0 && g[0].fx !== undefined) out.push(key + '=' + g[0].fx);
			if (raws) for (const r of raws) if (r.k === key) out.push(key + '=' + r.v);
		}
		let line = btChar(c.bt[0], p) + btChar(c.bt[1], p) + btChar(c.bt[2], p) + btChar(c.bt[3], p) + '|' +
			fxChar(c.fx[0], p) + fxChar(c.fx[1], p) + '|' + laserChar(segs[0], p) + laserChar(segs[1], p);
		const sp = spinAt.get(p);
		if (sp) {
			const s = sp[0], len = Math.round(s.l / KSH_LEN);
			if (s.kind === 'spin') line += '@' + (s.dir < 0 ? '(' : ')') + len;
			else if (s.kind === 'half') line += '@' + (s.dir < 0 ? '<' : '>') + len;
			else {
				line += 'S' + (s.dir < 0 ? '<' : '>') + len;
				if (s.amp !== 250 || s.rep !== 3 || s.dec !== 2) line += ';' + s.amp + ';' + s.rep + ';' + s.dec;
			}
		}
		out.push(line);
	};

	let t = 0, mi = 0, curSig = { n: 4, d: 4 }, evi = 0;
	const sigByM = new Map(c.sig.map(s => [s.m, s]));
	for (;;) {
		const sig = timing.sigAt(mi);
		if (sigByM.has(mi) || sig.n !== curSig.n || sig.d !== curSig.d) { out.push('beat=' + sig.n + '/' + sig.d); curSig = sig; }
		const len = Math.floor(MEAS4 * sig.n / sig.d);
		// optimal division (libkson CalculateOptimalDivision)
		let g = len, dbl = false;
		while (evi < ev.length && ev[evi].t < t) evi++;
		for (let k = evi; k < ev.length && ev[k].t < t + len; k++) { const rel = ev[k].t - t; if (rel > 0) g = gcd(g, rel); if (ev[k].dbl) dbl = true; }
		let div = g > 0 ? len / g : len;
		if (div < len && dbl) {
			if (len % (div * 2) === 0) div *= 2;
			else if (len / div === 15 && len % (div * 3) === 0) div *= 3;
		}
		if (len % div !== 0) div = len;
		div = clamp(div, 1, len);
		const step = len / div;
		for (let i = 0; i < div; i++) writeRow(t + i * step);
		out.push('--');
		t += len; mi++;
		if (t > maxT) break;
	}
	for (const d of c.defs) out.push(d);
	return { text: '﻿' + out.join('\r\n') + '\r\n', warnings };
}

// KSM v1 compatibility: bake curves into linear steps, drop v2-only events
// Replace curved graph segments by straight steps every `step` ticks
function bakeGraph(pts, step, roundInt) {
	const res = [];
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i], q = pts[i + 1];
		res.push({ ...p, a: 0, b: 0 });
		if (!q || isLinear(p) || typeof q.v !== 'number' || typeof p.v !== 'number') continue;
		const pv = typeof p.vf === 'number' ? p.vf : p.v;
		for (let t = p.t + step; t < q.t; t += step) {
			let v = pv + (q.v - pv) * evalCurve(p.a, p.b, (t - p.t) / (q.t - p.t));
			v = roundInt ? Math.round(v) : round3(v);
			res.push({ id: nid(), t, v, a: 0, b: 0 });
		}
	}
	return res;
}
// Chart for unnamed sdvx clone (USC): no curves, rotation_deg folded into manual tilt
// (KSM v2 uses the same sign: rotation_deg 10 == tilt 1); scroll_speed is written as a percentage by exportKsh.
function toUsc(c, warnings, label = 'USC') {
	const d = toKsmV1({ ...c, cam: { ...c.cam, scroll_speed: [], rotation_deg: [] } }, warnings, label);
	d.cam.scroll_speed = bakeGraph(c.cam.scroll_speed, 15, false);
	const rot = bakeGraph(c.cam.rotation_deg, 15, false);
	if (rot.some(p => p.v !== 0 || (typeof p.vf === 'number' && p.vf !== 0))) {
		const tilt = d.tilt;
		const ticks = [...new Set([...rot.map(p => p.t), ...tilt.map(p => p.t)])].sort((a, b) => a - b);
		const val = (pts, t, after) => { // linear graph value; after = take the immediate value at t
			const i = upperBound(pts, t) - 1;
			if (i < 0) return pts.length ? (typeof pts[0].v === 'number' ? pts[0].v : null) : 0;
			const p = pts[i];
			if (p.t === t && !after) { const prev = pts[i - 1]; if (prev && typeof prev.v === 'number' && typeof p.v === 'number') return p.v; return typeof p.v === 'number' ? p.v : null; }
			const pv = p.vf !== undefined ? p.vf : p.v;
			if (typeof pv !== 'number') return null;
			const q = pts[i + 1];
			if (!q || typeof q.v !== 'number' || p.t === t) return pv;
			return pv + (q.v - pv) * (t - p.t) / (q.t - p.t);
		};
		const modeAt = (t, after) => { // auto-mode string in effect, or null when manual numbers apply
			const i = upperBound(tilt, after ? t : t - 1) - 1; if (i < 0) return 'normal';
			const p = tilt[i], v = after || p.t < t ? (p.vf !== undefined ? p.vf : p.v) : p.v;
			return typeof v === 'string' ? v : null;
		};
		const out = []; let replacedAuto = false;
		for (const t of ticks) {
			const r0 = val(rot, t, false) || 0, r1 = val(rot, t, true) || 0;
			const before = val(rot, t - 1, true) || 0, after = val(rot, t + 1, true) || 0;
			const own = tilt.find(p => p.t === t);
			if (r0 === 0 && r1 === 0 && before === 0 && after === 0) { if (own) out.push(own); continue; }
			const m0 = modeAt(t, false), m1 = modeAt(t, true);
			if ((m0 && r0) || (m1 && r1)) replacedAuto = true;
			const v0 = round3(r0 / 10 + (m0 ? 0 : (val(tilt, t, false) || 0)));
			const v1 = r1 === 0 && after === 0 && m1 ? m1 : round3(r1 / 10 + (m1 ? 0 : (val(tilt, t, true) || 0)));
			const np = { id: nid(), t, v: v0, a: 0, b: 0 };
			if (v1 !== v0) np.vf = v1;
			out.push(np);
		}
		d.tilt = out;
		warnings.push({ t: rot[0].t, msg: 'rotation_deg was converted to manual tilt (' + label + ' has no rotation_deg).' + (replacedAuto ? ' While the lane is rotated, the automatic laser tilt is off.' : '') });
	}
	return d;
}
function toKsmV1(c, warnings, label = 'KSM v1') {
	const d = cloneChart(c);
	const bake = bakeGraph;
	let baked = 0;
	for (const k of ['zoom_top', 'zoom_bottom', 'zoom_side', 'center_split']) { if (d.cam[k].some(p => !isLinear(p))) baked++; d.cam[k] = bake(d.cam[k], 15, true); }
	if (d.tilt.some(p => !isLinear(p))) baked++;
	d.tilt = bake(d.tilt, 15, false);
	d.laser = d.laser.map(lane => lane.map(sec => {
		if (sec.pts.every(isLinear)) return sec;
		baked++;
		const pts = [];
		for (let i = 0; i < sec.pts.length; i++) {
			const p = sec.pts[i], q = sec.pts[i + 1];
			pts.push({ ...p, a: 0, b: 0 });
			if (!q || isLinear(p)) continue;
			const len = q.ry - p.ry, n = Math.floor(len / 40); // keep steps > 1/32 so they never read back as slams
			for (let k = 1; k < n; k++) {
				const ry = p.ry + Math.floor(k * len / n);
				const v = Math.round(p.vf + (q.v - p.vf) * evalCurve(p.a, p.b, (ry - p.ry) / len));
				pts.push({ id: nid(), ry, v, vf: v, a: 0, b: 0 });
			}
		}
		return { ...sec, pts };
	}));
	if (baked) warnings.push({ t: 0, msg: 'Curves were converted to straight steps for ' + label + '.' });
	if (d.cam.scroll_speed.length) { warnings.push({ t: d.cam.scroll_speed[0].t, msg: 'scroll_speed is not supported by KSM v1 and was left out.' }); d.cam.scroll_speed = []; }
	if (d.cam.rotation_deg.length) { warnings.push({ t: d.cam.rotation_deg[0].t, msg: 'rotation_deg is not supported by KSM v1 and was left out.' }); d.cam.rotation_deg = []; }
	return d;
}

// ---------------------------------------------------------------------------
// Validation (things that would change or break when saved as KSH)
// ---------------------------------------------------------------------------
function validateChart(c) {
	const w = [];
	const lanesCheck = (lanes, name) => lanes.forEach((lane, li) => {
		for (let i = 0; i + 1 < lane.length; i++) {
			const a = lane[i], b = lane[i + 1];
			if (b.t < a.t + a.l) w.push({ t: b.t, level: 'error', msg: `${name} ${li + 1}: notes overlap.` });
			else if (a.l > 0 && b.l > 0 && b.t === a.t + a.l) w.push({ t: b.t, level: 'error', msg: `${name} ${li + 1}: two holds touch end-to-start and will merge into one in KSH.` });
		}
	});
	lanesCheck(c.bt, 'BT'); lanesCheck(c.fx, 'FX');
	c.laser.forEach((lane, li) => {
		const nm = li ? 'Laser R' : 'Laser L';
		for (let i = 0; i < lane.length; i++) {
			const s = lane[i], n = lane[i + 1];
			if (!s.pts.length) continue;
			if (s.pts.length === 1 && s.pts[0].v === s.pts[0].vf) w.push({ t: s.t, level: 'error', msg: `${nm}: a laser needs at least two points or a slam.` });
			for (let k = 0; k + 1 < s.pts.length; k++) {
				const p = s.pts[k], q = s.pts[k + 1];
				if (q.ry <= p.ry) w.push({ t: s.t + q.ry, level: 'error', msg: `${nm}: points out of order.` });
				else if (q.ry - p.ry <= SLAM_LEN && p.v === p.vf && q.v !== p.vf) w.push({ t: s.t + p.ry, level: 'warn', msg: `${nm}: a segment of 1/32 or shorter will be read as a slam.` });
			}
			if (n && n.t <= sectionEndTick(s)) w.push({ t: n.t, level: 'error', msg: `${nm}: lasers overlap or touch; leave a gap between them.` });
		}
	});
	if (!c.meta.m) w.push({ t: 0, level: 'info', msg: 'No music file set (m=).' });
	for (const k of ['scroll_speed', 'rotation_deg']) if (c.cam[k].length) w.push({ t: c.cam[k][0].t, level: 'info', msg: `${k} only works in KSM v2 (ignored by KSM v1).` });
	const curved = c.laser.some(l => l.some(s => s.pts.some(p => !isLinear(p)))) || CAM_KEYS.some(k => c.cam[k].some(p => !isLinear(p))) || c.tilt.some(p => !isLinear(p));
	if (curved) w.push({ t: 0, level: 'info', msg: 'Curves only work in KSM v2. Use "Export for KSM v1" to convert them to steps.' });
	// sound: things that make lasers / FX holds silent
	const hasLasers = c.laser.some(l => l.length);
	const pg0 = c.meta.pfiltergain === '' || c.meta.pfiltergain === undefined ? 50 : parseFloat(c.meta.pfiltergain);
	if (hasLasers && pg0 === 0) w.push({ t: 0, level: 'warn', msg: 'pfiltergain is 0 in the header, so lasers make no sound effect until a "Laser effect strength" event raises it. KSM\'s default is 50.' });
	const silentHolds = c.fx.reduce((a, l) => a + l.filter(n => n.l > 0 && !n.fx).length, 0);
	if (silentHolds) w.push({ t: (c.fx.flat().find(n => n.l > 0 && !n.fx) || { t: 0 }).t, level: 'info', msg: `${silentHolds} FX hold${silentHolds > 1 ? 's have' : ' has'} no effect set (fx-l= / fx-r= empty), so ${silentHolds > 1 ? 'they change' : 'it changes'} nothing in the music.` });
	if (+(c.meta.chokkakuvol || 50) === 0 && c.laser.some(l => l.some(s => s.pts.some(p => p.v !== p.vf)))) w.push({ t: 0, level: 'info', msg: 'chokkakuvol is 0, so slams are silent.' });
	return w.sort((a, b) => a.t - b.t);
}

const KSMCore = {
	RES, MEAS4, LASER_MAX, SLAM_LEN, KSH_LEN, CAM_KEYS, TILT_AUTO, HEADER_KEYS, FX_EFFECTS, LEGACY_FX_CHARS, LASER_FILTERS,
	SLAM_SOUNDS, FX_CHIP_SOUNDS, BG_PRESETS, LAYER_PRESETS, DIFFICULTIES, CURVE_PRESETS,
	nid, newChart, cloneChart, Timing, ScrollMap, importKsh, exportKsh, toKsmV1, toUsc, bakeGraph, validateChart, laserToKshSegments,
	lowerBound, upperBound, lastAtOrBefore, findAt, insertSorted, sortByT, charToLaserX, laserXToChar, laserPos, posToLaserX,
	evalCurve, isLinear, laserValueAt, graphValueAt, sectionEndTick, fmtNum, autoDispBpm, clamp, decodeKshBytes,
};
if (typeof module !== 'undefined' && module.exports) module.exports = KSMCore;
else root.KSMCore = KSMCore;
})(this);
