// Node tests for the USC / SOUND VOLTEX exporters (src/core.js toUsc, src/sdvx.js).
// Usage: node tests/export.test.js [chart.ksh reference.vox]
// With a .ksh and the .vox the game accepts for it, the VOX output is compared section by section.
'use strict';
const fs = require('fs');
const assert = require('assert');
global.K = require('../src/core.js');
global.KSMFX = require('../src/fx.js');
const SDVX = require('../src/sdvx.js');
const vox10 = (c) => SDVX.buildVox(c, { format: 10 }).text;
const vox12 = (c) => SDVX.buildVox(c, { format: 12 }).text.replace(/\r\n/g, '\n');

let failures = 0, checks = 0;
function check(name, fn) {
	try { fn(); checks++; console.log('  ok  ' + name); }
	catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 6).join('\n       ')); }
}
const P = (o) => ({ id: K.nid(), a: 0, b: 0, ...o });

console.log('USC export');
check('rotation_deg becomes manual tilt with the same sign, auto tilt restored afterwards', () => {
	const c = K.newChart();
	c.tilt = [P({ t: 0, v: 'bigger' })];
	c.cam.rotation_deg = [P({ t: 960, v: 0 }), P({ t: 1920, v: 180 }), P({ t: 2880, v: 180, vf: 0 })];
	const back = K.importKsh(K.exportKsh(c, { usc: true }).text).chart;
	assert.deepStrictEqual(back.tilt.map(p => [p.t, p.v, p.vf]), [[0, 'bigger', undefined], [960, 0, undefined], [1920, 18, undefined], [2880, 18, 'bigger']]);
	assert.strictEqual(back.cam.rotation_deg.length, 0);
});
check('scroll_speed is written as an integer percentage, curves are baked', () => {
	const c = K.newChart();
	c.cam.scroll_speed = [P({ t: 0, v: 1 }), P({ t: 960, v: 0.5, vf: 2 })];
	c.cam.zoom_top = [P({ t: 0, v: 0, a: 0.5, b: 1 }), P({ t: 960, v: 100 })];
	const text = K.exportKsh(c, { usc: true }).text;
	assert.ok(/scroll_speed=100\r\n/.test(text) && /scroll_speed=50\r\n/.test(text) && /scroll_speed=200\r\n/.test(text), 'percent values');
	assert.ok(!/_curve=/.test(text), 'no *_curve lines');
	assert.ok((text.match(/zoom_top=/g) || []).length > 10, 'curve baked into steps');
});

console.log('VOX');
check('positions use the time signature\'s own beat unit', () => {
	const c = K.newChart();
	c.sig = [P({ m: 0, n: 4, d: 4 }), P({ m: 1, n: 9, d: 8 })];
	c.bt[0] = [P({ t: 960 + 120 * 3 + 40, l: 0 })]; // measure 2 (9/8): 4th eighth note + 1/48 note
	const v = vox12(c);
	assert.ok(v.includes('#TRACK3\n002,04,08\t0\t0\n#END'), v.slice(v.indexOf('#TRACK3'), v.indexOf('#TRACK3') + 40));
	assert.ok(v.includes('#BEAT INFO\n001,01,00\t4\t4\n002,01,00\t9\t8\n#END'));
});
check('lasers: start/continue/end nodes, slams as two rows, filter and wide flags', () => {
	const c = K.newChart();
	c.filterType = [P({ t: 480, v: 'lpf1' })];
	c.laser[0] = [P({ t: 0, wide: false, pts: [P({ ry: 0, v: 0, vf: 0 }), P({ ry: 480, v: 50, vf: 25 }), P({ ry: 960, v: 0, vf: 50 })] })];
	c.spins = [P({ t: 960, kind: 'spin', dir: 1, l: 360 })];
	const v = vox10(c);
	const rows = v.slice(v.indexOf('#TRACK1\n') + 8, v.indexOf('#END', v.indexOf('#TRACK1'))).trim().split('\n');
	assert.deepStrictEqual(rows, ['001,01,00\t0\t1\t0\t0\t1\t0', '001,03,00\t124\t0\t0\t1\t1\t0', '001,03,00\t62\t0\t0\t1\t1\t0', '002,01,00\t0\t0\t3\t1\t1\t0', '002,01,00\t124\t2\t0\t1\t1\t0']);
});
check('format 12: decimal laser positions, explicit spin length in 1/10 beats, CRLF', () => {
	const c = K.newChart();
	c.laser[1] = [P({ t: 0, wide: true, pts: [P({ ry: 0, v: 50, vf: 50 }), P({ ry: 480, v: 25, vf: 0 })] })];
	c.spins = [P({ t: 480, kind: 'spin', dir: -1, l: 360 })];
	const raw = SDVX.buildVox(c).text;
	assert.ok(raw.includes('#FORMAT VERSION\r\n12\r\n'));
	const rows = raw.replace(/\r\n/g, '\n').split('#TRACK8\n')[1].split('\n#END')[0].split('\n');
	assert.deepStrictEqual(rows, ['001,01,00\t1.000000\t1\t0\t0\t2\t0\t0\t0', '001,03,00\t0.500000\t0\t6\t0\t2\t0\t0\t30', '001,03,00\t0.000000\t2\t0\t0\t2\t0\t0\t0']);
});
check('a spin on a tick where both lasers slam is written once, on the slam that turns its way', () => {
	const c = K.newChart();
	c.laser[0] = [P({ t: 0, wide: false, pts: [P({ ry: 0, v: 0, vf: 0 }), P({ ry: 480, v: 0, vf: 50 }), P({ ry: 960, v: 50, vf: 50 })] })];
	c.laser[1] = [P({ t: 0, wide: false, pts: [P({ ry: 0, v: 50, vf: 50 }), P({ ry: 480, v: 50, vf: 0 }), P({ ry: 960, v: 0, vf: 0 })] })];
	c.spins = [P({ t: 480, kind: 'spin', dir: 1, l: 240 })];
	const v = vox12(c), rolls = (tr) => v.split('#' + tr + '\n')[1].split('\n#END')[0].split('\n').filter(r => r.split('\t')[3] !== '0');
	assert.deepStrictEqual([rolls('TRACK1').length, rolls('TRACK8').length], [0, 1]);
	const back = SDVX.importVox(SDVX.buildVox(c).text, 'x_5m.vox').chart;
	assert.deepStrictEqual(back.spins.map(s => [s.t, s.kind, s.dir]), [[480, 'spin', 1]]);
});
check('FX holds get one effect pair each (2-indexed), holds without effect use 0', () => {
	const c = K.newChart();
	c.fx[0] = [P({ t: 0, l: 240, fx: 'Retrigger;16' }), P({ t: 960, l: 240 })];
	c.fx[1] = [P({ t: 0, l: 240, fx: 'Gate;8' }), P({ t: 1920, l: 0, se: 'clap' })];
	const v = vox12(c);
	assert.ok(v.includes('#FXBUTTON EFFECT INFO\n1,\t8,\t95.00,\t2.00,\t1.00,\t0.85,\t0.15\n0,\t0,\t0,\t0,\t0,\t0,\t0\n\n2,\t100.00,\t4,\t1.00\n'));
	assert.ok(v.includes('#TRACK2\n001,01,00\t48\t2\n002,01,00\t48\t0\n#END'));
	assert.ok(v.includes('#TRACK7\n001,01,00\t48\t3\n003,01,00\t0\t3\n#END'));
});
check('camera: zoom_top -> CAM_RotX, zoom_bottom -> CAM_Radi (linear, from the 777 conversion), tilt / -1.5', () => {
	const c = K.newChart();
	c.cam.zoom_top = [P({ t: 960, v: 0 }), P({ t: 1920, v: -40 })];
	c.cam.zoom_bottom = [P({ t: 960, v: 30 })];
	c.tilt = [P({ t: 960, v: -1.2 }), P({ t: 1200, v: 0 }), P({ t: 1920, v: 'normal' })];
	const v = vox12(c);
	assert.ok(v.includes('002,01,00\tCAM_RotX\t2\t192\t0.00\t-0.33\t0.00\t0.00'));
	assert.ok(v.includes('001,01,00\tCAM_Radi\t2\t192\t-0.40\t-0.40\t0.00\t0.00\n002,01,00\tCAM_Radi\t2\t'), 'hold rows from the start and to the end like the game\'s files');
	assert.ok(v.includes('002,01,00\tTilt\t2\t48\t0.80\t0.00\t0.00\t0.00'));
});
const [kshPath, voxPath] = process.argv.slice(2);
if (kshPath && voxPath && fs.existsSync(kshPath) && fs.existsSync(voxPath)) {
	const { chart } = K.importKsh(fs.readFileSync(kshPath));
	const ours = SDVX.buildVox(chart, { laserEdge: 124, format: 10 }).text;
	const parse = (txt) => { const S = {}; let sec = null; for (const l of txt.split(/\r?\n/)) { if (l.startsWith('//') || !l.trim()) continue; if (l.startsWith('#')) { sec = l === '#END' ? null : l.slice(1); if (sec) S[sec] = S[sec] || []; continue; } if (sec) S[sec].push(l); } return S; };
	const A = parse(ours), B = parse(fs.readFileSync(voxPath, 'utf8'));
	const same = (name, n) => { const a = A[name].map(r => r.split('\t').slice(0, n).join('\t')), b = B[name].map(r => r.split('\t').slice(0, n).join('\t')); assert.deepStrictEqual(a, b); };
	for (const s of ['BEAT INFO', 'BPM INFO', 'END POSITION', 'TAB EFFECT INFO', 'FXBUTTON EFFECT INFO', 'TAB PARAM ASSIGN INFO'])
		check('matches the reference .vox: ' + s, () => same(s, 99));
	check('matches the reference .vox: laser rows in 4/4 sections (positions, values, node types, filters)', () => {
		for (const tr of ['TRACK1', 'TRACK8']) {
			const key = (r) => r.split('\t').slice(0, 3).join(' ') + ' ' + r.split('\t')[4];
			const inFour = (r) => +r.slice(0, 3) < 116; // the reference file mis-places notes in its 9/8, 10/8 and 10/2 measures
			const a = A[tr].filter(inFour).map(key), b = new Set(B[tr].filter(inFour).map(key));
			const missing = a.filter(x => !b.has(x));
			assert.ok(missing.length <= 2, tr + ': ' + missing.length + ' rows differ: ' + missing.slice(0, 5).join(' | '));
		}
	});
}

console.log('Audio containers');
check('MS-ADPCM round trip keeps the signal (SNR > 25 dB) and has the game\'s header layout', () => {
	const n = 44100 * 2, l = new Float32Array(n), r = new Float32Array(n);
	for (let i = 0; i < n; i++) { const t = i / 44100; l[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1760 * t); r[i] = 0.5 * Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t); }
	const wav = SDVX.encodeAdpcmWav(l, r, 44100), back = SDVX.decodeAdpcmWav(wav);
	let se = 0, ss = 0; for (let i = 0; i < n; i++) { se += (back.left[i] - l[i]) ** 2 + (back.right[i] - r[i]) ** 2; ss += l[i] ** 2 + r[i] ** 2; }
	const snr = 10 * Math.log10(ss / se);
	assert.ok(snr > 25, 'SNR ' + snr.toFixed(1));
	assert.strictEqual(Buffer.from(wav.subarray(12, 70)).toString('hex'), '666d74203200000002000200' + '44ac0000803e0000000404002000f403070000010000000200ff00000000c0004000f0000000cc0130ff880118ff');
	const dx = SDVX.make2dx('0001_test.2dx', wav);
	assert.strictEqual(Buffer.from(dx.subarray(16, 100)).toString('hex').slice(0, 16), '4c00000001000000');
	assert.strictEqual(Buffer.from(dx.subarray(76, 100)).toString('hex'), '32445839' + '18000000' + Buffer.from(new Uint32Array([wav.length]).buffer).toString('hex') + '3132ffff4000000000000000');
});
check('music_db is Shift-JIS and lists all six chart slots', () => {
	const xml = SDVX.musicDb({ id: 2811, ascii: 'test', slot: 'maximum', difnum: 19, version: 6, infVer: 0, volume: 91, title: '生命性シンドロウム～', artist: 'かめりあ', bpmMin: 225, bpmMax: 270, illustrator: '', effector: '', date: 20261026 });
	const bytes = SDVX.sjisEncode(xml);
	assert.strictEqual(new TextDecoder('shift_jis').decode(bytes), xml);
	for (const s of ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate']) assert.ok(xml.includes('<' + s + '>'));
	assert.ok(xml.includes('<bpm_max __type="u32">27000</bpm_max>'));
});
check('zip CRC-32 is standard', () => assert.strictEqual(SDVX.crc32(new TextEncoder().encode('123456789')), 0xcbf43926));

console.log(failures ? failures + ' of ' + (checks + failures) + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
