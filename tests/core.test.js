// Node tests for src/core.js. Usage: node tests/core.test.js [path-to-libkson-tests-assets]
// Compares our KSH importer with libkson's own conversion (Gram_ex.kson) and checks
// that export -> import round-trips every bundled chart without changes.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const K = require('../src/core.js');

const ASSETS = process.argv[2] || path.join(__dirname, '../../libkson/tests/assets');
let failures = 0, checks = 0;
function check(name, fn) {
	try { fn(); checks++; console.log('  ok  ' + name); }
	catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 6).join('\n       ')); }
}

// ---------- canonical (id-free) view of a chart ----------
function canon(c) {
	const strip = (o) => { const r = { ...o }; delete r.id; return r; };
	return {
		meta: c.meta, metaExtra: c.metaExtra,
		bt: c.bt.map(l => l.map(strip)), fx: c.fx.map(l => l.map(strip)),
		laser: c.laser.map(l => l.map(s => ({ t: s.t, wide: !!s.wide, pts: s.pts.map(strip) }))),
		bpm: c.bpm.map(strip), sig: c.sig.map(strip), stops: c.stops.map(strip),
		cam: Object.fromEntries(K.CAM_KEYS.map(k => [k, c.cam[k].map(strip)])),
		tilt: c.tilt.map(strip), spins: c.spins.map(strip), slamSE: c.slamSE.map(strip), slamVol: c.slamVol.map(strip),
		filterType: c.filterType.map(strip), pfilterGain: c.pfilterGain.map(strip), raw: c.raw.map(strip), defs: c.defs,
	};
}

// ---------- kson comparison helpers ----------
const gv = (x) => Array.isArray(x) ? x : [x, x];                 // GraphValue -> [v, vf]
function graphPoint(p) { // kson GraphPoint json -> {v, vf, a, b}
	let v = p, curve = [0, 0];
	if (Array.isArray(p) && p.length === 2 && Array.isArray(p[1]) && !Array.isArray(p[0]) && typeof p[1][0] === 'number' && p[1].length === 2 && typeof p[0] === 'number' && isCurveForm(p)) { v = p[0]; curve = p[1]; }
	else if (Array.isArray(p) && Array.isArray(p[0])) { v = p[0]; curve = p[1]; }
	const [a, b] = gv(v);
	return { v: a, vf: b, ca: curve[0], cb: curve[1] };
}
function isCurveForm(p) { return false; } // [v, [a,b]] vs [v, vf] is ambiguous; Gram has no curves
const laserVal = (x, wide) => wide ? (x === 12 ? 0.25 : x === 37 ? 0.75 : x / 50) : x / 50;
const near = (a, b) => Math.abs(a - b) < 1e-9;

function compareWithKson(chart, kson) {
	check('BT notes match libkson', () => {
		for (let i = 0; i < 4; i++) {
			const exp = kson.note.bt[i].map(e => Array.isArray(e) ? [e[0], e[1]] : [e, 0]);
			const got = chart.bt[i].map(n => [n.t, n.l]);
			assert.deepStrictEqual(got, exp, 'BT lane ' + i);
		}
	});
	check('FX notes match libkson', () => {
		for (let i = 0; i < 2; i++) {
			const exp = kson.note.fx[i].map(e => Array.isArray(e) ? [e[0], e[1]] : [e, 0]);
			const got = chart.fx[i].map(n => [n.t, n.l]);
			assert.deepStrictEqual(got, exp, 'FX lane ' + i);
		}
	});
	check('Laser sections match libkson (incl. slams + wide)', () => {
		for (let i = 0; i < 2; i++) {
			const exp = kson.note.laser[i];
			assert.strictEqual(chart.laser[i].length, exp.length, 'section count lane ' + i);
			exp.forEach((es, si) => {
				const s = chart.laser[i][si];
				const wide = es[2] === 2;
				assert.strictEqual(s.t, es[0], 'section start');
				assert.strictEqual(!!s.wide, wide, 'wide at ' + s.t);
				assert.strictEqual(s.pts.length, es[1].length, 'point count at section ' + s.t);
				es[1].forEach((ep, pi) => {
					const p = s.pts[pi], g = graphPoint(ep[1]);
					assert.strictEqual(p.ry, ep[0], 'ry');
					assert.ok(near(laserVal(p.v, wide), g.v) && near(laserVal(p.vf, wide), g.vf), `value at ${s.t}+${p.ry}: got ${p.v}/${p.vf} exp ${g.v}/${g.vf}`);
				});
			});
		}
	});
	check('BPM / time signature match libkson', () => {
		assert.deepStrictEqual(chart.bpm.map(b => [b.t, b.v]), kson.beat.bpm);
		assert.deepStrictEqual(chart.sig.map(s => [s.m, [s.n, s.d]]), kson.beat.time_sig);
		assert.deepStrictEqual(chart.stops.map(s => [s.t, s.l]), kson.beat.stop || []);
	});
	check('Camera zoom graphs match libkson', () => {
		const body = kson.camera.cam.body;
		for (const k of K.CAM_KEYS) {
			if (k === 'scroll_speed') continue;
			const exp = (body[k] || []).map(e => { const g = graphPoint(e[1]); return [e[0], g.v, g.vf]; });
			const got = chart.cam[k].map(p => [p.t, p.v, p.vf !== undefined ? p.vf : p.v]);
			assert.deepStrictEqual(got, exp, k);
		}
	});
	check('Tilt matches libkson', () => {
		const exp = kson.camera.tilt.filter(e => !(e[0] === 0 && e[1] === 'normal'));
		const got = chart.tilt.map(p => [p.t, p.vf !== undefined ? [p.v, p.vf] : p.v]);
		assert.deepStrictEqual(got, exp);
	});
	check('Spins / swings match libkson', () => {
		const pat = (kson.camera.cam.pattern || {}).laser || {};
		const se = pat.slam_event || {};
		const exp = [];
		for (const e of se.spin || []) exp.push([e[0], 'spin', e[1], e[2]]);
		for (const e of se.half_spin || []) exp.push([e[0], 'half', e[1], e[2]]);
		for (const e of se.swing || []) exp.push([e[0], 'swing', e[1], e[2], e[3].scale, e[3].repeat, e[3].decay_order]);
		exp.sort((a, b) => a[0] - b[0]);
		const got = chart.spins.map(s => s.kind === 'swing' ? [s.t, s.kind, s.dir, s.l, s.amp, s.rep, s.dec] : [s.t, s.kind, s.dir, s.l]);
		assert.deepStrictEqual(got, exp);
	});
	check('Slam sounds + slam volume match libkson', () => {
		const ks = kson.audio.key_sound.laser;
		const exp = []; for (const [nm, ts] of Object.entries(ks.slam_event || {})) for (const t of ts) exp.push([t, nm]);
		assert.deepStrictEqual(chart.slamSE.map(e => [e.t, e.v]), exp.sort((a, b) => a[0] - b[0]));
		const volExp = ks.vol.filter(e => e[0] !== 0).map(e => [e[0], Math.round(e[1] * 100)]);
		assert.deepStrictEqual(chart.slamVol.map(e => [e.t, +e.v]), volExp);
	});
	check('FX effect events at the same ticks as libkson', () => {
		const le = kson.audio.audio_effect.fx.long_event;
		for (let lane = 0; lane < 2; lane++) {
			const exp = new Set();
			for (const lanes of Object.values(le)) for (const e of lanes[lane]) exp.add(Array.isArray(e) ? e[0] : e);
			const got = new Set();
			for (const n of chart.fx[lane]) if (n.l > 0 && n.fx !== undefined && n.fx !== '') got.add(n.t);
			for (const r of chart.raw) if (r.k === (lane ? 'fx-r' : 'fx-l') && r.v !== '') got.add(r.t);
			assert.deepStrictEqual([...got].sort((a, b) => a - b), [...exp].sort((a, b) => a - b), 'lane ' + lane);
		}
	});
}

// ---------- run ----------
console.log('KSH import vs libkson (Gram_ex.kson)');
const ksonEx = JSON.parse(fs.readFileSync(path.join(ASSETS, 'Gram_ex.kson'), 'utf8').replace(/^﻿/, ''));
const ex = K.importKsh(fs.readFileSync(path.join(ASSETS, 'Gram_ex.ksh')));
compareWithKson(ex.chart, ksonEx);

console.log('Round trip export -> import (all bundled charts)');
for (const f of fs.readdirSync(ASSETS).filter(f => f.endsWith('.ksh'))) {
	const a = K.importKsh(fs.readFileSync(path.join(ASSETS, f)));
	const txt = K.exportKsh(a.chart).text;
	const b = K.importKsh(Buffer.from(txt, 'utf8'));
	check(`${f}: round trip is lossless`, () => {
		const ca = canon(a.chart), cb = canon(b.chart);
		// header 'ver' may be upgraded to 160 (+ver_compat) for legacy charts
		for (const k of Object.keys(ca)) assert.deepStrictEqual(cb[k], ca[k], 'field ' + k);
	});
	check(`${f}: second export is byte-identical`, () => {
		assert.strictEqual(K.exportKsh(b.chart).text, txt);
	});
	check(`${f}: exported measure count and row divisions valid`, () => {
		const body = txt.split('\r\n');
		let rows = 0, bad = 0, measures = 0, sig = [4, 4];
		for (const l of body.slice(body.indexOf('--') + 1)) {
			if (l === '--') { measures++; const len = 960 * sig[0] / sig[1]; if (rows && len % rows) bad++; rows = 0; }
			else if (l.startsWith('beat=')) sig = l.slice(5).split('/').map(Number);
			else if (l.includes('|')) rows++;
		}
		assert.strictEqual(bad, 0, 'measures with uneven division');
		assert.ok(measures > 10);
	});
}

console.log('Editor-made chart (slams, curves, camera, spins)');
(() => {
	const c = K.newChart();
	c.meta.title = 'Test'; c.meta.m = 'song.ogg';
	c.bt[0].push({ id: K.nid(), t: 0, l: 0 }, { id: K.nid(), t: 240, l: 480 });
	c.bt[3].push({ id: K.nid(), t: 960, l: 960 });
	c.fx[0].push({ id: K.nid(), t: 480, l: 0, se: 'clap;80' }, { id: K.nid(), t: 960, l: 720, fx: 'Retrigger;16' });
	c.fx[1].push({ id: K.nid(), t: 1920, l: 240, fx: 'Echo;4;60' });
	c.laser[0].push({ id: K.nid(), t: 0, wide: false, pts: [{ id: 1, ry: 0, v: 0, vf: 0, a: 0, b: 0 }, { id: 2, ry: 480, v: 25, vf: 50, a: 0.5, b: 1 }, { id: 3, ry: 960, v: 0, vf: 0, a: 0, b: 0 }] });
	c.laser[1].push({ id: K.nid(), t: 1920, wide: true, pts: [{ id: 4, ry: 0, v: 50, vf: 12, a: 0, b: 0 }] });
	c.laser[1].push({ id: K.nid(), t: 2400, wide: false, pts: [{ id: 5, ry: 0, v: 50, vf: 50, a: 0, b: 0 }, { id: 6, ry: 15, v: 0, vf: 0, a: 0, b: 0 }] }); // 1/64 slope -> slam on reload
	c.bpm.push({ id: K.nid(), t: 1920, v: 181.5 });
	c.sig.push({ id: K.nid(), m: 2, n: 3, d: 4 });
	c.stops.push({ id: K.nid(), t: 960, l: 120 });
	c.cam.zoom_top.push({ id: K.nid(), t: 0, v: 0, a: 0, b: 0 }, { id: K.nid(), t: 960, v: 100, vf: -50, a: 0.5, b: 0 }, { id: K.nid(), t: 1920, v: 0, a: 0, b: 0 });
	c.cam.rotation_deg.push({ id: K.nid(), t: 480, v: 0, a: 0, b: 0 }, { id: K.nid(), t: 960, v: 90, a: 0, b: 0 });
	c.tilt.push({ id: K.nid(), t: 480, v: 0.5, a: 0, b: 0 }, { id: K.nid(), t: 960, v: 1, vf: 'normal', a: 0, b: 0 }, { id: K.nid(), t: 1440, v: 'keep_bigger', a: 0, b: 0 });
	c.spins.push({ id: K.nid(), t: 480, kind: 'spin', dir: 1, l: 960, amp: 250, rep: 3, dec: 2 }, { id: K.nid(), t: 1920, kind: 'swing', dir: -1, l: 640, amp: 100, rep: 3, dec: 1 });
	c.slamSE.push({ id: K.nid(), t: 480, v: 'down' });
	const txt = K.exportKsh(c).text;
	const back = K.importKsh(Buffer.from(txt, 'utf8')).chart;
	check('hold lengths and chips survive', () => assert.deepStrictEqual(back.bt.map(l => l.map(n => [n.t, n.l])), [[[0, 0], [240, 480]], [], [], [[960, 960]]]));
	check('FX effects + chip keysound survive', () => {
		assert.deepStrictEqual(back.fx[0].map(n => [n.t, n.l, n.fx, n.se]), [[480, 0, undefined, 'clap;80'], [960, 720, 'Retrigger;16', undefined]]);
		assert.deepStrictEqual(back.fx[1].map(n => [n.t, n.l, n.fx]), [[1920, 240, 'Echo;4;60']]);
	});
	check('mid-laser slam with curve survives', () => {
		const s = back.laser[0][0];
		assert.deepStrictEqual(s.pts.map(p => [p.ry, p.v, p.vf, p.a, p.b]), [[0, 0, 0, 0, 0], [480, 25, 50, 0.5, 1], [960, 0, 0, 0, 0]]);
	});
	check('single-point wide slam survives', () => {
		const s = back.laser[1][0];
		assert.strictEqual(s.wide, true);
		assert.deepStrictEqual(s.pts.map(p => [p.ry, p.v, p.vf]), [[0, 50, 12]]);
	});
	check('1/64 slope becomes a slam (KSM rule)', () => {
		assert.deepStrictEqual(back.laser[1][1].pts.map(p => [p.ry, p.v, p.vf]), [[0, 50, 0]]);
	});
	check('BPM, beat, stop survive', () => {
		assert.deepStrictEqual(back.bpm.map(b => [b.t, b.v]), [[0, 120], [1920, 181.5]]);
		assert.deepStrictEqual(back.sig.map(s => [s.m, s.n, s.d]), [[0, 4, 4], [2, 3, 4]]);
		assert.deepStrictEqual(back.stops.map(s => [s.t, s.l]), [[960, 120]]);
	});
	check('camera graph with jump + curve survives', () => {
		assert.deepStrictEqual(back.cam.zoom_top.map(p => [p.t, p.v, p.vf, p.a, p.b]), [[0, 0, undefined, 0, 0], [960, 100, -50, 0.5, 0], [1920, 0, undefined, 0, 0]]);
		assert.deepStrictEqual(back.cam.rotation_deg.map(p => [p.t, p.v]), [[480, 0], [960, 90]]);
	});
	check('tilt manual/auto/jump survives', () => {
		assert.deepStrictEqual(back.tilt.map(p => [p.t, p.v, p.vf]), [[480, 0.5, undefined], [960, 1, 'normal'], [1440, 'keep_bigger', undefined]]);
	});
	check('spins + swing survive', () => {
		assert.deepStrictEqual(back.spins.map(s => [s.t, s.kind, s.dir, s.l, s.amp, s.rep, s.dec]), [[480, 'spin', 1, 960, 250, 3, 2], [1920, 'swing', -1, 640, 100, 3, 1]]);
		assert.deepStrictEqual(back.slamSE.map(e => [e.t, e.v]), [[480, 'down']]);
	});
	check('KSM v1 export bakes curves and drops rotation', () => {
		const v1 = K.exportKsh(c, { v1: true });
		assert.ok(!/_curve=/.test(v1.text), 'no curve lines');
		assert.ok(!/rotation_deg=/.test(v1.text), 'no rotation');
		const b1 = K.importKsh(Buffer.from(v1.text, 'utf8')).chart;
		const s = b1.laser[0][0];
		assert.ok(s.pts.length > 3, 'laser curve baked into points');
		assert.ok(s.pts.every(p => K.isLinear(p)));
		for (let i = 1; i < s.pts.length; i++) assert.ok(s.pts[i].v === s.pts[i - 1].vf || s.pts[i].ry - s.pts[i - 1].ry > 30, 'no accidental slams');
		assert.strictEqual(s.pts.filter(p => p.v !== p.vf).length, 1, 'only the original slam');
	});
	check('header has BOM, CRLF, ver=171', () => {
		assert.ok(txt.startsWith('﻿title=Test\r\n'));
		assert.ok(/\r\nver=171\r\n/.test(txt));
	});
})();

console.log('Timing');
check('tick<->sec with BPM change', () => {
	const c = K.newChart(); c.bpm.push({ id: 1, t: 960, v: 240 });
	const tm = new K.Timing(c);
	assert.ok(near(tm.tickToSec(960), 2));
	assert.ok(near(tm.tickToSec(1920), 3));
	assert.ok(near(tm.secToTick(2.5), 1440));
});
check('measures with 3/4 + 7/8', () => {
	const c = K.newChart(); c.sig.push({ id: 1, m: 1, n: 3, d: 4 }, { id: 2, m: 3, n: 7, d: 8 });
	const tm = new K.Timing(c);
	assert.strictEqual(tm.measureStart(1), 960);
	assert.strictEqual(tm.measureStart(3), 960 + 720 * 2);
	assert.strictEqual(tm.measureStart(4), 960 + 1440 + 840);
	assert.deepStrictEqual(tm.measureOf(960 + 1440 + 100).m, 3);
	assert.strictEqual(tm.snap(960 + 125, 16), 960 + 120);
});

console.log(`\n${checks} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
