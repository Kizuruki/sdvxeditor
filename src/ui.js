/* ============================================================================
 * UI: menus, panels, transport, keyboard, files, main loop
 * ========================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'html') el.innerHTML = v;
		else if (k === 'value') el.value = v;
		else if (k === 'checked') el.checked = !!v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
	return el;
}
const SVG = (inner, vb = '0 0 24 24') => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const ICONS = {
	play: SVG('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
	pause: SVG('<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>'),
	stop: SVG('<rect x="6" y="6" width="12" height="12" fill="currentColor"/>'),
	start: SVG('<rect x="5" y="5" width="3" height="14" fill="currentColor"/><path d="M20 5L9 12l11 7z" fill="currentColor"/>'),
	metro: SVG('<path d="M9 3h6l4 18H5z M12 17l5-11" stroke="currentColor" stroke-width="2" fill="none"/>'),
	note: SVG('<path d="M9 18V5l11-2v13" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/>'),
};

let toastTimer = 0;
function toast(msg, err) {
	const el = $('#toast'); el.textContent = msg; el.className = 'toast' + (err ? ' err' : '');
	clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), err ? 4200 : 2400);
}
function showModal(title, body) {
	$('#modalTitle').textContent = title;
	const b = $('#modalBody'); b.innerHTML = ''; typeof body === 'string' ? (b.innerHTML = body) : b.append(body);
	$('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
let popoverClose = null;
function popover(cx, cy, title, fields, onOk) {
	const el = $('#popover');
	el.innerHTML = '';
	el.append(h('h5', null, title));
	const inputs = {}, rows = [], notes = [];
	for (const f of fields) {
		if (f.type === 'note') { const n = h('div', { class: 'note', style: 'max-width:300px;margin:0 0 6px' }); notes.push([n, f]); el.append(n); continue; }
		let inp;
		if (f.type === 'select') { inp = h('select', null, f.options.map(([v, l]) => h('option', { value: v }, l))); inp.value = f.value; }
		else inp = h('input', { type: f.type === 'number' ? 'text' : 'text', value: f.value, inputmode: f.type === 'number' ? 'decimal' : undefined });
		inputs[f.key] = inp;
		const row = h('div', { class: 'row' }, h('label', null, f.label), h('div', { class: 'ctl' }, inp));
		if (f.hint) row.title = f.hint;
		rows.push([row, f]); el.append(row);
		if (f.hint) el.append(h('div', { class: 'note', style: 'margin:-2px 0 4px 86px' }, f.hint));
	}
	const read = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
	const vis = () => { const v = read(); for (const [n, f] of notes) n.textContent = typeof f.value === 'function' ? f.value(v) : f.value; for (const [r, f] of rows) { const show = !f.show || f.show(v); r.style.display = show ? '' : 'none'; if (r.nextSibling && r.nextSibling.classList && r.nextSibling.classList.contains('note')) r.nextSibling.style.display = show ? '' : 'none'; } };
	el.addEventListener('input', vis); el.addEventListener('change', vis); vis();
	const close = () => { el.classList.add('hidden'); popoverClose = null; $('#timeline').focus(); };
	const ok = () => { const v = read(); close(); onOk(v); };
	el.append(h('div', { class: 'btns' }, h('button', { class: 'on', onclick: ok }, 'OK'), h('button', { onclick: close }, 'Cancel')));
	el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } e.stopPropagation(); };
	el.classList.remove('hidden');
	const r = el.getBoundingClientRect();
	el.style.left = Math.max(6, Math.min(window.innerWidth - r.width - 6, cx + 8)) + 'px';
	el.style.top = Math.max(6, Math.min(window.innerHeight - r.height - 6, cy - 10)) + 'px';
	popoverClose = close;
	const first = [...el.querySelectorAll('input,select')].find(i => i.offsetParent);
	if (first) { first.focus(); if (first.select) first.select(); }
}

// ---------------------------------------------------------------------------
const ed = new Editor();
const tl = new TimelineView($('#timeline'), ed); ed.tl = tl;
const pv = new Preview3D($('#preview'), ed);
ed.preview = pv;
let currentTab = 'props';

function fileNameNoExt() { return (ed.fileName || 'chart.ksh').replace(/\.ksh$/i, ''); }
function updateTitle() {
	const m = ed.chart.meta;
	$('#docTitle').textContent = (ed.dirty ? '● ' : '') + ed.fileName + (m.title ? '  —  ' + m.title + (m.artist ? ' / ' + m.artist : '') : '');
	document.title = (ed.dirty ? '● ' : '') + (m.title || fileNameNoExt()) + ' · KSM Chart Editor';
}

// ---------------------------------------------------------------- menus
function buildMenus() {
	const hasFS = 'showOpenFilePicker' in window;
	const S = ed.settings;
	const menus = [
		['File', [
			['New chart', 'Ctrl+N', newChart],
			['Open chart / audio…', 'Ctrl+O', openDialog],
			hasFS && ['Open chart folder…', '', openFolder],
			['Load audio…', '', () => pickFiles('audio/*,.ogg,.mp3,.wav,.flac,.m4a,.opus')],
			'-',
			['Save .ksh', 'Ctrl+S', () => save(false)],
			['Save .ksh as…', 'Ctrl+Shift+S', () => save(true)],
			['Export for KSM v1 (bake curves)…', '', exportV1],
			['Export for USC (unnamed sdvx clone)…', '', exportUsc],
			['Export for SOUND VOLTEX (.vox + .2dx)…', '', exportSdvxDialog],
			['View .ksh text…', '', viewKsh],
			'-',
			['Restore autosave', '', restoreAutosave],
		]],
		['Edit', [
			['Undo', 'Ctrl+Z', () => ed.undo()], ['Redo', 'Ctrl+Y', () => ed.redo()], '-',
			['Cut', 'Ctrl+X', () => ed.copy(true)], ['Copy', 'Ctrl+C', () => ed.copy()], ['Paste at cursor', 'Ctrl+V', () => ed.paste(false)], ['Paste mirrored', 'Ctrl+Shift+V', () => ed.paste(true)],
			['Delete', 'Del', () => ed.deleteSelection()], ['Select all notes', 'Ctrl+A', () => ed.selectAll()], ['Select everything', 'Ctrl+Shift+A', () => ed.selectAll(true)], '-',
			['Add slam kicks…', '', () => slamKickDialog(true)], ['Remove slam kicks…', '', () => slamKickDialog(false)], '-',
			['Mirror selection', 'Ctrl+M', () => ed.mirrorSelection()], ['Move selection up a step', 'Alt+↑', () => ed.nudgeSelection(1)], ['Move selection down a step', 'Alt+↓', () => ed.nudgeSelection(-1)],
		]],
		['View', [
			[() => (S.showPreview ? '✓ ' : '') + 'Preview', 'P', togglePreview],
			[() => (S.showWave ? '✓ ' : '') + 'Waveform', '', () => { S.showWave = !S.showWave; ed.saveSettings(); tl.layout(); ed.requestDraw(); }],
			'-',
			...ALL_COLS.map(k => [() => (S.cols[k] ? '✓ ' : '') + COL_INFO[k].label + ' column', '', () => { S.cols[k] = !S.cols[k]; ed.saveSettings(); tl.layout(); ed.requestDraw(); }]),
			'-',
			['Zoom in', '+ / Ctrl+wheel', () => zoomBy(1.25)], ['Zoom out', '-', () => zoomBy(0.8)],
		]],
		['Play', [
			['Play / pause', 'Space', () => ed.toggle()], ['Stop (back to start point)', 'Shift+Space', () => ed.stop()],
			['Go to start', 'Home', () => moveCursor(0)], ['Go to last note', 'End', () => moveCursor(ed.chartEndTick())], '-',
			...[1, 0.75, 0.5, 0.25].map(r => [() => (S.rate === r ? '✓ ' : '') + 'Speed ' + r * 100 + '%', '', () => setRate(r)]),
			'-',
			[() => (S.volMetro > 0 ? '✓ ' : '') + 'Metronome', 'M', toggleMetro],
			[() => (S.hitsounds ? '✓ ' : '') + 'Hitsounds', 'H', toggleHits],
		]],
		['Help', [
			['Controls & shortcuts', 'F1', showHelp],
			'-',
			['Lane spins & swings', '', () => showGuide('g-spins')],
			['Laser effects', '', () => showGuide('g-laser')],
			['FX hold effects', '', () => showGuide('g-fx')],
			['Wide lasers (2x)', '', () => showGuide('g-wide')],
			['Custom effects (#define_fx / #define_filter)', '', () => showGuide('g-custom')],
			'-',
			['About KSH export', '', showAbout],
		]],
	];
	const nav = $('#menus'); nav.innerHTML = '';
	for (const [name, items] of menus) {
		const list = h('div', { class: 'mlist' });
		const m = h('div', { class: 'menu' }, h('div', { class: 'mlabel' }, name), list);
		const fill = () => {
			list.innerHTML = '';
			for (const it of items) {
				if (!it) continue;
				if (it === '-') { list.append(h('div', { class: 'msep' })); continue; }
				const [label, key, fn] = it;
				list.append(h('div', { class: 'mitem', onmousedown: (e) => { e.preventDefault(); closeMenus(); fn(); } }, h('span', null, typeof label === 'function' ? label() : label), h('span', { class: 'k' }, key)));
			}
		};
		m.querySelector('.mlabel').addEventListener('mousedown', (e) => { e.preventDefault(); const open = m.classList.contains('open'); closeMenus(); if (!open) { fill(); m.classList.add('open'); } });
		m.addEventListener('mouseenter', () => { if (document.querySelector('.menu.open') && !m.classList.contains('open')) { closeMenus(); fill(); m.classList.add('open'); } });
		nav.append(m);
	}
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
document.addEventListener('mousedown', (e) => {
	if (!e.target.closest('.menu')) closeMenus();
	if (popoverClose && !e.target.closest('#popover') && e.target.id !== 'timeline') popoverClose();
});

// ---------------------------------------------------------------- toolbox + option bar
function buildToolbox() {
	const tb = $('#toolbox'); tb.innerHTML = '';
	for (const t of TOOLS) {
		tb.append(h('button', { class: 'tool' + (ed.tool === t.id ? ' on' : ''), title: t.label + '  [' + t.key + ']', onclick: () => setTool(t.id), html: SVG(t.icon) + `<span class="kk">${t.key}</span>` }));
	}
}
function setTool(id) {
	if (ed.drag) ed.cancelDrag();
	ed.tool = id; ed.ghost = null; buildToolbox(); buildOptbar(); ed.requestDraw();
}
function divSelect() {
	const s = h('select', { title: 'Grid snap (Ctrl+↑/↓)', onchange: (e) => { ed.div = +e.target.value; ed.requestDraw(); } }, DIVS.map(d => h('option', { value: d }, '1/' + d)));
	s.value = ed.div; return s;
}
function buildOptbar() {
	const ob = $('#optbar'); ob.innerHTML = '';
	ob.append(h('div', { class: 'grp' }, h('label', null, 'Snap'), divSelect()));
	ob.append(h('div', { class: 'sep' }));
	const tool = ed.tool;
	let hint = '';
	if (tool === 'select') hint = 'Drag empty space: box select · Drag items: move (Alt = no snap) · Right-click: delete · Ctrl+C / Ctrl+V pastes at the cursor';
	if (tool === 'bt') hint = 'Click: chip · Drag up/down: hold · Drag a hold\'s end to resize · Right-click: delete';
	if (tool === 'fx') {
		ob.append(h('div', { class: 'grp' }, h('label', null, 'New hold effect'), fxEditor(ed.fxEffect, (v) => { ed.fxEffect = v; })));
		hint = 'Left half = FX-L, right half = FX-R · Click: chip · Drag: hold';
	}
	if (tool === 'laserL' || tool === 'laserR') {
		const ls = h('select', { title: 'Laser position snap', onchange: (e) => { ed.laserSnap = +e.target.value; } }, LASER_SNAPS.map(o => h('option', { value: o.v }, o.label)));
		ls.value = ed.laserSnap;
		const cv = h('select', { title: 'Curve for new segments (KSM v2)', onchange: (e) => { ed.newCurve = e.target.value; } }, K.CURVE_PRESETS.map(p => h('option', { value: p.id }, p.label)));
		cv.value = ed.newCurve;
		const wide = h('button', { class: ed.newWide ? 'on' : '', title: 'New lasers are wide (laserrange 2x)', onclick: () => { ed.newWide = !ed.newWide; wide.classList.toggle('on', ed.newWide); } }, '2x wide');
		const kick = h('button', { class: ed.settings.autoKick ? 'on' : '', title: 'New slams also get a zoom_side "kick": the lane jumps in the slam\'s direction and eases back. The kick is made of normal Zoom Side keyframes you can move or delete.', onclick: () => { ed.settings.autoKick = !ed.settings.autoKick; ed.saveSettings(); kick.classList.toggle('on', ed.settings.autoKick); } }, 'Slam kick ±' + (ed.settings.kickAmount || 30));
		ob.append(h('div', { class: 'grp' }, h('label', null, 'Positions'), ls), h('div', { class: 'grp' }, h('label', null, 'Curve'), cv), wide, kick);
		hint = 'Drag: draw a laser · Drag from its end point: continue · Drag sideways: slam · Drag a point: move · Alt: no snap';
	}
	ob.append(h('div', { class: 'hint' }, hint));
}

// FX effect editor: preset + params, or custom name
function fxEditor(value, onChange, opts = {}) {
	const defs = ed.chart.defs.filter(d => d.startsWith('#define_fx ')).map(d => d.split(/\s+/)[1]);
	const parts = String(value || '').split(';');
	let name = parts[0];
	const preset = K.FX_EFFECTS.find(f => f.name === name);
	const mode = !value ? '' : preset ? name : defs.includes(name) ? 'def:' + name : 'custom';
	const wrap = h('span', { class: 'ctl', style: 'display:inline-flex;gap:4px;align-items:center' });
	const sel = h('select', null, h('option', { value: '' }, '(no effect)'), K.FX_EFFECTS.map(f => h('option', { value: f.name, title: FX_HELP[f.name] || '' }, f.name)), defs.map(d => h('option', { value: 'def:' + d }, d + ' (custom)')), h('option', { value: 'custom' }, 'Other…'));
	sel.value = mode;
	const tip = () => { sel.title = FX_HELP[sel.value] || 'Effect applied to the music while this FX hold is held'; };
	tip(); sel.addEventListener('change', tip);
	const params = h('span', { style: 'display:inline-flex;gap:3px' });
	const custom = h('input', { type: 'text', value: mode === 'custom' ? value : '', placeholder: 'e.g. Retrigger;16', style: 'width:110px' });
	const emit = () => {
		const m = sel.value;
		let s = '';
		if (m === 'custom') s = custom.value.trim();
		else if (m.startsWith('def:')) s = m.slice(4);
		else if (m) { const vals = [...params.querySelectorAll('input')].map(i => i.value.trim()); s = [m, ...vals].join(';').replace(/;+$/, ''); }
		onChange(s);
	};
	const render = () => {
		params.innerHTML = '';
		const p = K.FX_EFFECTS.find(f => f.name === sel.value);
		if (p) p.params.forEach((pp, i) => params.append(h('input', { type: 'text', title: pp.label, value: (sel.value === name && parts[i + 1] !== undefined) ? parts[i + 1] : pp.def, style: 'width:38px', oninput: emit })));
		custom.style.display = sel.value === 'custom' ? '' : 'none';
	};
	sel.addEventListener('change', () => { render(); emit(); });
	custom.addEventListener('input', emit);
	render();
	wrap.append(sel, params, custom);
	return wrap;
}

// ---------------------------------------------------------------- transport
const TR = {};
// what each FX hold effect does (tooltips); parameters follow KSM / USC
const FX_HELP = {
	Retrigger: 'Retrigger: repeats a short slice of the music over and over. Wave 1/n = slice length (8 = 1/8 note).',
	Gate: 'Gate: chops the music on and off. Wave 1/n = how often (8 = every 1/8 note).',
	Flanger: 'Flanger: sweeping "jet plane" whoosh.',
	PitchShift: 'PitchShift: raises the pitch by n semitones (12 = one octave up).',
	BitCrusher: 'BitCrusher: crunchy lo-fi sound. Bigger reduction = crunchier.',
	Phaser: 'Phaser: slow swirling sweep.',
	Wobble: 'Wobble: a low-pass filter that wobbles. Wave 1/n = speed (12 = every 1/12 note).',
	TapeStop: 'TapeStop: the music slows down to a stop like a tape deck. Higher speed = stops faster.',
	Echo: 'Echo: repeats what was playing every 1/n note, fading by the feedback %.',
	SideChain: 'SideChain: ducks the volume on every beat (pumping).',
};
const FILTER_LABEL = { peak: 'peaking filter (default)', lpf1: 'low-pass', hpf1: 'high-pass', bitc: 'bitcrusher' };
// ---- preview pane: speed control + resize
function syncSpeedUI() {
	const S = ed.settings, el = $('#pvSpeed'); if (!el) return;
	const hs = S.speedMode === 'hs';
	// mod mode is shown like SDVX EG's LANE-SPEED (BPM x hi-speed / 100)
	const get = () => hs ? S.hiSpeed : S.modSpeed / 100;
	const step = hs ? 0.25 : 0.25, lo = hs ? 0.5 : 1, hi = 20;
	const set = (v) => { v = Math.round(K.clamp(v, lo, hi) * 100) / 100; if (hs) S.hiSpeed = v; else S.modSpeed = Math.round(v * 100); ed.saveSettings(); inp.value = get().toFixed(2); ed.requestDraw(); if (currentTab === 'settings') renderTab(true); };
	const inp = h('input', { type: 'text', inputmode: 'decimal', value: get().toFixed(2), title: hs ? 'Hi-speed multiplier' : 'Lane speed = BPM × hi-speed ÷ 100, reached at the chart\'s main BPM (like SDVX EG)', onchange: (e) => set(parseFloat(e.target.value) || get()) });
	el.replaceChildren(
		h('span', { class: 'lbl', title: 'Click to switch between lane speed and a fixed hi-speed multiplier', onclick: () => { S.speedMode = hs ? 'mod' : 'hs'; ed.saveSettings(); syncSpeedUI(); ed.requestDraw(); if (currentTab === 'settings') renderTab(true); } }, hs ? 'HS' : 'SPEED'),
		h('button', { title: 'Slower', onclick: () => set(get() - step) }, '−'), inp, h('button', { title: 'Faster', onclick: () => set(get() + step) }, '+'));
}
(() => {
	const pane = $('#previewPane'), grip = $('#pvResize');
	pane.style.width = (ed.settings.previewW || 320) + 'px';
	grip.addEventListener('pointerdown', (e) => {
		e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('on');
		const x0 = e.clientX, w0 = pane.getBoundingClientRect().width;
		const move = (ev) => { const w = Math.round(K.clamp(w0 + ev.clientX - x0, 180, Math.min(900, window.innerWidth * 0.6))); pane.style.width = w + 'px'; ed.settings.previewW = w; tl.resize(); pv.resize(); ed.requestDraw(); };
		const up = () => { grip.classList.remove('on'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); ed.saveSettings(); };
		grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
	});
})();

function buildTransport() {
	const t = $('#transport'); t.innerHTML = '';
	TR.start = h('button', { class: 'ibtn', title: 'Go to start (Home)', html: ICONS.start, onclick: () => moveCursor(0) });
	TR.play = h('button', { class: 'ibtn play', title: 'Play / pause (Space)', html: ICONS.play, onclick: () => ed.toggle() });
	TR.stop = h('button', { class: 'ibtn', title: 'Stop and return (Shift+Space)', html: ICONS.stop, onclick: () => ed.stop() });
	TR.time = h('span', { class: 'time' }, '0:00.000');
	TR.pos = h('span', { class: 'pos' }, '1.1');
	TR.rate = h('select', { title: 'Playback speed', onchange: (e) => setRate(+e.target.value) }, [1, 0.75, 0.5, 0.25].map(r => h('option', { value: r }, r * 100 + '%')));
	TR.rate.value = ed.settings.rate;
	TR.metro = h('button', { class: 'ibtn' + (ed.settings.volMetro > 0 ? ' on' : ''), title: 'Metronome (M)', html: ICONS.metro, onclick: toggleMetro });
	TR.hits = h('button', { class: 'ibtn' + (ed.settings.hitsounds ? ' on' : ''), title: 'Hitsounds (H)', html: ICONS.note, onclick: toggleHits });
	TR.vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: ed.settings.volMusic, title: 'Music volume', style: 'width:80px', oninput: (e) => { ed.settings.volMusic = +e.target.value; ed.applyAudioSettings(); ed.saveSettings(); } });
	TR.audio = h('button', { title: 'Load the song audio (ogg / mp3 / wav)', onclick: () => pickFiles('audio/*,.ogg,.mp3,.wav,.flac,.m4a,.opus') }, 'Load audio…');
	TR.zoom = h('span', { class: 'muted' });
	t.append(TR.start, TR.play, TR.stop, h('div', { class: 'sep' }), TR.time, TR.pos, h('div', { class: 'sep' }), h('label', null, 'Speed'), TR.rate, TR.metro, TR.hits, h('label', null, 'Music'), TR.vol,
		h('div', { class: 'spacer' }), TR.zoom, h('button', { title: 'Zoom out (-)', onclick: () => zoomBy(0.8) }, '−'), h('button', { title: 'Zoom in (+)', onclick: () => zoomBy(1.25) }, '+'), h('div', { class: 'sep' }), TR.audio);
}
let lastTr = '';
function updateTransport() {
	const ph = ed.playing ? ed.playTick : ed.cursor;
	const key = Math.round(ph) + '|' + ed.playing + '|' + ed.version;
	if (key === lastTr) return; lastTr = key;
	TR.time.textContent = fmtTimeMs(ed.songTimeOf(ph));
	TR.pos.textContent = posLabel(ed.timing, Math.max(0, Math.round(ph)), ed.div) + '  ♩' + K.fmtNum(ed.timing.bpmAt(ph));
	TR.play.innerHTML = ed.playing ? ICONS.pause : ICONS.play;
	TR.audio.textContent = ed.audio.buffer ? '♪ ' + ed.audio.fileName : 'Load audio…';
	TR.audio.title = ed.audio.buffer ? 'Loaded ' + ed.audio.fileName + ' (' + fmtTime(ed.audio.duration) + '). Click to load a different file.' : 'Load the song audio (ogg / mp3 / wav)';
	TR.zoom.textContent = 'Zoom ' + Math.round(tl.zoom * 100) + '%';
}
function setRate(r) { ed.settings.rate = r; ed.saveSettings(); TR.rate.value = r; if (ed.playing) { ed.pause(); ed.play(); } }
function toggleMetro() { ed.settings.volMetro = ed.settings.volMetro > 0 ? 0 : 0.6; ed.applyAudioSettings(); ed.saveSettings(); TR.metro.classList.toggle('on', ed.settings.volMetro > 0); ed.nextBeat = null; }
function toggleHits() { ed.settings.hitsounds = !ed.settings.hitsounds; ed.applyAudioSettings(); ed.saveSettings(); TR.hits.classList.toggle('on', ed.settings.hitsounds); ed.hitsDirty = true; }
function togglePreview() { ed.settings.showPreview = !ed.settings.showPreview; ed.saveSettings(); $('#previewPane').classList.toggle('hidden', !ed.settings.showPreview); requestAnimationFrame(() => { tl.resize(); pv.resize(); ed.requestDraw(); }); }
function zoomBy(f, anchorY) {
	const y = anchorY !== undefined ? anchorY : tl.h * 0.5;
	const t = tl.tickAt(y);
	tl.zoom = K.clamp(tl.zoom * f, 0.15, 12);
	tl.bottomTick = t - (tl.h - y) / tl.ppt;
	ed.requestDraw();
}
function moveCursor(t) {
	t = Math.max(0, Math.round(t));
	if (ed.playing) { ed.seekTo(t); return; }
	ed.cursor = t;
	const y = tl.yOf(t);
	if (y < tl.HEAD + 30 || y > tl.h - 30) tl.bottomTick = t - (tl.h * 0.25) / tl.ppt;
	ed.requestDraw();
}

// ---------------------------------------------------------------- side tabs
const TABS = [['props', 'Properties'], ['chart', 'Chart'], ['events', 'Events'], ['check', 'Check'], ['settings', 'Settings']];
function buildTabs() {
	const t = $('#tabs'); t.innerHTML = '';
	const issues = K.validateChart(ed.chart).filter(w => w.level !== 'info').length;
	for (const [id, label] of TABS) {
		const b = h('button', { class: currentTab === id ? 'on' : '', onclick: () => { currentTab = id; buildTabs(); renderTab(); } }, label);
		if (id === 'check' && issues) b.append(h('span', { class: 'badge' }, issues));
		t.append(b);
	}
}
let tabStale = false;
function renderTab(force) {
	const body = $('#tabBody');
	if (!force && body.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { tabStale = true; return; }
	tabStale = false;
	const scroll = body.scrollTop;
	body.innerHTML = '';
	if (autosaveBanner) body.append(autosaveBanner);
	({ props: renderProps, chart: renderChartTab, events: renderEvents, check: renderCheck, settings: renderSettings })[currentTab](body);
	body.scrollTop = scroll;
}
$('#tabBody').addEventListener('focusout', () => setTimeout(() => { if (tabStale && !$('#tabBody').contains(document.activeElement)) renderTab(); }, 0));

const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', null, title), ...kids);
const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', { title: label }, label), h('div', { class: 'ctl' }, ...ctl));
function numInput(value, onCommit, attrs = {}) {
	return h('input', { type: 'text', inputmode: 'decimal', value, style: 'width:80px', ...attrs, onchange: (e) => onCommit(e.target.value) });
}
function laneName(kind, lane) { return kind === 'bt' ? 'BT-' + 'ABCD'[lane] : kind === 'fx' ? 'FX-' + 'LR'[lane] : lane ? 'Laser R' : 'Laser L'; }

function renderProps(body) {
	const items = ed.selected();
	if (!items.length) {
		const c = ed.chart;
		const count = (lanes, f) => lanes.reduce((a, l) => a + l.filter(f).length, 0);
		body.append(sec('Nothing selected',
			h('div', { class: 'note' }, 'Click a note, laser point or keyframe to edit it here. Use the Select tool (1) to box-select.'),
			row('BT chips / holds', h('span', null, count(c.bt, n => !n.l) + ' / ' + count(c.bt, n => n.l))),
			row('FX chips / holds', h('span', null, count(c.fx, n => !n.l) + ' / ' + count(c.fx, n => n.l))),
			row('Lasers L / R', h('span', null, c.laser[0].length + ' / ' + c.laser[1].length)),
			row('Slams', h('span', null, c.laser.reduce((a, l) => a + l.reduce((b, s) => b + s.pts.filter(p => p.v !== p.vf).length, 0), 0))),
			row('Camera keys', h('span', null, K.CAM_KEYS.reduce((a, k) => a + c.cam[k].length, 0) + c.tilt.length)),
		));
		body.append(sec('Quick start', h('div', { class: 'note', html:
			'1. Load the song (bottom right) and set BPM by double-clicking the ♩ marker in the BPM column.<br>' +
			'2. Line up the waveform with the beat lines using <b>Offset</b> in the Chart tab.<br>' +
			'3. Place notes with tools 2–5. Add camera effects by clicking in the graph columns on the right.<br>' +
			'4. Space plays from the red cursor. Ctrl+S saves the .ksh.' })));
		return;
	}
	if (items.length > 1) {
		const kinds = {};
		for (const e of items) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
		const fxHolds = items.filter(e => e.kind === 'fx' && e.item.l > 0);
		body.append(sec(items.length + ' selected',
			h('div', { class: 'note' }, Object.entries(kinds).map(([k, n]) => n + ' ' + ({ bt: 'BT', fx: 'FX', lpt: 'laser point', cam: 'keyframe', bpm: 'BPM', stop: 'stop', spin: 'spin', sig: 'beat', ev: 'event' }[k] || k) + (n > 1 ? 's' : '')).join(', ')),
			fxHolds.length ? row('FX hold effect', fxEditor(fxHolds[0].item.fx || '', (v) => ed.edit('Set FX effect', c => { for (const e of fxHolds) { const arr = c.fx[e.lane]; const n = arr.find(o => o.id === e.item.id); if (n) ed.replaceIn(arr, n.id, v ? { ...n, fx: v } : (({ fx, ...r }) => r)(n)); } }))) : null,
			h('div', { class: 'btns' }, h('button', { onclick: () => ed.mirrorSelection() }, 'Mirror (Ctrl+M)'), h('button', { onclick: () => ed.copy() }, 'Copy'), h('button', { onclick: () => ed.deleteSelection() }, 'Delete'))));
		return;
	}
	const e = items[0];
	const pos = (t) => posLabel(ed.timing, t, ed.div) + '  (' + fmtTimeMs(ed.songTimeOf(t)) + ')';
	if (e.kind === 'bt' || e.kind === 'fx') {
		const n = e.item;
		const setLen = (l) => ed.edit('Change length', c => { const arr = (e.kind === 'bt' ? c.bt : c.fx)[e.lane]; const o = arr.find(x => x.id === n.id); if (!o) return; const nn = { ...o, l: Math.max(0, l) }; if (nn.l === 0) delete nn.fx; ed.replaceIn(arr, o.id, nn); });
		const s = sec((n.l ? 'Hold' : 'Chip') + ' · ' + laneName(e.kind, e.lane),
			row('Position', h('span', null, pos(n.t))),
			row('Length', numInput(n.l ? fmtLen(n.l) : '0', (v) => { const l = parseLen(v); if (l >= 0) setLen(l); }, { title: 'Measures, e.g. 1/4, 3/8, 1' }), h('span', { class: 'muted' }, 'measures')),
		);
		if (e.kind === 'fx' && n.l > 0) s.append(row('Effect', fxEditor(n.fx || '', (v) => ed.edit('Set FX effect', c => { const arr = c.fx[e.lane]; const o = arr.find(x => x.id === n.id); if (o) { const nn = { ...o }; if (v) nn.fx = v; else delete nn.fx; ed.replaceIn(arr, o.id, nn); } }))));
		if (e.kind === 'fx' && !n.l) {
			const [snd, vol] = (n.se || '').split(';');
			const sel = h('select', null, h('option', { value: '' }, '(none)'), K.FX_CHIP_SOUNDS.map(s2 => h('option', { value: s2 }, s2)));
			sel.value = K.FX_CHIP_SOUNDS.includes(snd) ? snd : '';
			const volI = numInput(vol || '100', () => apply(), { style: 'width:50px' });
			const apply = () => ed.edit('FX chip sound', c => { const arr = c.fx[e.lane]; const o = arr.find(x => x.id === n.id); if (!o) return; const nn = { ...o }; if (sel.value) nn.se = sel.value + (volI.value && volI.value !== '100' ? ';' + volI.value : ''); else delete nn.se; ed.replaceIn(arr, o.id, nn); });
			sel.addEventListener('change', apply);
			s.append(row('Key sound', sel, volI, h('span', { class: 'muted' }, '%')));
		}
		s.append(h('div', { class: 'btns' }, n.l ? h('button', { onclick: () => setLen(0) }, 'Make chip') : h('button', { onclick: () => setLen(ed.step) }, 'Make hold'), h('button', { onclick: () => ed.deleteSelection() }, 'Delete')));
		body.append(s);
		return;
	}
	if (e.kind === 'lpt') {
		const s = e.sec, p = e.item, t = s.t + p.ry, lane = e.lane;
		const isSlam = p.v !== p.vf, isLast = e.idx === s.pts.length - 1;
		const upd = (label, fn) => ed.edit(label, c => { const arr = c.laser[lane]; const so = arr.find(x => x.id === s.id); if (!so) return; const pts = so.pts.slice(); const i = pts.findIndex(x => x.id === p.id); if (i < 0) return; const r = fn({ ...pts[i] }, so); if (r === false) return; pts[i] = r; ed.replaceIn(arr, so.id, { ...so, pts }); });
		const vIn = numInput(p.v, (v) => upd('Laser position', q => { const x = K.clamp(parseInt(v, 10) || 0, 0, 50); if (q.v === q.vf) q.vf = x; q.v = x; return q; }), { style: 'width:50px' });
		const slamChk = h('input', { type: 'checkbox', checked: isSlam, onchange: (ev) => upd(ev.target.checked ? 'Make slam' : 'Remove slam', q => { q.vf = ev.target.checked ? (q.v <= 25 ? 50 : 0) : q.v; return q; }) });
		const vfIn = numInput(p.vf, (v) => upd('Slam end', q => { q.vf = K.clamp(parseInt(v, 10) || 0, 0, 50); return q; }), { style: 'width:50px', disabled: !isSlam });
		const box = sec(laneName('laser', lane) + ' point ' + (e.idx + 1) + '/' + s.pts.length,
			row('Position', h('span', null, pos(t))),
			row('Value (0–50)', vIn, h('span', { class: 'muted' }, '0 = left, 50 = right')),
			row('Slam', slamChk, h('span', { class: 'muted' }, 'to'), vfIn));
		if (!isLast) {
			const cur = K.CURVE_PRESETS.find(cp => Math.abs(cp.a - (p.a || 0)) < 1e-6 && Math.abs(cp.b - (p.b || 0)) < 1e-6);
			const cs = h('select', { onchange: (ev) => { const cp = K.CURVE_PRESETS.find(x => x.id === ev.target.value); if (cp) upd('Laser curve', q => { q.a = cp.a; q.b = cp.b; return q; }); } }, K.CURVE_PRESETS.map(cp => h('option', { value: cp.id }, cp.label)), h('option', { value: 'custom' }, 'Custom (a;b)'));
			cs.value = cur ? cur.id : 'custom';
			const ab = numInput((p.a || 0) + ';' + (p.b || 0), (v) => { const [a, b] = v.split(';').map(Number); if (Number.isFinite(a) && Number.isFinite(b)) upd('Laser curve', q => { q.a = K.clamp(a, 0, 1); q.b = K.clamp(b, 0, 1); return q; }); }, { style: 'width:70px', title: 'Quadratic bezier control point a;b (0–1). KSM v2 only.' });
			box.append(row('Curve to next', cs, ab));
		}
		if (isSlam) {
			const seCur = ed.chart.slamSE.find(x => x.t === t);
			const seSel = h('select', { onchange: (ev) => ed.edit('Slam sound', c => { c.slamSE = c.slamSE.filter(x => x.t !== t); if (ev.target.value) K.insertSorted(c.slamSE, { id: K.nid(), t, v: ev.target.value }); }) }, h('option', { value: '' }, '(default)'), K.SLAM_SOUNDS.map(x => h('option', { value: x }, x)));
			seSel.value = seCur ? seCur.v : '';
			box.append(row('Slam sound', seSel));
			const zk = ed.chart.cam.zoom_side.find(x => x.t === t && typeof x.vf === 'number' && x.vf !== x.v);
			box.append(row('Zoom side kick', zk
				? h('span', null, h('span', { class: 'muted' }, (zk.vf - zk.v > 0 ? '+' : '') + K.fmtNum(zk.vf - zk.v) + ' '), h('button', { onclick: () => ed.edit('Remove slam kick', c => ed.removeSlamKicks(c, [{ t }])) }, 'Remove'))
				: h('button', { onclick: () => { const n = ed.edit('Add slam kick', c => ed.addSlamKicks(c, ed.slamList(c, new Set([p.id])))); if (!n) toast('This slam already has Zoom Side keyframes nearby'); } }, 'Add kick ±' + (ed.settings.kickAmount || 30))));
		}
		body.append(box);
		// spin / swing editor on this tick
		const sp = ed.chart.spins.find(x => x.t === t);
		const spSel = h('select', null, SPIN_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
		spSel.value = spinCode(sp);
		const lenIn = numInput(sp ? fmtLen(sp.l) : '1', () => applySpin(), { style: 'width:56px', title: 'Length in measures (1 = one 4/4 measure)' });
		const amp = numInput(sp ? sp.amp : 250, () => applySpin(), { style: 'width:46px', title: 'Swing scale (default 250)' });
		const rep = numInput(sp ? sp.rep : 3, () => applySpin(), { style: 'width:36px', title: 'Swing repeats (default 3)' });
		const dec = h('select', { title: 'Swing decay', onchange: () => applySpin() }, [['0', 'no decay'], ['1', 'linear'], ['2', 'squared']].map(([v, l]) => h('option', { value: v }, l)));
		dec.value = sp ? String(sp.dec) : '2';
		const applySpin = () => { const l = parseLen(lenIn.value); ed.setSpinAt(t, spSel.value, l > 0 ? l : 960, { amp: parseInt(amp.value, 10) || 250, rep: parseInt(rep.value, 10) || 3, dec: +dec.value }); };
		spSel.addEventListener('change', () => { if (spSel.value && !sp && isSlam) { /* suggest direction from slam */ } applySpin(); });
		const spinSec = sec('Lane spin / swing (screen shake)',
			h('div', { class: 'note' }, isSlam ? 'Triggered by this slam in KSM.' : 'Spins are normally placed on a slam.'),
			row('Effect', spSel), row('Length', lenIn, h('span', { class: 'muted' }, 'measures')));
		if (sp && sp.kind === 'swing') spinSec.append(row('Swing', amp, rep, dec));
		body.append(spinSec);
		const wide = h('input', { type: 'checkbox', checked: !!s.wide, onchange: (ev) => ed.edit('Wide laser', c => { const arr = c.laser[lane]; const so = arr.find(x => x.id === s.id); if (so) ed.replaceIn(arr, so.id, { ...so, wide: ev.target.checked }); }) });
		const tiltSel = h('select', { title: 'What the game\'s automatic laser tilt does while this laser plays', onchange: (ev) => ed.setLaserTiltMode(s, ev.target.value) },
			h('option', { value: 'inherit' }, 'Automatic (no change)'), h('option', { value: 'zero' }, 'Off for this laser (tilt=zero)'),
			['normal', 'bigger', 'biggest', 'keep_normal', 'keep_bigger', 'keep_biggest'].map(m => h('option', { value: m }, m)));
		tiltSel.value = ed.laserTiltMode(s);
		const defs = KSMFX.parseDefines(ed.chart.defs);
		const filters = ['peak', 'lpf1', 'hpf1', 'bitc', ...Object.keys(defs).filter(k => k.startsWith('filter:')).map(k => k.slice(7))];
		const curF = ed.stepAt(ed.chart.filterType, s.t, ed.chart.meta.filtertype || 'peak');
		const atF = ed.chart.filterType.find(x => x.t === s.t);
		const fSel = h('select', { onchange: (ev) => ed.setStepAt('filterType', s.t, ev.target.value === '-' ? null : ev.target.value, 'Laser effect') },
			h('option', { value: '-' }, 'Keep current (' + curF + ')'), filters.map(f => h('option', { value: f }, FILTER_LABEL[f] ? f + ' — ' + FILTER_LABEL[f] : f)));
		fSel.value = atF ? atF.v : '-';
		const curG = ed.stepAt(ed.chart.pfilterGain, s.t, ed.chart.meta.pfiltergain || '50');
		const atG = ed.chart.pfilterGain.find(x => x.t === s.t);
		const gIn = numInput(atG ? atG.v : '', (v) => ed.setStepAt('pfilterGain', s.t, v === '' ? null : K.clamp(parseInt(v, 10) || 0, 0, 100), 'Laser effect strength'), { style: 'width:50px', placeholder: String(curG), title: 'pfiltergain 0–100 from this laser on (empty = keep ' + curG + ')' });
		body.append(sec('Whole laser',
			row('Starts', h('span', null, pos(s.t))),
			row('Wide (2x)', wide, h('span', { class: 'muted' }, 'laserrange_' + (lane ? 'r' : 'l') + '=2x')),
			row('Engine tilt', tiltSel),
			row('Laser effect', fSel),
			row('Effect strength', gIn, h('span', { class: 'muted' }, '% (pfiltergain)')),
			h('div', { class: 'note' }, 'Engine tilt: the game tilts the lane toward the lasers on its own (±10°, shown as the dashed line in the Tilt column). "Off" writes tilt=zero at the start of this laser and restores the previous mode at its end. Laser effect / strength are written as filtertype / pfiltergain at the start of this laser and stay until changed. Strength only matters in USC / KSM (SOUND VOLTEX has no laser strength).'),
			h('div', { class: 'btns' },
				h('button', { onclick: () => ed.setSel(s.pts.map(q => q.id)) }, 'Select all points'),
				h('button', { onclick: () => ed.edit('Delete point', () => ed.deleteLaserPoints(new Set([p.id]))) }, 'Delete point'),
				h('button', { onclick: () => ed.edit('Delete laser', c => { c.laser[lane] = c.laser[lane].filter(x => x.id !== s.id); }) }, 'Delete laser'))));
		return;
	}
	if (e.kind === 'cam') {
		const p = e.item, key = e.key, isTilt = key === 'tilt';
		const upd = (label, fn) => ed.edit(label, () => { const arr = ed.camArr(key).slice(); const o = arr.find(x => x.id === p.id); if (!o) return; const np = fn({ ...o }); ed.replaceIn(arr, o.id, np); ed.setCamArr(key, arr); });
		const box = sec(COL_INFO[key].label + ' keyframe', h('div', { class: 'note' }, EVENT_HELP[key].short), row('Position', h('span', null, pos(p.t))));
		if (isTilt) {
			const mode = h('select', { onchange: (ev) => upd('Tilt type', q => { q.v = ev.target.value === 'manual' ? 0 : ev.target.value; if (typeof q.v !== 'number') { delete q.vf; q.a = 0; q.b = 0; } return q; }) }, h('option', { value: 'manual' }, 'Manual value'), K.TILT_AUTO.map(a => h('option', { value: a }, 'Auto: ' + a)));
			mode.value = typeof p.v === 'number' ? 'manual' : p.v;
			box.append(row('Type', mode));
			if (typeof p.v !== 'number') box.append(h('div', { class: 'note' }, 'Auto tilt follows the lasers. "keep_" types keep the tilt until it gets bigger; "zero" disables tilt.'));
		}
		if (typeof p.v === 'number') {
			box.append(row('Value', numInput(K.fmtNum(p.v), (v) => upd('Keyframe value', q => { q.v = parseFloat(v) || 0; return q; })), h('span', { class: 'muted' }, isTilt ? '1 = normal max tilt' : key === 'rotation_deg' ? 'degrees' : key === 'scroll_speed' ? '× speed' : key === 'zoom_top' ? '2400 = 360°' : '')));
			const jump = h('input', { type: 'checkbox', checked: p.vf !== undefined, onchange: (ev) => upd('Instant change', q => { if (ev.target.checked) q.vf = typeof q.v === 'number' ? q.v : 0; else delete q.vf; return q; }) });
			const vf = numInput(p.vf !== undefined ? (typeof p.vf === 'number' ? K.fmtNum(p.vf) : p.vf) : '', (v) => upd('Instant change', q => { const x = parseFloat(v); q.vf = isTilt && isNaN(x) ? v : (x || 0); return q; }), { disabled: p.vf === undefined });
			box.append(row('Jump to', jump, vf), h('div', { class: 'note' }, 'Jump = the value changes instantly at this keyframe (two lines in KSH).'));
			const cur = K.CURVE_PRESETS.find(cp => Math.abs(cp.a - (p.a || 0)) < 1e-6 && Math.abs(cp.b - (p.b || 0)) < 1e-6);
			const cs = h('select', { onchange: (ev) => { const cp = K.CURVE_PRESETS.find(x => x.id === ev.target.value); if (cp) upd('Curve', q => { q.a = cp.a; q.b = cp.b; return q; }); } }, K.CURVE_PRESETS.map(cp => h('option', { value: cp.id }, cp.label)), h('option', { value: 'custom' }, 'Custom'));
			cs.value = cur ? cur.id : 'custom';
			box.append(row('Ease to next', cs), h('div', { class: 'note' }, 'Curves need KSM v2. "Export for KSM v1" converts them to steps.'));
		}
		box.append(h('div', { class: 'btns' }, h('button', { onclick: () => ed.deleteSelection() }, 'Delete keyframe')));
		body.append(box);
		return;
	}
	if (e.kind === 'ev') {
		const it = e.item, key = e.key, Hh = EVENT_HELP[key];
		const box = sec(Hh.title + (Hh.ksh ? ' · ' + Hh.ksh : ''), row('Position', h('span', null, pos(it.t))));
		if (key === 'filterType') {
			const sl = h('select', { onchange: (ev) => ed.setEvent(key, it.id, { v: ev.target.value }, 'Laser effect') }, [...new Set([it.v, 'peak', 'lpf1', 'hpf1', 'bitc'])].map(v => h('option', { value: v }, FILTER_LABEL[v] ? v + ' — ' + FILTER_LABEL[v] : v)));
			sl.value = it.v; box.append(row('Effect', sl));
		} else if (key === 'pfilterGain' || key === 'slamVol') box.append(row('Value', numInput(it.v, (v) => ed.setEvent(key, it.id, { v: String(K.clamp(parseInt(v, 10) || 0, 0, 100)) }), { style: 'width:60px' }), h('span', { class: 'muted' }, '0–100')));
		else if (key === 'slamSE') { const sl = h('select', { onchange: (ev) => ed.setEvent(key, it.id, { v: ev.target.value }, 'Slam sound') }, K.SLAM_SOUNDS.map(v => h('option', { value: v }, v))); sl.value = it.v; box.append(row('Sound', sl)); }
		else if (key === 'raw') { box.append(row('Key', numInput(it.k, (v) => ed.setEvent(key, it.id, { k: v }, 'Edit line'), { style: 'width:120px' })), row('Value', numInput(it.v, (v) => ed.setEvent(key, it.id, { v }, 'Edit line'), { style: 'width:160px' }))); }
		box.append(h('div', { class: 'note' }, Hh.short), h('div', { class: 'btns' }, h('button', { onclick: () => ed.copy() }, 'Copy'), h('button', { onclick: () => ed.deleteSelection() }, 'Delete')));
		body.append(box); return;
	}
	const helpNote = (k) => h('div', { class: 'note' }, EVENT_HELP[k].short);
	if (e.kind === 'bpm') { body.append(sec('BPM change', helpNote('bpm'), row('Position', h('span', null, pos(e.item.t))), row('BPM', numInput(K.fmtNum(e.item.v), (v) => { const b = parseFloat(v); if (b > 0) ed.setBpmAt(e.item.t, b); })))); return; }
	if (e.kind === 'stop') { body.append(sec('Stop', helpNote('stops'), row('Position', h('span', null, pos(e.item.t))), row('Length', numInput(fmtLen(e.item.l), (v) => { const l = parseLen(v); if (l > 0) ed.edit('Edit stop', c => ed.replaceIn(c.stops, e.item.id, { ...e.item, l })); }), h('span', { class: 'muted' }, 'measures')))); return; }
	if (e.kind === 'sig') { body.append(sec('Time signature', helpNote('sig'), row('Measure', h('span', null, e.item.m + 1)), row('Beats', numInput(e.item.n + '/' + e.item.d, (v) => { const [n, d] = v.split('/').map(x => parseInt(x, 10)); if (n > 0 && [1, 2, 4, 8, 16, 32, 64].includes(d)) ed.setSigAt(e.item.m, n, d); })))); return; }
	if (e.kind === 'spin') { const s = e.item; body.append(sec('Spin / swing', helpNote('spins'), row('Position', h('span', null, pos(s.t))), row('Effect', (() => { const sl = h('select', { onchange: (ev) => ed.setSpinAt(s.t, ev.target.value, s.l) }, SPIN_OPTIONS.map(([v, l]) => h('option', { value: v }, l))); sl.value = spinCode(s); return sl; })()), row('Length', numInput(fmtLen(s.l), (v) => { const l = parseLen(v); if (l > 0) ed.setSpinAt(s.t, spinCode(s), l); }), h('span', { class: 'muted' }, 'measures')), h('div', { class: 'note' }, 'Double-click the purple label on the lane to edit it there.'))); }
}

function renderChartTab(body) {
	const m = ed.chart.meta;
	const set = (k, v) => { if (m[k] === v) return; ed.edit('Edit ' + k, c => { c.meta[k] = v; }); updateTitle(); };
	const txt = (k, ph, w) => h('input', { type: 'text', value: m[k], placeholder: ph || '', style: w ? 'width:' + w : null, onchange: (e) => set(k, e.target.value) });
	const pick = (k, opts, allowCustom) => {
		const s = h('select', { onchange: (e) => { if (e.target.value === '__custom') { const v = prompt('Value for ' + k + ':', m[k]); if (v !== null) set(k, v); else renderTab(true); } else set(k, e.target.value); } }, opts.map(o => h('option', { value: o }, o || '(none)')), allowCustom ? h('option', { value: '__custom' }, 'Custom file…') : null);
		if (!opts.includes(m[k])) s.prepend(h('option', { value: m[k] }, m[k]));
		s.value = m[k]; return s;
	};
	const off = h('input', { type: 'text', inputmode: 'numeric', value: m.o, style: 'width:70px', onchange: (e) => set('o', String(parseInt(e.target.value, 10) || 0)) });
	const nudge = (d) => h('button', { title: (d > 0 ? '+' : '') + d + ' ms', onclick: () => set('o', String((parseInt(m.o, 10) || 0) + d)) }, (d > 0 ? '+' : '') + d);
	body.append(sec('Song',
		row('Title', txt('title')), row('Title (romaji)', txt('title_translit', 'optional')),
		row('Artist', txt('artist')), row('Artist (romaji)', txt('artist_translit', 'optional')),
		row('Music file (m)', txt('m', 'song.ogg'), h('button', { onclick: () => pickFiles('audio/*,.ogg,.mp3,.wav,.flac,.m4a,.opus') }, 'Load')),
		row('Music volume', txt('mvol', '100', '60px'), h('span', { class: 'muted' }, '%')),
		row('Offset (o)', off, h('span', { class: 'muted' }, 'ms')),
		h('div', { class: 'btns', style: 'margin:0 0 4px 114px' }, nudge(-10), nudge(-1), nudge(1), nudge(10)),
		h('div', { class: 'note' }, 'Offset = where beat 1 of measure 1 is in the audio. Raise it if notes are early. Watch the waveform line up with the measure lines.'),
	));
	body.append(sec('Chart',
		row('Difficulty', pick('difficulty', K.DIFFICULTIES)),
		row('Level', h('input', { type: 'number', min: 1, max: 20, value: m.level, onchange: (e) => set('level', String(K.clamp(parseInt(e.target.value, 10) || 1, 1, 20))) })),
		row('Chart author', txt('effect')),
		row('Jacket file', txt('jacket', 'jacket.png')), row('Illustrator', txt('illustrator')),
		row('Display BPM', txt('t', K.autoDispBpm(ed.chart) + ' (auto)')),
		row('Hi-speed base BPM', txt('to', 'auto')),
		row('Info text', txt('information', 'shown in song select')),
	));
	body.append(sec('Song select preview',
		row('Start (po)', txt('po', '0', '80px'), h('span', { class: 'muted' }, 'ms'), h('button', { title: 'Use the cursor position', onclick: () => set('po', String(Math.max(0, Math.round(ed.songTimeOf(ed.cursor) * 1000)))) }, '← cursor')),
		row('Length (plength)', txt('plength', '15000', '80px'), h('span', { class: 'muted' }, 'ms'))));
	body.append(sec('Background',
		row('Background', pick('bg', K.BG_PRESETS, true)), row('Layer', pick('layer', ['', ...K.LAYER_PRESETS], true)),
		row('Video (v)', txt('v', 'optional')), row('Video offset', txt('vo', '0', '70px'))));
	const auto = h('input', { type: 'checkbox', checked: m.chokkakuautovol === '1', onchange: (e) => set('chokkakuautovol', e.target.checked ? '1' : '0') });
	body.append(sec('Laser sound',
		row('Laser filter', pick('filtertype', K.LASER_FILTERS)), row('Filter gain', txt('pfiltergain', '50', '60px'), h('span', { class: 'muted' }, '0–100, KSM default 50')),
		h('div', { class: 'note' }, 'Lasers change the music while they are held: the further a laser moves from the side it starts on (left laser toward the right, right laser toward the left), the stronger the effect. A laser resting on its starting edge does nothing. Filter gain (pfiltergain) sets how strong the effect is in USC / KSM; 0 silences it, and 50 is KSM\'s default and the usual value. SOUND VOLTEX has no such setting (its laser filter is always on), so with Settings → "Effects sound like: SOUND VOLTEX" the gain does not change what you hear.'),
		row('Filter delay', txt('pfilterdelay', '40', '60px'), h('span', { class: 'muted' }, 'ms')),
		row('Slam volume', txt('chokkakuvol', '50', '60px'), h('span', { class: 'muted' }, '%')), row('Auto slam volume', auto),
		row('Gauge total', txt('total', 'auto', '70px'))));
	const defs = h('textarea', { rows: 4, placeholder: '#define_fx Name type=Retrigger;waveLength=1/16', onchange: (e) => ed.edit('Custom effects', c => { c.defs = e.target.value.split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith('#define_')); }) });
	defs.value = ed.chart.defs.join('\n');
	const extra = h('textarea', { rows: 3, placeholder: 'key=value', onchange: (e) => ed.edit('Extra header', c => { c.metaExtra = e.target.value.split(/\r?\n/).filter(s => s.includes('=')).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]); }) });
	extra.value = ed.chart.metaExtra.map(([k, v]) => k + '=' + v).join('\n');
	body.append(sec('Advanced',
		row('KSH version', txt('ver', '171', '60px'), txt('ver_compat', 'compat', '60px')),
		h('div', { class: 'note' }, 'Custom audio effects (#define_fx / #define_filter):'), defs,
		h('div', { class: 'note' }, 'Other header lines kept as-is:'), extra));
}

function renderEvents(body) {
	const c = ed.chart, list = [];
	for (const b of c.bpm) list.push([b.t, 'BPM ' + K.fmtNum(b.v), () => { c.bpm.length > 1 && b.t !== 0 && ed.edit('Delete BPM', cc => { cc.bpm = cc.bpm.filter(x => x.id !== b.id); }); }, b.t === 0]);
	for (const s of c.sig) list.push([ed.timing.measureStart(s.m), 'Time signature ' + s.n + '/' + s.d + ' (measure ' + (s.m + 1) + ')', () => s.m && ed.edit('Delete time signature', cc => { cc.sig = cc.sig.filter(x => x.id !== s.id); }), s.m === 0]);
	for (const s of c.stops) list.push([s.t, 'Stop ' + fmtLen(s.l), () => ed.edit('Delete stop', cc => { cc.stops = cc.stops.filter(x => x.id !== s.id); })]);
	for (const s of c.spins) list.push([s.t, SPIN_OPTIONS.find(o => o[0] === spinCode(s))[1] + ' · ' + fmtLen(s.l), () => ed.edit('Delete spin', cc => { cc.spins = cc.spins.filter(x => x.id !== s.id); })]);
	const simple = (key, label) => { for (const e of c[key]) list.push([e.t, label + ' ' + e.v, () => ed.edit('Delete ' + label, cc => { cc[key] = cc[key].filter(x => x.id !== e.id); })]); };
	simple('filterType', 'Laser filter →'); simple('slamVol', 'Slam volume →'); simple('pfilterGain', 'Filter gain →'); simple('slamSE', 'Slam sound');
	for (const r of c.raw) list.push([r.t, r.k === '//' ? '// ' + r.v : r.k ? r.k + '=' + r.v : r.v, () => ed.edit('Delete line', cc => { cc.raw = cc.raw.filter(x => x.id !== r.id); })]);
	list.sort((a, b) => a[0] - b[0]);
	const at = () => ed.snapT(ed.cursor);
	const addSimple = (key, label, def) => { const v = prompt(label + ' at the cursor:', def); if (v !== null && v !== '') ed.edit('Add ' + label, cc => { cc[key] = cc[key].filter(x => x.t !== at()); K.insertSorted(cc[key], { id: K.nid(), t: at(), v }); }); };
	body.append(sec('Add at cursor (' + posLabel(ed.timing, ed.cursor, ed.div) + ')',
		h('div', { class: 'btns' },
			h('button', { onclick: () => { const r = tl.cv.getBoundingClientRect(); ed.addTimingPopover(at(), r.left + tl.timingL, r.top + tl.yOf(at())); } }, 'BPM / beat / stop / spin…'),
			h('button', { title: 'Laser audio filter from here on', onclick: () => addSimple('filterType', 'Laser filter (peak, lpf1, hpf1, bitc)', 'hpf1') }, 'Laser filter'),
			h('button', { onclick: () => addSimple('slamVol', 'Slam volume %', '50') }, 'Slam volume'),
			h('button', { onclick: () => addSimple('pfilterGain', 'Filter gain (0-100)', '50') }, 'Filter gain'),
			h('button', { onclick: () => { const v = prompt('Comment:'); if (v) ed.edit('Comment', cc => K.insertSorted(cc.raw, { id: K.nid(), t: at(), k: '//', v })); } }, 'Comment'),
			h('button', { title: 'Any KSH option line, e.g. fx:2r90:waveLength=1/8', onclick: () => { const v = prompt('KSH option line (key=value):'); if (v && v.includes('=')) ed.edit('Option line', cc => K.insertSorted(cc.raw, { id: K.nid(), t: at(), k: v.slice(0, v.indexOf('=')), v: v.slice(v.indexOf('=') + 1) })); } }, 'Raw option'))));
	const box = h('div', { class: 'list' });
	for (const [t, label, del, locked] of list) {
		box.append(h('div', { class: 'li', onclick: () => moveCursor(t) }, h('span', { class: 't' }, posLabel(ed.timing, t, ed.div)), h('span', { class: 'msg' }, label), locked ? null : h('button', { class: 'x', title: 'Delete', onclick: (e) => { e.stopPropagation(); del(); } }, '×')));
	}
	body.append(sec('Timing & effect events (' + list.length + ')', box, h('div', { class: 'note' }, 'Click an event to move the cursor there. Camera keyframes live in the graph columns.')));
}

function renderCheck(body) {
	const w = K.validateChart(ed.chart);
	const box = h('div', { class: 'list' });
	if (!w.length) box.append(h('div', { class: 'li' }, h('span', { class: 'msg', style: 'color:var(--ok)' }, 'No problems found.')));
	for (const it of w) box.append(h('div', { class: 'li', onclick: () => moveCursor(it.t) }, h('span', { class: 't' }, posLabel(ed.timing, it.t, ed.div)), h('span', { class: 'msg lvl-' + it.level }, it.msg)));
	body.append(sec('Chart check', h('div', { class: 'note' }, 'Things that would change or break when the chart is saved as .ksh or played in KSM.'), box));
	const end = ed.chartEndTick();
	body.append(sec('Stats', row('Chart length', h('span', null, fmtTime(ed.songTimeOf(end)))), row('Measures', h('span', null, ed.timing.measureOf(end).m + 1)),
		row('Audio', h('span', null, ed.audio.buffer ? ed.audio.fileName + ' · ' + fmtTime(ed.audio.duration) + ' · ' + ed.audio.buffer.sampleRate + ' Hz' : 'not loaded'))));
}

function renderSettings(body) {
	const S = ed.settings;
	const save = () => { ed.saveSettings(); ed.applyAudioSettings(); tl.layout(); ed.requestDraw(); syncSpeedUI(); };
	const slider = (k, min, max, step, fmt) => { const out = h('span', { class: 'muted', style: 'min-width:42px' }, fmt(S[k])); return [h('input', { type: 'range', min, max, step, value: S[k], style: 'flex:1', oninput: (e) => { S[k] = +e.target.value; out.textContent = fmt(S[k]); save(); } }), out]; };
	const chk = (k, after) => h('input', { type: 'checkbox', checked: S[k], onchange: (e) => { S[k] = e.target.checked; save(); if (after) after(); } });
	const pct = v => Math.round(v * 100) + '%';
	body.append(sec('Audio',
		row('Music volume', ...slider('volMusic', 0, 1, 0.01, pct)),
		row('Hitsound volume', ...slider('volHit', 0, 1, 0.01, pct)),
		row('Metronome volume', ...slider('volMetro', 0, 1, 0.01, pct)),
		row('Game sounds volume', ...slider('volGame', 0, 1, 0.01, pct)),
		row('Hitsounds', chk('hitsounds', () => TR.hits.classList.toggle('on', S.hitsounds))),
		row('Slam & FX chip sounds', chk('gameSounds')),
		row('Play FX effects', chk('playFx')),
		row('Effects sound like', h('select', { onchange: (e) => { S.fxSound = e.target.value; save(); } }, h('option', { value: 'sdvx', selected: S.fxSound !== 'usc' }, 'SOUND VOLTEX'), h('option', { value: 'usc', selected: S.fxSound === 'usc' }, 'USC'))),
		h('div', { class: 'note' }, 'Hitsounds are editor ticks for every note. Slam & FX chip sounds are the sounds the game plays (chokkakuse / chokkakuvol, fx-l_se / fx-r_se). "Play FX effects" applies FX hold effects and the laser filter to the music while you edit. SOUND VOLTEX plays them the way the arcade game does with the parameters the .vox export writes: the laser filter is always on, follows the knob 80 ms late and lowers the music a little, and overlapping FX holds do not stack. USC plays them the way USC does with this .ksh, including pfiltergain.'),
		row('Click when placing', chk('placeSound')),
		row('Visual latency', ...slider('latencyMs', -150, 150, 1, v => v + ' ms')),
		h('div', { class: 'note' }, 'Playback timing comes from the audio clock and already corrects for your output device. Only adjust latency if the cursor still looks early (+) or late (−) against what you hear, e.g. with Bluetooth headphones.')));
	body.append(sec('View',
		row('Lane width', ...slider('laneW', 26, 80, 1, v => v + ' px')),
		row('Preview speed', h('select', { onchange: (e) => { S.speedMode = e.target.value; save(); } }, h('option', { value: 'mod', selected: S.speedMode !== 'hs' }, 'Lane speed (like SDVX EG)'), h('option', { value: 'hs', selected: S.speedMode === 'hs' }, 'Hi-speed multiplier'))),
		row('Lane speed', ...slider('modSpeed', 100, 2000, 5, v => (v / 100).toFixed(2))),
		row('Hi-speed', ...slider('hiSpeed', 0.5, 20, 0.05, v => (+v).toFixed(2))),
		row('Draw offset', ...slider('drawOffsetMs', -200, 200, 1, v => (v > 0 ? '+' : '') + v + ' ms')),
		h('div', { class: 'note' }, 'Lane speed = BPM × hi-speed ÷ 100 at the chart\'s main BPM, so 8.00 looks the same in every chart, and faster BPM sections still scroll faster (as in game). The preview uses USC\'s camera, so the track, tilt, spins and zooms match USC. Draw offset is like the game\'s DRAW setting: + makes notes meet a point above the judgment line, − below it. It only moves the preview\'s notes; sound and the timeline are unaffected.'),
		row('Show waveform', chk('showWave')),
		row('Show preview', chk('showPreview', () => { $('#previewPane').classList.toggle('hidden', !S.showPreview); requestAnimationFrame(() => { tl.resize(); pv.resize(); }); })),
		row('Follow playback', chk('follow')),
		row('Invert mouse wheel', chk('invertWheel'))));
	body.append(sec('Saving', row('Autosave (browser)', chk('autosave')), h('div', { class: 'note' }, 'Autosave keeps a copy of the chart in this browser every 15 s. Use File → Restore autosave to get it back.')));
}

// ---------------------------------------------------------------- slam kicks
function slamKickDialog(add) {
	const S = ed.settings;
	const selSlams = ed.slamList(ed.chart, ed.sel);
	const scope = h('select', null, h('option', { value: 'sel' }, 'Selected slams (' + selSlams.length + ')'), h('option', { value: 'all' }, 'All slams in the chart'));
	scope.value = selSlams.length ? 'sel' : 'all';
	const amt = h('input', { type: 'text', value: S.kickAmount || 30, style: 'width:60px' });
	const len = h('input', { type: 'text', value: fmtLen(S.kickLen || 120), style: 'width:60px' });
	const go = () => {
		const list = scope.value === 'sel' ? selSlams : ed.slamList(ed.chart);
		if (!list.length) { toast('No slams to change'); return; }
		if (add) {
			const A = parseFloat(amt.value), L = parseLen(len.value);
			if (!(A > 0) || !(L > 0)) { toast('Enter an amount and a length'); return; }
			S.kickAmount = A; S.kickLen = L; ed.saveSettings();
			const n = ed.edit('Add slam kicks', c => ed.addSlamKicks(c, list, A, L));
			toast(n + ' kick' + (n === 1 ? '' : 's') + ' added' + (n < new Set(list.map(x => x.t)).size ? ' (slams that already have Zoom Side keyframes were skipped)' : ''));
		} else {
			const n = ed.edit('Remove slam kicks', c => ed.removeSlamKicks(c, list));
			toast(n + ' keyframe' + (n === 1 ? '' : 's') + ' removed');
		}
		closeModal(); buildOptbar();
	};
	showModal(add ? 'Add slam kicks' : 'Remove slam kicks', h('div', null,
		h('div', { class: 'note' }, add
			? 'A kick makes the lane jump sideways in the direction of the slam (Zoom Side), then ease back. It is written as ordinary Zoom Side keyframes, so you can move, edit or delete them like any other keyframe. Slams that already have Zoom Side keyframes nearby are skipped.'
			: 'Removes Zoom Side keyframes that jump on a slam and return to the same value (what "Add slam kicks" creates).'),
		row('Apply to', scope),
		add ? row('Amount', amt, h('span', { class: 'muted' }, 'zoom_side units (±)')) : null,
		add ? row('Ease back over', len, h('span', { class: 'muted' }, 'measures (e.g. 1/8)')) : null,
		h('div', { class: 'btns' }, h('button', { class: 'on', onclick: go }, add ? 'Add kicks' : 'Remove kicks'), h('button', { onclick: closeModal }, 'Cancel'))));
}

// ---------------------------------------------------------------- files
function pickFiles(accept) { const fi = $('#fileInput'); fi.accept = accept || '.ksh,.vox,.ogg,.mp3,.wav,.flac,.m4a,.opus,audio/*'; fi.value = ''; fi.click(); }
$('#fileInput').addEventListener('change', (e) => { if (e.target.files.length) openFiles([...e.target.files]); });
const AUDIO_RE = /\.(ogg|mp3|wav|flac|m4a|opus|aac|webm)$/i;
function confirmDiscard() { return !ed.dirty || confirm('Discard unsaved changes to ' + ed.fileName + '?'); }
async function openFiles(files, handles) {
	const chartFile = files.find(f => /\.ksh$/i.test(f.name));
	const voxFile = !chartFile && files.find(f => /\.vox$/i.test(f.name));
	if (voxFile) {
		if (!confirmDiscard()) return;
		const r = SDVX.importVox(new TextDecoder('utf-8').decode(await voxFile.arrayBuffer()), voxFile.name);
		ed.loadChart(r.chart, voxFile.name.replace(/\.vox$/i, '.ksh'));
		ed.fileHandle = null; ed.dirHandle = null;
		tl.bottomTick = -tl.h * 0.15 / tl.ppt;
		showWarnings('Imported ' + voxFile.name, 'The SOUND VOLTEX chart was converted to the editor\'s format: notes, lasers, slams, spins, FX hold effects, laser effects, camera and tilt. Save writes it as .ksh.', r.warnings);
	}
	if (files.some(f => /\.s3v$/i.test(f.name)) && !files.some(f => AUDIO_RE.test(f.name))) toast('.s3v audio (WMA Pro) can\'t be decoded by browsers; convert it to .ogg or .wav first.', true);
	const kson = files.find(f => /\.kson$/i.test(f.name));
	if (kson && !chartFile) toast('.kson is not supported yet; please open the .ksh version.', true);
	let audio = files.find(f => AUDIO_RE.test(f.name));
	if (chartFile) {
		if (!confirmDiscard()) return;
		const r = K.importKsh(new Uint8Array(await chartFile.arrayBuffer()));
		ed.loadChart(r.chart, chartFile.name);
		ed.fileHandle = handles ? handles.get(chartFile.name) || null : null; ed.dirHandle = null;
		tl.bottomTick = -tl.h * 0.15 / tl.ppt;
		if (r.warnings.length) toast(r.warnings.length + ' note(s) while loading: ' + r.warnings[0].msg);
		else toast('Opened ' + chartFile.name + (r.encoding === 'shift_jis' ? ' (Shift-JIS)' : ''));
		const want = (ed.chart.meta.m || '').split(';')[0];
		if (!audio && want) { const a2 = files.find(f => f.name === want); if (a2) audio = a2; }
		if (!audio && want && !(ed.audio.buffer && ed.audio.fileName === want)) setTimeout(() => toast('This chart uses "' + want + '". Drop it here or use Load audio.'), 2600);
	}
	if (audio) await loadAudio(audio);
}
async function loadAudio(file) {
	try {
		toast('Decoding ' + file.name + '…');
		await ed.audio.load(await file.arrayBuffer(), file.name);
		if (!ed.chart.meta.m) ed.edit('Set music file', c => { c.meta.m = file.name; });
		toast('Loaded ' + file.name + ' (' + fmtTime(ed.audio.duration) + ')');
		lastTr = ''; ed.requestDraw(); renderTab();
	} catch (e) { toast('Could not decode ' + file.name + ': ' + (e.message || e) + '. Try .ogg, .mp3 or .wav.', true); }
}
async function openDialog() {
	if ('showOpenFilePicker' in window) {
		try {
			const hs = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'KSH / VOX chart, audio', accept: { 'text/plain': ['.ksh', '.vox'], 'audio/*': ['.ogg', '.mp3', '.wav', '.flac', '.m4a', '.opus'] } }] });
			const files = await Promise.all(hs.map(x => x.getFile()));
			const map = new Map(hs.map((x, i) => [files[i].name, x]));
			return openFiles(files, map);
		} catch (e) { if (e.name === 'AbortError') return; }
	}
	pickFiles();
}
async function openFolder() {
	try {
		const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
		const kshs = [], all = new Map();
		for await (const [name, hd] of dir.entries()) { if (hd.kind !== 'file') continue; all.set(name, hd); if (/\.ksh$/i.test(name)) kshs.push(name); }
		if (!kshs.length) return toast('No .ksh files in that folder.', true);
		const openOne = async (name) => {
			closeModal();
			if (!confirmDiscard()) return;
			const f = await all.get(name).getFile();
			const r = K.importKsh(new Uint8Array(await f.arrayBuffer()));
			ed.loadChart(r.chart, name); ed.fileHandle = all.get(name); ed.dirHandle = dir;
			tl.bottomTick = -tl.h * 0.15 / tl.ppt;
			const want = (ed.chart.meta.m || '').split(';')[0];
			if (want && all.has(want)) await loadAudio(await all.get(want).getFile());
			else toast('Opened ' + name + (want ? ' (audio "' + want + '" not found in folder)' : ''));
		};
		if (kshs.length === 1) return openOne(kshs[0]);
		const box = h('div', { class: 'list' }, kshs.sort().map(n => h('div', { class: 'li', onclick: () => openOne(n) }, h('span', { class: 'msg' }, n))));
		showModal('Choose a chart', box);
	} catch (e) { if (e.name !== 'AbortError') toast('Could not open folder: ' + e.message, true); }
}
function download(name, text) {
	const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: name });
	document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportWarnings() {
	const w = K.validateChart(ed.chart).filter(x => x.level === 'error');
	if (w.length) toast('Saved, but the Check tab has ' + w.length + ' problem(s) to look at.', true);
}
async function save(as) {
	const { text } = K.exportKsh(ed.chart);
	let name = ed.fileName && ed.fileName !== 'untitled.ksh' ? ed.fileName : ((ed.chart.meta.title || 'chart').replace(/[\\/:*?"<>|]+/g, '_') + '.ksh');
	try {
		if (!as && ed.fileHandle && ed.fileHandle.createWritable) {
			const w = await ed.fileHandle.createWritable(); await w.write(text); await w.close();
			ed.dirty = false; updateTitle(); toast('Saved ' + ed.fileName); exportWarnings(); clearAutosave(); return;
		}
		if ('showSaveFilePicker' in window) {
			const hd = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'KSH chart', accept: { 'text/plain': ['.ksh'] } }] });
			const w = await hd.createWritable(); await w.write(text); await w.close();
			ed.fileHandle = hd; ed.fileName = hd.name; ed.dirty = false; updateTitle(); toast('Saved ' + hd.name); exportWarnings(); clearAutosave(); return;
		}
	} catch (e) { if (e.name === 'AbortError') return; }
	download(name, text);
	ed.fileName = name; ed.dirty = false; updateTitle(); toast('Downloaded ' + name); exportWarnings(); clearAutosave();
}
function exportV1() {
	const r = K.exportKsh(ed.chart, { v1: true });
	download(fileNameNoExt() + '_ksm_v1.ksh', r.text);
	toast(r.warnings.length ? 'Exported for KSM v1. ' + r.warnings.map(w => w.msg).join(' ') : 'Exported for KSM v1 (nothing needed converting).');
}
function exportUsc() {
	const r = K.exportKsh(ed.chart, { usc: true });
	download(fileNameNoExt() + '_usc.ksh', r.text);
	showWarnings('Exported for USC', 'Saved ' + fileNameNoExt() + '_usc.ksh. Put it in the song folder next to the audio file (' + (ed.chart.meta.m || 'music file') + ').', r.warnings, 'USC reads curves as straight steps, scroll_speed as a percentage and has no rotation_deg, so those were converted. Nothing else changed.');
}
function showWarnings(title, lead, warnings, okNote) {
	const list = warnings.length ? h('ul', { class: 'warnlist' }, warnings.map(w => h('li', null, (w.t ? posLabel(ed.timing, w.t, ed.div) + ': ' : '') + w.msg))) : h('div', { class: 'note' }, okNote || 'Nothing needed converting.');
	showModal(title, h('div', null, h('div', { class: 'note' }, lead), list, h('div', { class: 'btns' }, h('button', { class: 'on', onclick: closeModal }, 'OK'))));
}
function exportSdvxDialog() {
	const m = ed.chart.meta, S = ed.settings;
	const sanitize = (s) => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 32);
	const f = {};
	const inp = (k, v, w, ph) => (f[k] = h('input', { type: 'text', value: v ?? '', placeholder: ph || '', style: 'width:' + (w || '200px') }));
	const sel = (k, opts, v) => { f[k] = h('select', null, opts.map(([a, b]) => h('option', { value: a }, b))); f[k].value = v; return f[k]; };
	const bpms = ed.chart.bpm.map(b => b.v);
	const slotDef = SDVX.KSH_DIFF_SLOT[m.difficulty] || 'maximum';
	const jacket = h('input', { type: 'file', accept: 'image/*' });
	const hasAudio = !!(ed.audio.srcBytes);
	const audioChk = h('input', { type: 'checkbox', checked: hasAudio, disabled: !hasAudio });
	const x10 = h('input', { type: 'checkbox', checked: S.sdvxLevelX10 !== false });
	const existing = h('input', { type: 'checkbox', checked: !!S.sdvxExisting, onchange: () => { if (existing.checked) audioChk.checked = false; else audioChk.checked = hasAudio; } });
	if (existing.checked) audioChk.checked = false;
	const body = h('div', { class: 'sdvx-export' },
		h('div', { class: 'note' }, 'Makes a .zip shaped like the game\'s own song folders: <id>_<name>/ with the .vox chart, jackets and the song + preview audio, ready to drop into data/music, plus the music_db entry to paste into data/others/music_db.xml (README inside). Settings are remembered.'),
		row('Existing song', h('label', { style: 'display:inline-flex;gap:4px;align-items:center' }, existing, 'add this chart to a song already in the game (use its ID and name; no audio, only this difficulty\'s music_db block)')),
		row('Song ID', inp('id', S.sdvxId || 2000, '80px'), h('span', { class: 'muted' }, 'must not clash with other songs')),
		row('ASCII name', inp('ascii', S.sdvxAscii || sanitize(m.title_translit || m.title) || 'custom', '160px'), h('span', { class: 'muted' }, 'letters, digits, _ and -')),
		row('Chart slot', sel('slot', SDVX.SLOTS.map(s => [s.id, s.label]), slotDef)),
		row('INF slot type', sel('inf', [['2', 'INF'], ['3', 'GRV'], ['4', 'HVN'], ['5', 'VVD'], ['6', 'XCD']], String(S.sdvxInf || 6)), h('span', { class: 'muted' }, 'only for slot 4')),
		row('Level', inp('level', S.sdvxLevel && S.sdvxLevelFor === ed.fileName ? S.sdvxLevel : (m.level || '1'), '50px'), h('label', { style: 'display:inline-flex;gap:4px;align-items:center' }, x10, '×10 for ∇ / EG decimals (19.7 → 197)')),
		row('Game version', sel('version', [['1', '1 BOOTH'], ['2', '2 II'], ['3', '3 III'], ['4', '4 IV'], ['5', '5 V'], ['6', '6 EXCEED GEAR'], ['7', '7 ∇']], String(S.sdvxVersion || 7)), h('span', { class: 'muted' }, 'version the song is listed under')),
		row('VOX format', sel('format', [['12', '12 (current games)'], ['10', '10 (older tools)']], String(S.sdvxFormat || 12))),
		row('Title', inp('title', m.title, '220px')), row('Title (yomigana)', inp('titleYomi', S.sdvxTitleYomi || '', '220px', 'reading in katakana, optional')),
		row('Artist', inp('artist', m.artist, '220px')), row('Artist (yomigana)', inp('artistYomi', '', '220px', 'optional')),
		row('Illustrator', inp('illustrator', m.illustrator, '160px')), row('Effected by', inp('effector', m.effect, '160px')),
		row('BPM range', inp('bpmMin', K.fmtNum(Math.min(...bpms)), '60px'), h('span', { class: 'muted' }, 'to'), inp('bpmMax', K.fmtNum(Math.max(...bpms)), '60px')),
		row('Music volume', inp('volume', S.sdvxVolume || 91, '50px'), h('span', { class: 'muted' }, 'music_db volume (game default 91)')),
		row('Laser right edge', sel('edge', [['124', '124 (same as your 2811 files)'], ['127', '127 (full range)']], String(S.sdvxEdge || 124)), h('span', { class: 'muted' }, 'format 10 only')),
		row('Jacket image', jacket),
		row('Song audio', h('label', { style: 'display:inline-flex;gap:4px;align-items:center' }, audioChk, hasAudio ? 'make .2dx from ' + ed.audio.fileName : 'load the song first to make .2dx files')),
		row('Preview', h('span', { class: 'muted' }, 'from ' + ((parseInt(m.po, 10) || 0) / 1000).toFixed(1) + ' s for ' + (((parseInt(m.plength, 10) || 15000)) / 1000).toFixed(1) + ' s (po / plength in the Chart tab)')),
		h('div', { class: 'note' }, 'The chart offset (o = ' + (m.o || 0) + ' ms) is applied to the audio so measure 1 starts at 0:00, since SDVX has no offset setting.'));
	const status = h('div', { class: 'note' });
	const go = async () => {
		const id = parseInt(f.id.value, 10), ascii = f.ascii.value.trim();
		if (!(id > 0 && id < 10000)) return toast('Song ID must be 1–9999', true);
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ascii)) return toast('ASCII name: letters, digits, _ and - only', true);
		const lv = parseFloat(f.level.value) || 1;
		Object.assign(S, { sdvxId: id, sdvxAscii: ascii, sdvxInf: +f.inf.value, sdvxVersion: +f.version.value, sdvxVolume: parseInt(f.volume.value, 10) || 91, sdvxEdge: +f.edge.value, sdvxLevelX10: x10.checked, sdvxFormat: +f.format.value, sdvxExisting: existing.checked, sdvxLevel: f.level.value, sdvxLevelFor: ed.fileName });
		ed.saveSettings();
		btn.disabled = true;
		try {
			const r = await SDVX.buildPackage(ed.chart, {
				id, ascii, slot: f.slot.value, infVer: f.slot.value === 'infinite' ? +f.inf.value : (f.slot.value === 'maximum' ? 0 : 0),
				difnum: Math.round(x10.checked ? lv * 10 : lv), version: +f.version.value, volume: K.clamp(parseInt(f.volume.value, 10) || 91, 0, 127),
				laserEdge: +f.edge.value, format: +f.format.value, existing: existing.checked, title: f.title.value, artist: f.artist.value, titleYomi: f.titleYomi.value, artistYomi: f.artistYomi.value,
				illustrator: f.illustrator.value, effector: f.effector.value, bpmMin: parseFloat(f.bpmMin.value) || bpms[0], bpmMax: parseFloat(f.bpmMax.value) || bpms[0],
				jacket: jacket.files[0] || null, audioBytes: audioChk.checked ? ed.audio.srcBytes : null,
				offsetMs: parseInt(m.o, 10) || 0, previewMs: (parseInt(m.po, 10) || 0), previewLen: parseInt(m.plength, 10) || 15000,
			}, (msg) => { status.textContent = msg; });
			const name = String(id).padStart(4, '0') + '_' + ascii + '_sdvx.zip';
			const a = h('a', { href: URL.createObjectURL(r.blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
			showWarnings('SOUND VOLTEX export', 'Saved ' + name + ' (' + r.files.length + ' files). Copy the "' + r.stem + '" folder into data/music and add the music_db entry (see README.txt in the zip).', r.warnings, 'Everything converted.');
		} catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), true); btn.disabled = false; }
	};
	const btn = h('button', { class: 'on', onclick: go }, 'Export .zip');
	showModal('Export for SOUND VOLTEX', h('div', null, body, status, h('div', { class: 'btns' }, btn, h('button', { onclick: closeModal }, 'Cancel'))));
}
function viewKsh() {
	const { text } = K.exportKsh(ed.chart);
	const ta = h('textarea', { rows: 28, readonly: true, style: 'height:60vh' }); ta.value = text.replace(/^﻿/, '');
	showModal('.ksh output', h('div', null, h('div', { class: 'note' }, 'This is exactly what Save writes (UTF-8 with BOM, CRLF line endings).'), ta));
}
function newChart() {
	if (!confirmDiscard()) return;
	ed.loadChart(K.newChart(), 'untitled.ksh'); ed.fileHandle = null; ed.dirHandle = null;
	tl.bottomTick = -tl.h * 0.15 / tl.ppt;
}

// ---------------------------------------------------------------- autosave
const AS_KEY = 'ksmed.autosave';
let autosaveBanner = null;
function doAutosave() {
	if (!ed.settings.autosave || !ed.dirty) return;
	try { localStorage.setItem(AS_KEY, JSON.stringify({ name: ed.fileName, time: Date.now(), ksh: K.exportKsh(ed.chart).text })); } catch (e) { }
}
function clearAutosave() { try { localStorage.removeItem(AS_KEY); } catch (e) { } }
function readAutosave() { try { return JSON.parse(localStorage.getItem(AS_KEY) || 'null'); } catch (e) { return null; } }
function restoreAutosave() {
	const a = readAutosave(); if (!a) return toast('No autosave found.', true);
	if (!confirmDiscard()) return;
	const r = K.importKsh(a.ksh);
	ed.loadChart(r.chart, a.name); ed.dirty = true; updateTitle();
	autosaveBanner = null; renderTab(true);
	toast('Restored autosave from ' + new Date(a.time).toLocaleString());
}
setInterval(doAutosave, 15000);
window.addEventListener('beforeunload', (e) => { if (ed.dirty) { doAutosave(); e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- help
function showHelp() {
	const rows = [
		['1 – 5', 'Tools: Select, BT, FX, Laser L, Laser R'],
		['Click / drag', 'Place a chip / drag up to make a hold'],
		['Laser tools', 'Drag to draw. Start a drag on a laser\'s end point to continue it. A sideways drag (same time) makes a slam. Drag a point to move it, drag a laser\'s body to add a point.'],
		['Right-click', 'Delete the thing under the mouse'],
		['Graph columns', 'Click to add a camera keyframe (zoom/tilt/rotation…), drag to change value and time, double-click to type a value'],
		['BPM column', 'Click to add BPM / time signature / stop / spin, double-click a marker to edit'],
		['Measure gutter', 'Click or drag to move the cursor'],
		['Space', 'Play / pause from the cursor'], ['Shift+Space', 'Stop and jump back'],
		['↑ / ↓', 'Move cursor one grid step'], ['PgUp / PgDn', 'Move cursor one measure'], ['Home / End', 'Start / last note'],
		['Ctrl+↑ / ↓ or [ / ]', 'Finer / coarser grid'], ['Mouse wheel', 'Scroll'], ['Ctrl+wheel, + / -', 'Zoom'],
		['Alt (while dragging)', 'Turn off snapping'], ['Shift / Ctrl+click', 'Add to selection'],
		['Ctrl+C / X / V', 'Copy / cut / paste at the cursor'], ['Ctrl+Shift+V', 'Paste mirrored'], ['Ctrl+M', 'Mirror selection'],
		['Alt+↑ / ↓', 'Move selection one grid step'], ['Del', 'Delete selection'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
		['Ctrl+S', 'Save .ksh'], ['Ctrl+O', 'Open .ksh and/or audio (or drag files onto the window)'],
		['M / H / P', 'Metronome / hitsounds / preview'],
	];
	showModal('Controls & shortcuts', '<table>' + rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('') + '</table>');
}
// ---------------------------------------------------------------- effects guide (Help menu)
const GUIDE_HTML = `
<p>Jump to: <a href="#g-spins">Lane spins &amp; swings</a> · <a href="#g-laser">Laser effects</a> · <a href="#g-fx">FX hold effects</a> · <a href="#g-wide">Wide lasers (2x)</a> · <a href="#g-custom">Custom effects</a></p>

<h3 id="g-spins">Lane spins &amp; swings (screen shake)</h3>
<p>They move the whole lane for a moment. Put them on a <b>laser slam</b>: KSM, USC and SOUND VOLTEX all start them from a slam (the SDVX export drops any that are not on one). To add one, select the slam and use <i>Lane spin / swing</i> in Properties, or click the BPM column. Edit one by selecting its purple label on the lane, or double-click the label. The arrow is the direction; it usually matches the slam.</p>
<table>
<tr><td>Spin <code>@(</code> <code>@)</code></td><td>The lane does a full 360° roll to the left <code>(</code> or right <code>)</code>, overshoots a little and settles. The big "the whole screen turns" effect.</td></tr>
<tr><td>Half spin <code>@&lt;</code> <code>@&gt;</code></td><td>The lane tips far over to one side (about a third of a turn), then swings back and wobbles to rest without going all the way round.</td></tr>
<tr><td>Swing <code>S&lt;</code> <code>S&gt;</code></td><td>The lane does not rotate. It slides sideways back and forth like it was hit, then calms down. <i>Swing size</i> (default 250) is how far, <i>Swings</i> (default 3) is how many one-way moves, and <i>Decay</i> sets how fast it dies down (none / linear / squared).</td></tr>
<tr><td>Length</td><td>How long the motion takes, in measures (1 = one 4/4 measure). In SOUND VOLTEX the spin's length includes its overshoot, so the export doubles it.</td></tr>
</table>
<p>The game also reacts to <b>every</b> slam by itself: a small sideways shake, a quick roll kick and the laser tilt. That's why SDVX charts don't need a "zoom side" kick. The editor's slam kicks (Zoom Side keyframes) only matter in USC / KSM.</p>

<h3 id="g-laser">Laser effects (filtertype)</h3>
<p>While a laser is held, it changes the music. The amount comes from how far the laser is from the side it starts on: the left (blue) laser counts from the left edge and the right (pink) laser from the right edge. With both lasers held, the one further from its edge wins. A laser resting on its starting edge does nothing. You choose the effect per laser (select a laser, <i>Laser effect</i>); it stays until another laser changes it.</p>
<table>
<tr><td><code>peak</code> (default)</td><td>A boosted, ringing band of frequencies that sweeps from low to high as the laser moves: the classic "wah" laser sound. In SOUND VOLTEX it follows the laser slightly late (80 ms) and lowers the rest of the music a little while turned.</td></tr>
<tr><td><code>lpf1</code> low-pass</td><td>Cuts the treble: the further out, the more muffled ("underwater").</td></tr>
<tr><td><code>hpf1</code> high-pass</td><td>Cuts the bass: the further out, the thinner and more "radio-like".</td></tr>
<tr><td><code>bitc</code> bitcrusher</td><td>Makes the music crunchy and digital; the further out, the more lo-fi.</td></tr>
<tr><td>custom name</td><td>A <code>#define_filter</code> (see below). If its type is an FX effect such as Retrigger, that effect runs for as long as a laser is held. SOUND VOLTEX calls this "auto tab".</td></tr>
</table>
<p><b>Filter gain</b> (<code>pfiltergain</code>, 0–100, default 50) sets how strong laser effects are in USC / KSM; 0 turns them off. SOUND VOLTEX has no such setting. <b>Filter delay</b> (<code>pfilterdelay</code>) is KSM's reaction delay in ms. Settings → <i>Effects sound like</i> picks whether the editor plays effects like SOUND VOLTEX or like USC.</p>

<h3 id="g-fx">FX hold effects</h3>
<p>An FX hold (orange long note) applies its effect to the music while it is held. The number after the name is the main setting, as in <code>Retrigger;16</code>. Many of them are "1/n note" lengths, so bigger numbers mean faster. FX chips (short orange notes) can play a key sound instead (clap, snare…).</p>
<table>
<tr><td>Retrigger;n</td><td>Grabs a 1/n-note slice and repeats it like a stuck record or a DJ stutter. 8 = 1/8 note, 16 = faster, 32 = buzzing.</td></tr>
<tr><td>Gate;n</td><td>Chops the music on and off every 1/n note (a "trance gate").</td></tr>
<tr><td>Flanger</td><td>A sweeping metallic "jet plane" whoosh.</td></tr>
<tr><td>Phaser</td><td>A softer swirling sweep (USC / KSM only; SOUND VOLTEX has no phaser, so it is exported as Flanger).</td></tr>
<tr><td>Wobble;n</td><td>A low-pass filter that opens and closes every 1/n note: the dubstep "wub wub".</td></tr>
<tr><td>PitchShift;n</td><td>Raises the pitch by n semitones (12 = one octave up, negative = down).</td></tr>
<tr><td>BitCrusher;n</td><td>Crunchy lo-fi sound; bigger n = crunchier.</td></tr>
<tr><td>TapeStop;n</td><td>The music slows down to a stop like a turntable being switched off. Higher n = stops faster.</td></tr>
<tr><td>Echo;n;fb</td><td>Repeats the slice every 1/n note while it fades out (fb = how much each repeat keeps, in %).</td></tr>
<tr><td>SideChain</td><td>Ducks the volume on every beat and lets it swell back: the "pumping" sound.</td></tr>
</table>
<p>In SOUND VOLTEX, when FX-L and FX-R overlap, the later hold's effect replaces the earlier one instead of stacking (USC stacks them). Charts opened from a <code>.vox</code> use effects named <code>SV_…</code>. They are the same effects with the game's exact settings stored inside (see below). Plain effects such as <code>Retrigger;8</code> work in SOUND VOLTEX too: the export turns them into the game's closest settings.</p>

<h3 id="g-wide">Wide lasers (2x)</h3>
<p>A wide laser (<code>laserrange_l=2x</code> / <code>laserrange_r=2x</code>, the "Wide (2x)" box on a laser) covers twice the lane's width. The middle position stays in the middle, but the edges reach far outside the lane, so the laser can swing off the sides of the track. It's used for big sweeping laser sections. A laser is wide or normal from start to end; to switch, start a new laser. The editor marks wide lasers with "2x".</p>

<h3 id="g-custom">Custom audio effects (#define_fx / #define_filter)</h3>
<p>Write them in the Chart tab → <i>Advanced</i> → <i>Custom audio effects</i>, one per line. <code>#define_fx</code> makes an effect for FX holds; it then appears as "<i>name</i> (custom)" in the FX hold's effect list. <code>#define_filter</code> makes a laser effect; it then appears in the laser's <i>Laser effect</i> list.</p>
<pre>#define_fx    FastRetrig type=Retrigger;waveLength=1/32;rate=60%
#define_fx    DeepWob    type=Wobble;waveLength=1/8;loFreq=200;hiFreq=8000;Q=3.0
#define_fx    Crunch     type=BitCrusher;reduction=20samples;amount=20samples
#define_filter LaserGate type=Gate;waveLength=1/16
#define_filter Stop      type=TapeStop;speed=20%</pre>
<p>Format: <code>#define_fx &lt;name&gt; type=&lt;Effect&gt;;key=value;key=value…</code> (no spaces inside the list). Units: note lengths like <code>1/8</code>, times like <code>300ms</code>, samples like <code>80samples</code>, percentages like <code>60%</code>, frequencies in Hz as plain numbers.</p>
<table>
<tr><td>Retrigger</td><td><code>waveLength</code> slice length, <code>rate</code> how much of each slice sounds (70%), <code>updatePeriod</code> how often a new slice is grabbed (1/2), <code>mix</code></td></tr>
<tr><td>Gate</td><td><code>waveLength</code>, <code>rate</code> on-time per step (50%), <code>mix</code></td></tr>
<tr><td>Flanger</td><td><code>period</code> sweep time, <code>delay</code> (30samples), <code>depth</code> (45samples), <code>feedback</code> (60%), <code>stereoWidth</code>, <code>volume</code>, <code>mix</code></td></tr>
<tr><td>Phaser</td><td><code>period</code>, <code>stage</code> (6), <code>loFreq</code>, <code>hiFreq</code>, <code>Q</code>, <code>feedback</code>, <code>stereoWidth</code>, <code>hiCutGain</code>, <code>mix</code></td></tr>
<tr><td>Wobble</td><td><code>waveLength</code>, <code>loFreq</code> (500), <code>hiFreq</code> (20000), <code>Q</code> (1.414), <code>mix</code></td></tr>
<tr><td>BitCrusher</td><td><code>reduction</code> (KSM) / <code>amount</code> (USC), e.g. <code>10samples</code>. Write both to be safe. <code>mix</code></td></tr>
<tr><td>PitchShift</td><td><code>pitch</code> in semitones, <code>mix</code></td></tr>
<tr><td>TapeStop</td><td><code>speed</code> (50%), <code>trigger</code>, <code>mix</code></td></tr>
<tr><td>Echo</td><td><code>waveLength</code>, <code>feedbackLevel</code> (60%), <code>updatePeriod</code>, <code>mix</code></td></tr>
<tr><td>SideChain</td><td><code>period</code> (1/4), <code>attackTime</code>, <code>holdTime</code>, <code>releaseTime</code>, <code>ratio</code> (5.0)</td></tr>
<tr><td>Laser filters</td><td><code>#define_filter</code> also accepts <code>type=PeakingFilter</code>, <code>LowPassFilter</code> or <code>HighPassFilter</code></td></tr>
</table>
<p>A value can change with the laser position: <code>off&gt;min-max</code>. For example, <code>mix=0%&gt;50%-100%</code> means off when no laser is held, then 50% at the starting edge rising to 100% at the far side (USC / KSM). The editor's own playback reads only the main setting (<code>waveLength</code>, <code>feedbackLevel</code>, <code>amount</code>/<code>reduction</code>, <code>pitch</code>, <code>speed</code>). USC and KSM use all of them.</p>
<p><b>SOUND VOLTEX settings (<code>sdvx=</code>).</b> Charts opened from a <code>.vox</code> keep the game's own numbers in an extra <code>sdvx=</code> key. USC and KSM ignore it, while the SDVX export and SOUND VOLTEX playback use it exactly. You can add or edit it yourself. Each one is the effect's id followed by its settings:</p>
<table>
<tr><td>1 Retrigger</td><td><code>1,count,mix,beats,feedback,gate,release</code>: <code>count</code> repeats of the first slice in every <code>beats</code>-long cycle; for example <code>1,8,95,2,1,0.85,0.15</code></td></tr>
<tr><td>8 Echo</td><td><code>8,count,mix,beats,feedback,gate,release,0</code>, the same as Retrigger but each repeat is quieter by <code>feedback</code></td></tr>
<tr><td>2 Gate</td><td><code>2,mix,steps,beats</code>: <code>steps</code> loud/quiet steps per <code>beats</code></td></tr>
<tr><td>3 Flanger</td><td><code>3,mix,delayMs,rate,depth%,stages</code></td></tr>
<tr><td>4 Tape stop</td><td><code>4,mix,speed(1–10),seconds</code></td></tr>
<tr><td>5 Side chain</td><td><code>5,mix,beats,attack%,hold%,release%</code></td></tr>
<tr><td>6 Wobble</td><td><code>6,filter(0 LPF,1 HPF,2 BPF),wave(0 saw up,1 saw down,2 sine,3 triangle,4 square),mix,freqA,freqB,perBeat,Q</code></td></tr>
<tr><td>7 Bit crusher</td><td><code>7,mix,samples(1–30)</code></td></tr>
<tr><td>9 Pitch shift</td><td><code>9,mix,semitones</code></td></tr>
<tr><td>Laser filters</td><td><code>1,mix,lowHz,highHz,Q</code> (LPF), <code>2,mix,lowHz,highHz,Q</code> (HPF), <code>3,mix,samples</code> (bitcrush)</td></tr>
</table>`;
function showGuide(anchor) {
	showModal('Effects, spins & lasers guide', GUIDE_HTML);
	const b = $('#modalBody');
	b.querySelectorAll('a[href^="#g-"]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); const t = b.querySelector(a.getAttribute('href')); if (t) t.scrollIntoView({ block: 'start' }); }));
	const t = anchor && b.querySelector('#' + anchor);
	b.scrollTop = 0; if (t) t.scrollIntoView({ block: 'start' });
}
function showAbout() {
	showModal('About KSH export', `
<p>Charts are saved in K-Shoot MANIA's <b>.ksh</b> format, following the official spec and libkson (KSM's own parser). The exporter re-saves KSM's sample charts byte-for-byte identical to KSM's editor.</p>
<h3>How things are stored</h3>
<table>
<tr><td>Time</td><td>240 ticks per beat. Each measure is written with the fewest lines that hit every note (up to 192 per measure for 1/192 snaps).</td></tr>
<tr><td>BT</td><td><code>1</code> chip, <code>2</code> hold rows</td></tr>
<tr><td>FX</td><td><code>2</code> chip, <code>1</code> hold rows, effect in <code>fx-l=</code>/<code>fx-r=</code></td></tr>
<tr><td>Lasers</td><td>Positions 0–50 as <code>0-9 A-Z a-o</code>, <code>:</code> connects, <code>-</code> none. A slam is written as a 1/32 step.</td></tr>
<tr><td>Spins</td><td>Appended to the slam's line: <code>@(</code> <code>@)</code> spin, <code>@&lt;</code> <code>@&gt;</code> half spin, <code>S&lt;</code> <code>S&gt;</code> swing, length in 1/192 measures</td></tr>
<tr><td>Camera</td><td><code>zoom_top</code>, <code>zoom_bottom</code>, <code>zoom_side</code>, <code>center_split</code>, <code>tilt</code>; a jump is two lines with the same key</td></tr>
<tr><td>KSM v2 only</td><td><code>scroll_speed</code>, <code>rotation_deg</code> and all <code>*_curve</code> lines. Use File → Export for KSM v1 to turn curves into steps.</td></tr>
</table>`);
}

// ---------------------------------------------------------------- input wiring
const cv = $('#timeline');
cv.addEventListener('pointerdown', (e) => { cv.focus(); if (popoverClose) popoverClose(); cv.setPointerCapture(e.pointerId); ed.pointerDown(e); ed.requestDraw(); });
cv.addEventListener('pointermove', (e) => ed.pointerMove(e));
cv.addEventListener('pointerup', (e) => { ed.pointerUp(e); try { cv.releasePointerCapture(e.pointerId); } catch (x) { } });
cv.addEventListener('pointerleave', () => { if (!ed.drag) { ed.mouse = null; ed.ghost = null; ed.hover = null; ed.requestDraw(); } });
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('dblclick', (e) => e.preventDefault());
let seekTimer = 0;
cv.addEventListener('wheel', (e) => {
	e.preventDefault();
	const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
	if (e.ctrlKey || e.metaKey) { zoomBy(dy < 0 ? 1.15 : 1 / 1.15, e.offsetY); return; }
	const dir = ed.settings.invertWheel ? -1 : 1;
	const dt = -dy * dir * (e.shiftKey ? 4 : 1) / tl.ppt;
	if (ed.playing) {
		ed.playTick = Math.max(0, ed.playTick + dt);
		ed.audio.stop(); ed.playing = false;
		clearTimeout(seekTimer); const target = ed.playTick;
		ed.cursor = target; tl.bottomTick = target - (tl.h * 0.2) / tl.ppt;
		seekTimer = setTimeout(() => { ed.cursor = target; ed.play(); }, 120);
	} else tl.bottomTick += dt;
	if (ed.drag) ed.pointerMove(e);
	ed.requestDraw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
	const tag = document.activeElement && document.activeElement.tagName;
	const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
	const ctrl = e.ctrlKey || e.metaKey, k = e.key;
	if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); save(e.shiftKey); return; }
	if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); openDialog(); return; }
	if (typing) { if (k === 'Escape') document.activeElement.blur(); return; }
	if (!$('#modal').classList.contains('hidden')) { if (k === 'Escape') closeModal(); return; }
	if (k === 'F1') { e.preventDefault(); showHelp(); return; }
	if (ctrl) {
		const lk = k.toLowerCase();
		if (lk === 'z' && !e.shiftKey) { e.preventDefault(); ed.undo(); }
		else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); ed.redo(); }
		else if (lk === 'c') { e.preventDefault(); ed.copy(); }
		else if (lk === 'x') { e.preventDefault(); ed.copy(true); }
		else if (lk === 'v') { e.preventDefault(); ed.paste(e.shiftKey); }
		else if (lk === 'a') { e.preventDefault(); ed.selectAll(e.shiftKey); }
		else if (lk === 'm') { e.preventDefault(); ed.mirrorSelection(); }
		else if (lk === 'n') { e.preventDefault(); newChart(); }
		else if (k === 'ArrowUp') { e.preventDefault(); changeDiv(1); }
		else if (k === 'ArrowDown') { e.preventDefault(); changeDiv(-1); }
		return;
	}
	const tool = TOOLS.find(t => t.key === k);
	if (tool && !e.altKey) { setTool(tool.id); return; }
	switch (k) {
		case ' ': e.preventDefault(); e.shiftKey ? ed.stop() : ed.toggle(); break;
		case 'Escape': if (ed.drag) ed.cancelDrag(); else if (popoverClose) popoverClose(); else ed.setSel([]); break;
		case 'Delete': case 'Backspace': e.preventDefault(); ed.deleteSelection(); break;
		case 'ArrowUp': e.preventDefault(); if (e.altKey) ed.nudgeSelection(1); else moveCursor(ed.timing.stepFrom(ed.playing ? ed.playTick : ed.cursor, ed.div, 1)); break;
		case 'ArrowDown': e.preventDefault(); if (e.altKey) ed.nudgeSelection(-1); else moveCursor(ed.timing.stepFrom(ed.playing ? ed.playTick : ed.cursor, ed.div, -1)); break;
		case 'PageUp': e.preventDefault(); { const ms = ed.timing.measureOf(ed.cursor); moveCursor(ms.start + ms.len); } break;
		case 'PageDown': e.preventDefault(); { const ms = ed.timing.measureOf(Math.max(0, ed.cursor - 1)); moveCursor(ed.cursor === ms.start + ms.len ? ms.start : ms.start); } break;
		case 'Home': moveCursor(0); break;
		case 'End': moveCursor(ed.chartEndTick()); break;
		case '[': changeDiv(-1); break;
		case ']': changeDiv(1); break;
		case '+': case '=': zoomBy(1.25); break;
		case '-': case '_': zoomBy(0.8); break;
		case 'm': case 'M': toggleMetro(); break;
		case 'h': case 'H': toggleHits(); break;
		case 'p': case 'P': togglePreview(); break;
	}
});
function changeDiv(d) { const i = DIVS.indexOf(ed.div); ed.div = DIVS[K.clamp((i < 0 ? 7 : i) + d, 0, DIVS.length - 1)]; buildOptbar(); toast('Grid 1/' + ed.div); ed.requestDraw(); }

// keep Space / arrow keys for the editor: don't leave focus on buttons and toolbar selects
document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.closest('#popover') && !b.closest('#modal')) { b.blur(); cv.focus({ preventScroll: true }); } });
document.addEventListener('change', (e) => { if (e.target.closest('#optbar, #transport') && e.target.type !== 'text') { e.target.blur(); cv.focus({ preventScroll: true }); } });

// drag & drop
const wrap = $('#app');
let dragDepth = 0;
wrap.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#timelineWrap').classList.add('drop'); });
wrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#timelineWrap').classList.remove('drop'); } });
wrap.addEventListener('dragover', (e) => e.preventDefault());
wrap.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#timelineWrap').classList.remove('drop'); const f = [...e.dataTransfer.files]; if (f.length) openFiles(f); });
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) closeModal(); });

// ---------------------------------------------------------------- events from editor
let tabTimer = 0;
ed.on('change', () => { updateTitle(); clearTimeout(tabTimer); tabTimer = setTimeout(() => { if (!ed.drag) { buildTabs(); renderTab(); } }, 90); });
ed.on('select', () => { if (ed.sel.size && currentTab !== 'props' && currentTab !== 'settings') { currentTab = 'props'; buildTabs(); } if (currentTab === 'props') renderTab(true); });
ed.on('play', () => { lastTr = ''; updateTransport(); });
ed.on('loaded', () => { updateTitle(); buildTabs(); renderTab(true); buildOptbar(); });

// ---------------------------------------------------------------- main loop
new ResizeObserver(() => { tl.resize(); ed.requestDraw(); }).observe($('#timelineWrap'));
new ResizeObserver(() => { pv.resize(); ed.requestDraw(); }).observe($('#previewPane'));
let previewFrames = 0;
const perf = { frames: 0, worst: 0, sum: 0 };
function frame() {
	if (ed.playing) {
		const s = ed.audio.songTimeNow();
		if (s !== null) ed.playTick = ed.tickOfSong(s);
		ed.scheduleHits();
		if (ed.settings.follow && !ed.drag) tl.bottomTick = ed.playTick - (tl.h * 0.2) / tl.ppt;
		const endT = Math.max(ed.chartEndTick() + 960, ed.audio.buffer ? ed.tickOfSong(ed.audio.duration) : 0);
		if (ed.playTick > endT) ed.pause();
		ed.needDraw = true;
	}
	if (ed.needDraw) {
		const t0 = performance.now();
		ed.needDraw = false;
		tl.draw();
		if (ed.settings.showPreview) { pv.draw(ed.playing ? ed.playTick : ed.cursor, ed.playing); previewFrames = 30; }
		updateTransport();
		const dt = performance.now() - t0; perf.frames++; perf.sum += dt; perf.worst = Math.max(perf.worst, dt);
	} else if (previewFrames > 0 && ed.settings.showPreview) { previewFrames--; pv.draw(ed.cursor); }
	requestAnimationFrame(frame);
}
setInterval(() => ed.scheduleHits(), 20);

// ---------------------------------------------------------------- boot
buildMenus(); buildToolbox(); buildOptbar(); buildTransport(); buildTabs(); syncSpeedUI();
$('#previewPane').classList.toggle('hidden', !ed.settings.showPreview);
(() => {
	const a = readAutosave();
	if (a && a.ksh && a.ksh.length > 300) {
		autosaveBanner = h('div', { class: 'banner' }, 'Unsaved chart "' + a.name + '" from ' + new Date(a.time).toLocaleString() + ' was found. ',
			h('div', { class: 'btns' }, h('button', { class: 'on', onclick: restoreAutosave }, 'Restore'), h('button', { onclick: () => { autosaveBanner = null; clearAutosave(); renderTab(true); } }, 'Dismiss')));
	}
})();
renderTab(true); updateTitle();
requestAnimationFrame(() => { tl.resize(); pv.resize(); tl.bottomTick = -tl.h * 0.15 / tl.ppt; ed.requestDraw(); frame(); });
window.KSMEditor = { ed, tl, pv, perf, K }; // for debugging / tests
