/* ============================================================================
 * Editor: chart state, undo/redo, selection, clipboard, tools and timeline input.
 * Items in the chart are treated as immutable: edits replace objects (same id),
 * so undo snapshots (KSMCore.cloneChart) can share unchanged items.
 * ========================================================================== */
const TOOLS = [
	{ id: 'select', key: '1', label: 'Select / move', icon: '<path d="M5 3l13 8-6 1.5L9 19z" fill="currentColor"/>' },
	{ id: 'bt', key: '2', label: 'BT notes (white): click = chip, drag = hold', icon: '<rect x="4" y="5" width="16" height="5" rx="1" fill="#f2f2f2"/><rect x="8" y="12" width="8" height="8" rx="1" fill="#f2f2f2" opacity=".6"/>' },
	{ id: 'fx', key: '3', label: 'FX notes (orange): click = chip, drag = hold', icon: '<rect x="2" y="5" width="20" height="5" rx="1" fill="#ff9a1f"/><rect x="5" y="12" width="14" height="8" rx="1" fill="#ff9a1f" opacity=".6"/>' },
	{ id: 'laserL', key: '4', label: 'Left laser (blue): drag to draw, drag sideways = slam', icon: '<path d="M5 21L9 13L9 9L18 3" stroke="#2fb8ff" stroke-width="3.5" fill="none" stroke-linejoin="round"/>' },
	{ id: 'laserR', key: '5', label: 'Right laser (pink): drag to draw, drag sideways = slam', icon: '<path d="M19 21L15 13L15 9L6 3" stroke="#ff3d9a" stroke-width="3.5" fill="none" stroke-linejoin="round"/>' },
];
const DIVS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 192];
const LASER_SNAPS = [{ v: 1, label: '51 (fine)' }, { v: 5, label: '11 (1/10)' }, { v: 10, label: '6 (1/5)' }, { v: 25, label: '3 (1/2)' }];
const CAM_STEP = { zoom_top: 5, zoom_bottom: 5, zoom_side: 5, center_split: 5, rotation_deg: 5, scroll_speed: 0.05, tilt: 0.05 };

const DEFAULT_SETTINGS = {
	laneW: 42, showWave: true, showPreview: true, rate: 1, follow: true,
	speedMode: 'mod', modSpeed: 800, hiSpeed: 5, drawOffsetMs: 0, previewW: 340,
	volMusic: 0.8, volHit: 0.55, volMetro: 0, hitsounds: true, latencyMs: 0, autosave: true, placeSound: false,
	cols: { zoom_top: true, zoom_bottom: true, zoom_side: true, tilt: true, rotation_deg: true, center_split: false, scroll_speed: false },
};

class Editor {
	constructor() {
		this.settings = loadJSON('ksmed.settings', DEFAULT_SETTINGS);
		this.settings.cols = Object.assign({}, DEFAULT_SETTINGS.cols, this.settings.cols || {});
		this.chart = K.newChart();
		this.timing = new K.Timing(this.chart);
		this.version = 1;
		this.undoStack = []; this.redoStack = [];
		this.sel = new Set();
		this.tool = 'bt'; this.div = 16; this.laserSnap = 5;
		this.fxEffect = ''; this.newWide = false; this.newCurve = 'linear';
		this.cursor = 0; this.playing = false; this.playTick = 0; this.playStartTick = 0;
		this.audio = new AudioEngine();
		this.drag = null; this.hover = null; this.mouse = null; this.ghost = null;
		this.dirty = false; this.fileName = 'untitled.ksh'; this.fileHandle = null; this.dirHandle = null;
		this.clipboard = null;
		this._ev = {};
		this.needDraw = true;
		this.applyAudioSettings();
	}
	on(name, fn) { (this._ev[name] = this._ev[name] || []).push(fn); }
	emit(name, ...a) { for (const f of this._ev[name] || []) f(...a); }
	requestDraw() { this.needDraw = true; }
	saveSettings() { saveJSON('ksmed.settings', this.settings); }
	applyAudioSettings() {
		const s = this.settings;
		this.audio.vol = { music: s.volMusic, hit: s.hitsounds ? s.volHit : 0, metro: s.volMetro };
		this.audio.userLatency = (s.latencyMs || 0) / 1000;
		this.audio.applyVolumes();
	}
	offsetSec() { return (parseInt(this.chart.meta.o, 10) || 0) / 1000; }
	songTimeOf(t) { return this.timing.tickToSec(t) + this.offsetSec(); }
	tickOfSong(s) { return this.timing.secToTick(s - this.offsetSec()); }
	get step() { return 960 / this.div; }

	// ---------------------------------------------------------------- history
	begin() { if (!this._snap) this._snap = K.cloneChart(this.chart); }
	commit(label) {
		if (!this._snap) return;
		this.undoStack.push({ chart: this._snap, sel: [...this.sel], label });
		if (this.undoStack.length > 400) this.undoStack.shift();
		this.redoStack = [];
		this._snap = null;
		this.changed();
	}
	cancel() { if (this._snap) { this.chart = this._snap; this._snap = null; this.changed(false); } }
	edit(label, fn) { this.begin(); const r = fn(this.chart); this.commit(label); return r; }
	changed(markDirty = true) {
		this.version++;
		this.timing.rebuild(this.chart);
		if (markDirty) this.dirty = true;
		this.hitsDirty = true;
		this.requestDraw();
		this.emit('change');
	}
	undo() {
		if (this.drag) return;
		const u = this.undoStack.pop(); if (!u) return;
		this.redoStack.push({ chart: this.chart, sel: [...this.sel], label: u.label });
		this.chart = u.chart; this.sel = new Set(u.sel); this.changed(); this.emit('select'); toast('Undo: ' + u.label);
	}
	redo() {
		if (this.drag) return;
		const r = this.redoStack.pop(); if (!r) return;
		this.undoStack.push({ chart: this.chart, sel: [...this.sel], label: r.label });
		this.chart = r.chart; this.sel = new Set(r.sel); this.changed(); this.emit('select'); toast('Redo: ' + r.label);
	}
	loadChart(chart, name) {
		this.stop();
		this.chart = chart; this.undoStack = []; this.redoStack = []; this.sel.clear();
		this.fileName = name || 'untitled.ksh'; this.cursor = 0;
		this.changed(false); this.dirty = false;
		this.emit('select'); this.emit('loaded');
	}

	// ---------------------------------------------------------------- lookup
	index() {
		if (this._idxVer === this.version && this._idx) return this._idx;
		const m = new Map(), c = this.chart;
		c.bt.forEach((lane, li) => lane.forEach(n => m.set(n.id, { kind: 'bt', lane: li, item: n })));
		c.fx.forEach((lane, li) => lane.forEach(n => m.set(n.id, { kind: 'fx', lane: li, item: n })));
		c.laser.forEach((lane, li) => lane.forEach(s => {
			m.set(s.id, { kind: 'sec', lane: li, item: s });
			s.pts.forEach((p, pi) => m.set(p.id, { kind: 'lpt', lane: li, sec: s, idx: pi, item: p }));
		}));
		for (const k of K.CAM_KEYS) c.cam[k].forEach(p => m.set(p.id, { kind: 'cam', key: k, item: p }));
		c.tilt.forEach(p => m.set(p.id, { kind: 'cam', key: 'tilt', item: p }));
		c.bpm.forEach(b => m.set(b.id, { kind: 'bpm', item: b }));
		c.stops.forEach(b => m.set(b.id, { kind: 'stop', item: b }));
		c.sig.forEach(b => m.set(b.id, { kind: 'sig', item: b }));
		c.spins.forEach(b => m.set(b.id, { kind: 'spin', item: b }));
		this._idx = m; this._idxVer = this.version;
		return m;
	}
	selected() { const idx = this.index(); return [...this.sel].map(id => idx.get(id)).filter(Boolean); }
	camArr(key, c = this.chart) { return key === 'tilt' ? c.tilt : c.cam[key]; }
	setCamArr(key, arr, c = this.chart) { if (key === 'tilt') c.tilt = arr; else c.cam[key] = arr; }
	replaceIn(arr, id, obj) { const i = arr.findIndex(e => e.id === id); if (i >= 0) arr[i] = obj; return i; }
	removeId(arr, id) { const i = arr.findIndex(e => e.id === id); if (i >= 0) arr.splice(i, 1); }

	// ---------------------------------------------------------------- snapping
	snapT(t, noSnap) { return noSnap ? Math.max(0, Math.round(t)) : this.timing.snap(t, this.div); }
	snapV(v, noSnap) { const s = noSnap ? 1 : this.laserSnap; return K.clamp(Math.round(v / s) * s, 0, 50); }
	snapCam(key, v, fine) { const s = CAM_STEP[key] * (fine ? 0.2 : 1); return Math.round(v / s) * s; }

	// ---------------------------------------------------------------- hit testing
	hitTrack(x, y, tool = this.tool) {
		const tv = this.tl, c = this.chart, L = tv.laneW;
		const t = tv.tickAt(y);
		const tol = 7 / tv.ppt;
		const laserLanes = tool === 'laserL' ? [0] : tool === 'laserR' ? [1] : tool === 'select' ? [1, 0] : [];
		// laser handles
		for (const lane of laserLanes) {
			const arr = c.laser[lane];
			for (let i = K.upperBound(arr, t + tol) - 1; i >= 0; i--) {
				const s = arr[i];
				if (K.sectionEndTick(s) < t - tol) { if (s.t < t - 960 * 64) break; continue; }
				for (let k = s.pts.length - 1; k >= 0; k--) {
					const p = s.pts[k], py = tv.yOf(s.t + p.ry);
					if (Math.abs(py - y) > 7) continue;
					if (p.v !== p.vf && Math.abs(tv.laserX(p.vf) - x) <= 7) return { kind: 'lpt', lane, sec: s, idx: k, item: p, which: 'vf' };
					if (Math.abs(tv.laserX(p.v) - x) <= 7) return { kind: 'lpt', lane, sec: s, idx: k, item: p, which: 'v' };
				}
			}
		}
		const inBT = tool === 'select' || tool === 'bt', inFX = tool === 'select' || tool === 'fx';
		const noteHit = (arr, x0, w, kind, lane) => {
			if (x < x0 || x > x0 + w) return null;
			const i1 = K.upperBound(arr, t + 12 / tv.ppt);
			for (let i = i1 - 1; i >= 0 && i >= i1 - 6; i--) {
				const n = arr[i], y0 = tv.yOf(n.t);
				if (n.l === 0) { if (y >= y0 - 10 && y <= y0 + 3) return { kind, lane, item: n }; }
				else {
					const y1 = tv.yOf(n.t + n.l);
					if (Math.abs(y - y1) <= 5) return { kind, lane, item: n, which: 'end' };
					if (y >= y1 && y <= y0 + 3) return { kind, lane, item: n };
				}
			}
			return null;
		};
		if (inBT) for (let lane = 0; lane < 4; lane++) { const h = noteHit(c.bt[lane], tv.btL(lane), L, 'bt', lane); if (h) return h; }
		if (inFX) for (let lane = 0; lane < 2; lane++) { const h = noteHit(c.fx[lane], tv.fxL(lane), L * 2, 'fx', lane); if (h) return h; }
		// laser bodies
		for (const lane of laserLanes) {
			const arr = c.laser[lane], i = K.upperBound(arr, t) - 1;
			if (i < 0) continue;
			const s = arr[i];
			for (let k = 0; k < s.pts.length; k++) {
				const p = s.pts[k], q = s.pts[k + 1], tp = s.t + p.ry;
				if (p.v !== p.vf) { const yy = tv.yOf(tp), x0 = tv.laserX(Math.min(p.v, p.vf)) - L * 0.3, x1 = tv.laserX(Math.max(p.v, p.vf)) + L * 0.3; if (y <= yy + 2 && y >= yy - 12 && x >= x0 && x <= x1) return { kind: 'lslam', lane, sec: s, idx: k, item: p }; }
				if (!q) continue;
				const tq = s.t + q.ry;
				if (t >= tp && t <= tq) {
					const v = K.laserValueAt(s, t);
					if (v !== null && Math.abs(tv.laserX(v) - x) <= L * 0.32) return { kind: 'lseg', lane, sec: s, idx: k, item: p };
				}
			}
		}
		return null;
	}
	hitCam(col, x, y) {
		const tv = this.tl, arr = this.camArr(col.key);
		const t = tv.tickAt(y), tol = 8 / tv.ppt;
		const i1 = K.upperBound(arr, t + tol);
		for (let i = i1 - 1; i >= 0; i--) {
			const p = arr[i]; if (p.t < t - tol) break;
			const px = typeof p.v === 'number' ? tv.colX(col, p.v) : (col.l + col.r) / 2;
			if (Math.abs(tv.yOf(p.t) - y) <= 7 && Math.abs(px - x) <= 9) return { kind: 'cam', key: col.key, item: p };
			if (Math.abs(tv.yOf(p.t) - y) <= 7 && typeof p.vf === 'number' && Math.abs(tv.colX(col, p.vf) - x) <= 7) return { kind: 'cam', key: col.key, item: p };
		}
		return null;
	}
	hitTiming(x, y) {
		const tv = this.tl, c = this.chart;
		const near = (t) => Math.abs(tv.yOf(t) - (y + 6)) <= 9 || Math.abs(tv.yOf(t) - y) <= 6;
		for (const b of c.bpm) if (near(b.t)) return { kind: 'bpm', item: b };
		for (const s of c.sig) if (near(this.timing.measureStart(s.m))) return { kind: 'sig', item: s };
		for (const s of c.stops) { if (near(s.t)) return { kind: 'stop', item: s }; }
		return null;
	}
	hitSpin(x, y) {
		const tv = this.tl;
		if (x < tv.trackR - 80 || x > tv.trackR + 2) return null;
		for (const s of this.chart.spins) if (Math.abs(tv.yOf(s.t) - 1 - y) <= 7) return { kind: 'spin', item: s };
		return null;
	}

	// ---------------------------------------------------------------- pointer input
	pointerDown(e) {
		const tv = this.tl, x = e.offsetX, y = e.offsetY;
		this.mouse = { x, y };
		// pointer events have no click count, so detect double clicks ourselves
		const now = performance.now(), lc = this._lastClick;
		const dbl = e.button === 0 && lc && now - lc.t < 380 && Math.abs(lc.x - x) < 6 && Math.abs(lc.y - y) < 6;
		this._lastClick = dbl ? null : { t: now, x, y };
		if (y < tv.HEAD) return;
		const reg = tv.region(x);
		const shift = e.shiftKey, ctrl = e.ctrlKey || e.metaKey, alt = e.altKey;
		if (e.button === 2) { this.deleteAt(x, y, reg); return; }
		if (e.button === 1) { this.drag = { type: 'pan', y0: y, b0: tv.bottomTick }; return; }
		if (e.button !== 0) return;
		const t = tv.tickAt(y);
		if (reg.kind === 'gutter' || reg.kind === 'wave') { this.drag = { type: 'scrub' }; this.scrubTo(t, alt); return; }
		if (reg.kind === 'timing') {
			const h = this.hitTiming(x, y);
			if (h) {
				this.setSel([h.item.id], shift || ctrl);
				if (dbl) { this.editTimingItem(h, e.clientX, e.clientY); return; }
				if (h.kind !== 'sig' && !(h.kind === 'bpm' && h.item.t === 0)) this.startDrag({ type: 'tmove', hit: h, t0: h.item.t, y0: y });
			} else this.addTimingPopover(this.snapT(t, alt), e.clientX, e.clientY);
			return;
		}
		if (reg.kind === 'cam') {
			const h = this.hitCam(reg.col, x, y);
			if (h) {
				if (dbl) { this.editCamPopover(h.key, h.item, e.clientX, e.clientY); return; }
				if (!this.sel.has(h.item.id) || !(shift || ctrl)) this.setSel([h.item.id], shift || ctrl);
				this.startDrag({ type: 'cmove', key: h.key, id: h.item.id, col: reg.col, x0: x, y0: y, t0: h.item.t, v0: h.item.v, moved: false });
			} else {
				const tt = this.snapT(t, alt);
				const existing = K.findAt(this.camArr(reg.key), tt);
				if (existing) { this.setSel([existing.id]); return; }
				this.begin();
				const v = this.snapCam(reg.key, tv.colV(reg.col, x), alt);
				const p = { id: K.nid(), t: tt, v, a: 0, b: 0 };
				const arr = this.camArr(reg.key).slice(); K.insertSorted(arr, p); this.setCamArr(reg.key, arr);
				this.sel = new Set([p.id]);
				this.drag = { type: 'cmove', key: reg.key, id: p.id, col: reg.col, x0: x, y0: y, t0: tt, v0: v, created: true, label: 'Add ' + COL_INFO[reg.key].label + ' keyframe' };
				this.changed(); this.emit('select');
				this._snapDrag = K.cloneChart(this.chart);
			}
			return;
		}
		if (reg.kind !== 'track') return;
		const sp = this.tool === 'select' ? this.hitSpin(x, y) : null;
		if (sp) { this.setSel([sp.item.id], shift || ctrl); return; }
		const hit = this.hitTrack(x, y);
		const tool = this.tool;
		if (tool === 'select') {
			if (hit) {
				if ((hit.kind === 'bt' || hit.kind === 'fx') && hit.which === 'end') { this.setSel([hit.item.id]); this.startDrag({ type: 'resize', hit, y0: y }); return; }
				const ids = hit.kind === 'lseg' || hit.kind === 'lslam' ? hit.sec.pts.map(p => p.id) : [hit.item.id];
				if (shift || ctrl) { this.toggleSel(ids); return; }
				if (!ids.every(id => this.sel.has(id))) this.setSel(ids);
				this.startDrag({ type: 'move', x0: x, y0: y, anchor: hit, alt });
			} else {
				if (!shift && !ctrl) this.setSel([]);
				this.drag = { type: 'marquee', x0: x, y0: y, x1: x, y1: y, add: shift || ctrl, base: new Set(this.sel) };
			}
			return;
		}
		if (tool === 'bt' || tool === 'fx') {
			if (hit) {
				this.setSel([hit.item.id]);
				if (hit.which === 'end') this.startDrag({ type: 'resize', hit, y0: y });
				else this.startDrag({ type: 'move', x0: x, y0: y, anchor: hit, alt });
				return;
			}
			const lane = this.laneAtX(x, tool);
			if (lane < 0) return;
			const t0 = this.snapT(t, alt);
			this.drag = { type: 'place', kind: tool, lane, t0, t1: t0, alt };
			this.updateGhost();
			return;
		}
		if (tool === 'laserL' || tool === 'laserR') {
			const lane = tool === 'laserL' ? 0 : 1;
			if (hit && hit.kind === 'lpt') {
				const last = hit.idx === hit.sec.pts.length - 1;
				if (last && !alt && hit.which === (hit.item.v !== hit.item.vf ? 'vf' : 'v')) {
					this.setSel([hit.item.id]);
					this.drag = { type: 'lextend', lane, secId: hit.sec.id, t0: hit.sec.t + hit.item.ry, v0: hit.item.vf, t1: hit.sec.t + hit.item.ry, v1: hit.item.vf, alt };
					this.updateGhost();
				} else {
					this.setSel([hit.item.id]);
					this.startDrag({ type: 'lmove', lane, secId: hit.sec.id, ptId: hit.item.id, which: hit.which, x0: x, y0: y });
				}
				return;
			}
			if (hit && (hit.kind === 'lseg')) { // insert a point on the segment and drag it
				const tt = this.snapT(t, alt);
				const s = hit.sec, ry = tt - s.t;
				if (s.pts.some(p => p.ry === ry) || ry <= 0 || ry >= s.pts[s.pts.length - 1].ry) { this.setSel(s.pts.map(p => p.id)); return; }
				this.begin();
				const v = Math.round(K.laserValueAt(s, tt));
				const np = { id: K.nid(), ry, v, vf: v, a: 0, b: 0 };
				const pts = s.pts.slice(); pts.splice(pts.findIndex(p => p.ry > ry), 0, np);
				const ns = { ...s, pts };
				this.replaceIn(this.chart.laser[lane], s.id, ns);
				this.changed(); this.sel = new Set([np.id]); this.emit('select');
				this.drag = { type: 'lmove', lane, secId: s.id, ptId: np.id, which: 'v', x0: x, y0: y, label: 'Add laser point' };
				this._snapDrag = K.cloneChart(this.chart);
				return;
			}
			if (hit && hit.kind === 'lslam') { this.setSel([hit.item.id]); return; }
			const t0 = this.snapT(t, alt), v0 = this.snapV(tv.vAtX(x), alt);
			this.drag = { type: 'lnew', lane, t0, v0, t1: t0, v1: v0, alt };
			this.updateGhost();
		}
	}
	startDrag(d) {
		this.begin();
		this._snapDrag = K.cloneChart(this.chart);
		this.drag = d;
	}
	laneAtX(x, kind) {
		const tv = this.tl;
		if (kind === 'bt') { for (let i = 0; i < 4; i++) if (x >= tv.btL(i) && x < tv.btL(i) + tv.laneW) return i; return -1; }
		if (x >= tv.fxL(0) && x < tv.fxL(0) + tv.laneW * 2) return 0;
		if (x >= tv.fxL(1) && x < tv.fxL(1) + tv.laneW * 2) return 1;
		return -1;
	}
	pointerMove(e) {
		const tv = this.tl, x = e.offsetX, y = e.offsetY;
		this.mouse = { x, y, alt: e.altKey, shift: e.shiftKey };
		const d = this.drag;
		if (!d) { this.updateHover(); this.updateGhost(); this.requestDraw(); return; }
		const t = tv.tickAt(y), alt = e.altKey;
		switch (d.type) {
			case 'pan': tv.bottomTick = d.b0 + (y - d.y0) / tv.ppt; break;
			case 'scrub': this.scrubTo(t, alt); break;
			case 'marquee': {
				d.x1 = x; d.y1 = y;
				const ids = this.idsInRect(Math.min(d.x0, x), Math.min(d.y0, y), Math.max(d.x0, x), Math.max(d.y0, y));
				this.sel = d.add ? new Set([...d.base, ...ids]) : new Set(ids);
				break;
			}
			case 'place': d.t1 = this.snapT(t, alt); this.updateGhost(); break;
			case 'lnew': d.t1 = this.snapT(t, alt); d.v1 = this.snapV(tv.vAtX(x), alt); this.updateGhost(); break;
			case 'lextend': d.t1 = Math.max(d.t0, this.snapT(t, alt)); d.v1 = this.snapV(tv.vAtX(x), alt); this.updateGhost(); break;
			case 'move': this.applyMove(x, y, e); break;
			case 'resize': this.applyResize(y, alt); break;
			case 'lmove': this.applyLaserPointMove(x, y, alt); break;
			case 'cmove': this.applyCamMove(x, y, alt, e.shiftKey); break;
			case 'tmove': this.applyTimingMove(y, alt); break;
		}
		this.requestDraw();
	}
	pointerUp(e) {
		const d = this.drag; if (!d) return;
		this.drag = null; this.ghost = null;
		switch (d.type) {
			case 'place': this.commitPlace(d); break;
			case 'lnew': this.commitLaserNew(d); break;
			case 'lextend': this.commitLaserExtend(d); break;
			case 'marquee': this.emit('select'); break;
			case 'move': case 'resize': case 'lmove': case 'cmove': case 'tmove':
				if (d.moved || d.created || d.label) this.commit(d.label || ({ move: 'Move', resize: 'Resize hold', lmove: 'Move laser point', cmove: 'Move keyframe', tmove: 'Move timing event' })[d.type]);
				else this.cancelSnapOnly();
				this.emit('select');
				break;
		}
		this.requestDraw();
	}
	cancelSnapOnly() { this._snap = null; }
	cancelDrag() {
		const d = this.drag; if (!d) return;
		this.drag = null; this.ghost = null;
		if (this._snap && ['move', 'resize', 'lmove', 'cmove', 'tmove'].includes(d.type)) this.cancel();
		this.requestDraw();
	}

	scrubTo(t, noSnap) {
		const nt = this.snapT(t, noSnap);
		if (this.playing) this.pause();
		this.cursor = nt; this.emit('cursor'); this.requestDraw();
	}

	updateHover() {
		const m = this.mouse; if (!m) return;
		const tv = this.tl, reg = tv.region(m.x);
		let h = null;
		if (reg.kind === 'track' && m.y > tv.HEAD) h = this.hitTrack(m.x, m.y);
		else if (reg.kind === 'cam') h = this.hitCam(reg.col, m.x, m.y);
		else if (reg.kind === 'timing') h = this.hitTiming(m.x, m.y);
		this.hover = h;
		let cur = 'default';
		if (reg.kind === 'gutter' || reg.kind === 'wave') cur = 'ns-resize';
		else if (h && h.which === 'end') cur = 'ns-resize';
		else if (h) cur = this.tool === 'laserL' || this.tool === 'laserR' ? (h.kind === 'lseg' ? 'copy' : 'move') : 'pointer';
		else if (reg.kind === 'track' && this.tool !== 'select') cur = 'crosshair';
		else if (reg.kind === 'cam' || reg.kind === 'timing') cur = 'cell';
		this.tl.cv.style.cursor = cur;
	}
	updateGhost() {
		const d = this.drag, tv = this.tl, m = this.mouse;
		this.ghost = null;
		if (d) {
			if (d.type === 'place') { const s = Math.min(d.t0, d.t1), e = Math.max(d.t0, d.t1); this.ghost = { kind: d.kind, lane: d.lane, t: s, l: e - s >= this.step * 0.99 ? e - s : 0 }; }
			else if (d.type === 'lnew' || d.type === 'lextend') this.ghost = { kind: 'laser', lane: d.lane, t0: d.t0, v0: d.v0, t1: d.t1, v1: d.v1 };
			return;
		}
		if (!m || m.y < tv.HEAD || tv.region(m.x).kind !== 'track' || this.hover) return;
		const t = this.snapT(tv.tickAt(m.y), m.alt);
		if (this.tool === 'bt' || this.tool === 'fx') { const lane = this.laneAtX(m.x, this.tool); if (lane >= 0) this.ghost = { kind: this.tool, lane, t, l: 0, hover: true }; }
		else if (this.tool === 'laserL' || this.tool === 'laserR') this.ghost = { kind: 'lpoint', lane: this.tool === 'laserL' ? 0 : 1, t, v: this.snapV(tv.vAtX(m.x), m.alt) };
	}

	// ---------------------------------------------------------------- overlay drawing
	drawOverlay(c, tv) {
		const g = this.ghost, L = tv.laneW;
		if (g) {
			c.globalAlpha = g.hover ? 0.35 : 0.6;
			if (g.kind === 'bt') {
				const x = tv.btL(g.lane);
				if (g.l > 0) { const y0 = tv.yOf(g.t), y1 = tv.yOf(g.t + g.l); c.fillStyle = '#e8e8ee'; c.fillRect(x + 7, y1, L - 14, y0 - y1); }
				c.fillStyle = '#ffffff'; c.fillRect(x + 3, tv.yOf(g.t) - 7, L - 6, 7);
			} else if (g.kind === 'fx') {
				const x = tv.fxL(g.lane);
				if (g.l > 0) { const y0 = tv.yOf(g.t), y1 = tv.yOf(g.t + g.l); c.fillStyle = '#ff9a1f'; c.fillRect(x + 3, y1, L * 2 - 6, y0 - y1); }
				c.fillStyle = '#ff9a1f'; c.fillRect(x + 3, tv.yOf(g.t) - 9, L * 2 - 6, 9);
			} else if (g.kind === 'laser' || g.kind === 'lpoint') {
				const col = g.lane ? '#ff3d9a' : '#2fb8ff';
				c.strokeStyle = col; c.fillStyle = col; c.lineWidth = L * 0.5;
				if (g.kind === 'laser') {
					const isSlam = g.t1 === g.t0 || (g.t1 - g.t0 <= K.SLAM_LEN && g.v1 !== g.v0);
					c.beginPath();
					if (isSlam) { const y = tv.yOf(g.t0); c.moveTo(tv.laserX(g.v0), y - 4); c.lineTo(tv.laserX(g.v1), y - 4); }
					else { c.moveTo(tv.laserX(g.v0), tv.yOf(g.t0)); c.lineTo(tv.laserX(g.v1), tv.yOf(g.t1)); }
					c.stroke();
					c.globalAlpha = 1; c.fillStyle = '#fff'; c.font = '11px ' + UI_FONT; c.textBaseline = 'bottom';
					c.fillText((isSlam ? 'slam ' : '') + g.v1 + '/50' + (g.t1 > g.t0 ? '  ' + fmtLen(g.t1 - g.t0) : ''), tv.laserX(g.v1) + 10, tv.yOf(g.t1) - 4);
				} else {
					const x = tv.laserX(g.v), y = tv.yOf(g.t);
					c.fillRect(x - 5, y - 5, 10, 10);
				}
				c.lineWidth = 1;
			}
			c.globalAlpha = 1;
		}
		const h = this.hover;
		if (h && !this.drag) {
			c.strokeStyle = 'rgba(127,228,255,0.85)'; c.lineWidth = 1.5;
			if (h.kind === 'bt' || h.kind === 'fx') {
				const n = h.item, x = h.kind === 'bt' ? tv.btL(h.lane) : tv.fxL(h.lane), w = h.kind === 'bt' ? L : L * 2;
				const y0 = tv.yOf(n.t), y1 = n.l ? tv.yOf(n.t + n.l) : y0 - 10;
				if (h.which === 'end') { c.beginPath(); c.moveTo(x + 2, y1); c.lineTo(x + w - 2, y1); c.stroke(); }
				else c.strokeRect(x + 1.5, y1 - 1, w - 3, y0 - y1 + 3);
			} else if (h.kind === 'lpt') {
				const xx = tv.laserX(h.which === 'vf' ? h.item.vf : h.item.v), y = tv.yOf(h.sec.t + h.item.ry);
				c.strokeRect(xx - 7, y - 7, 14, 14);
				const last = h.idx === h.sec.pts.length - 1;
				if (last && (this.tool === 'laserL' || this.tool === 'laserR')) { c.fillStyle = '#fff'; c.font = '10px ' + UI_FONT; c.fillText('drag to extend', xx + 10, y - 8); }
			}
			c.lineWidth = 1;
		}
		const d = this.drag;
		if (d && d.type === 'marquee') {
			c.fillStyle = 'rgba(58,167,208,0.12)'; c.strokeStyle = '#3aa7d0';
			const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1);
			c.fillRect(x0, y0, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); c.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
		}
		// hover tick guide
		const m = this.mouse;
		if (m && m.y > tv.HEAD && !this.playing && tv.region(m.x).kind !== 'none') {
			const t = this.snapT(tv.tickAt(m.y), m.alt), y = Math.round(tv.yOf(t)) + 0.5;
			c.strokeStyle = 'rgba(255,255,255,0.12)'; c.beginPath(); c.moveTo(tv.waveL, y); c.lineTo(tv.w, y); c.stroke();
			const ms = this.timing.measureOf(t);
			c.fillStyle = '#7fe4ff'; c.font = '10px ' + UI_FONT; c.textBaseline = 'bottom'; c.textAlign = 'right';
			c.fillText(posLabel(this.timing, t, this.div), tv.gutterR - 3, y - 13);
			c.textAlign = 'left';
		}
	}

	idsInRect(x0, y0, x1, y1) {
		const tv = this.tl, c = this.chart, ids = [], L = tv.laneW;
		const tA = tv.tickAt(y1), tB = tv.tickAt(y0);
		const rectHit = (nx0, nx1, t, l) => nx1 >= x0 && nx0 <= x1 && t <= tB && t + l >= tA;
		c.bt.forEach((lane, i) => { const x = tv.btL(i); for (const n of lane) if (rectHit(x, x + L, n.t, n.l)) ids.push(n.id); });
		c.fx.forEach((lane, i) => { const x = tv.fxL(i); for (const n of lane) if (rectHit(x, x + L * 2, n.t, n.l)) ids.push(n.id); });
		c.laser.forEach(lane => { for (const s of lane) for (const p of s.pts) { const t = s.t + p.ry, px = tv.laserX(p.v); if (t >= tA && t <= tB && px >= x0 && px <= x1) ids.push(p.id); } });
		for (const col of tv.cols) {
			if (col.r < x0 || col.l > x1) continue;
			for (const p of this.camArr(col.key)) if (p.t >= tA && p.t <= tB) ids.push(p.id);
		}
		return ids;
	}
	setSel(ids, add) { if (add) for (const id of ids) this.sel.add(id); else this.sel = new Set(ids); this.emit('select'); this.requestDraw(); }
	toggleSel(ids) { const all = ids.every(id => this.sel.has(id)); for (const id of ids) all ? this.sel.delete(id) : this.sel.add(id); this.emit('select'); this.requestDraw(); }

	// ---------------------------------------------------------------- placing notes
	// Remove notes that a new note at [t, t+l] would conflict with in KSH.
	// A chip exactly at a hold's end is fine (KSH ends the hold on that row).
	clearLaneSpan(arr, t, l, keepId) {
		for (let i = arr.length - 1; i >= 0; i--) {
			const n = arr[i]; if (n.id === keepId) continue;
			const a0 = n.t, a1 = n.t + n.l;
			let hit = a0 === t;
			if (!hit) {
				if (n.l === 0) hit = l > 0 && a0 > t && a0 < t + l;
				else if (l === 0) hit = t > a0 && t < a1;
				else hit = a0 < t + l && a1 > t;
			}
			if (hit) arr.splice(i, 1);
		}
	}
	commitPlace(d) {
		const s = Math.min(d.t0, d.t1), e = Math.max(d.t0, d.t1);
		const l = e - s >= this.step * 0.99 || (d.alt && e > s) ? e - s : 0;
		const lanes = d.kind === 'bt' ? this.chart.bt : this.chart.fx;
		this.begin();
		const arr = lanes[d.lane].slice();
		this.clearLaneSpan(arr, s, l);
		// avoid holds that touch end-to-start (they merge in KSH)
		const n = { id: K.nid(), t: s, l };
		if (d.kind === 'fx' && l > 0 && this.fxEffect) n.fx = this.fxEffect;
		K.insertSorted(arr, n);
		lanes[d.lane] = arr;
		this.sel = new Set([n.id]);
		this.commit((d.kind === 'bt' ? 'BT ' : 'FX ') + (l ? 'hold' : 'chip'));
		if (this.settings.placeSound) this.audio.click();
		this.emit('select');
	}
	applyResize(y, alt) {
		const d = this.drag, h = d.hit;
		this.chart = K.cloneChart(this._snapDrag);
		const lanes = h.kind === 'bt' ? this.chart.bt : this.chart.fx;
		const arr = lanes[h.lane];
		const n = arr.find(o => o.id === h.item.id); if (!n) return;
		let end = this.snapT(this.tl.tickAt(y), alt);
		let l = Math.max(0, end - n.t);
		const nx = arr[arr.indexOf(n) + 1];
		if (nx && n.t + l > nx.t) l = nx.t - n.t;
		const nn = { ...n, l };
		if (h.kind === 'fx' && l === 0) { delete nn.fx; }
		this.replaceIn(arr, n.id, nn);
		d.moved = l !== h.item.l;
		this.version++; this.timing.rebuild(this.chart);
	}

	// ---------------------------------------------------------------- moving selection
	applyMove(x, y, e) {
		const d = this.drag, tv = this.tl, base = this._snapDrag;
		const step = this.step;
		let dt = Math.round((tv.tickAt(y) - tv.tickAt(d.y0)) / step) * step;
		if (e.altKey) dt = Math.round(tv.tickAt(y) - tv.tickAt(d.y0));
		const a = d.anchor;
		let dLane = 0, dv = 0;
		if (a.kind === 'bt') dLane = Math.round((x - d.x0) / tv.laneW);
		else if (a.kind === 'fx') dLane = Math.round((x - d.x0) / (tv.laneW * 2));
		else if (a.kind === 'lpt' || a.kind === 'lseg' || a.kind === 'lslam') dv = Math.round((tv.vAtX(x) - tv.vAtX(d.x0)) / this.laserSnap) * this.laserSnap;
		const c = K.cloneChart(base);
		const idx = new Map();
		base.bt.forEach((l, i) => l.forEach(n => idx.set(n.id, ['bt', i])));
		base.fx.forEach((l, i) => l.forEach(n => idx.set(n.id, ['fx', i])));
		// clamp deltas for the whole group
		let minT = Infinity, minBt = 9, maxBt = -1, minFx = 9, maxFx = -1;
		for (const id of this.sel) {
			const r = idx.get(id); if (!r) continue;
			const n = (r[0] === 'bt' ? base.bt : base.fx)[r[1]].find(o => o.id === id);
			minT = Math.min(minT, n.t);
			if (r[0] === 'bt') { minBt = Math.min(minBt, r[1]); maxBt = Math.max(maxBt, r[1]); } else { minFx = Math.min(minFx, r[1]); maxFx = Math.max(maxFx, r[1]); }
		}
		if (a.kind === 'bt') dLane = K.clamp(dLane, -minBt, 3 - maxBt);
		if (a.kind === 'fx') dLane = K.clamp(dLane, -minFx, 1 - maxFx);
		if (minT !== Infinity && minT + dt < 0) dt = -minT;
		// notes
		const moved = [];
		for (const [kind, lanes] of [['bt', c.bt], ['fx', c.fx]]) {
			lanes.forEach((lane, li) => {
				for (let i = lane.length - 1; i >= 0; i--) {
					const n = lane[i];
					if (!this.sel.has(n.id)) continue;
					lane.splice(i, 1);
					moved.push([kind, li + ((kind === a.kind) ? dLane : 0), { ...n, t: n.t + dt }]);
				}
			});
		}
		for (const [kind, li, n] of moved) {
			const lane = (kind === 'bt' ? c.bt : c.fx)[li];
			K.insertSorted(lane, n);
		}
		// laser points / sections
		c.laser = c.laser.map(lane => {
			const out = lane.map(s => {
				const selPts = s.pts.filter(p => this.sel.has(p.id));
				if (!selPts.length) return s;
				if (selPts.length === s.pts.length) {
					return { ...s, t: Math.max(0, s.t + dt), pts: s.pts.map(p => ({ ...p, v: K.clamp(p.v + dv, 0, 50), vf: K.clamp(p.vf + dv, 0, 50) })) };
				}
				let pts = s.pts.map(p => this.sel.has(p.id) ? { ...p, ry: p.ry + dt, v: K.clamp(p.v + dv, 0, 50), vf: K.clamp(p.vf + dv, 0, 50) } : p);
				for (let i = 1; i < pts.length; i++) if (pts[i].ry <= pts[i - 1].ry) return s; // would reorder: ignore time move
				const off = pts[0].ry;
				return { ...s, t: s.t + off, pts: pts.map(p => ({ ...p, ry: p.ry - off })) };
			});
			return K.sortByT(out);
		});
		// camera keyframes
		for (const key of [...K.CAM_KEYS, 'tilt']) {
			const arr = this.camArr(key, c);
			if (!arr.some(p => this.sel.has(p.id))) continue;
			const others = arr.filter(p => !this.sel.has(p.id));
			const mv = arr.filter(p => this.sel.has(p.id)).map(p => ({ ...p, t: Math.max(0, p.t + dt) }));
			const taken = new Set(others.map(p => p.t));
			if (mv.some(p => taken.has(p.t))) continue;
			this.setCamArr(key, K.sortByT([...others, ...mv]), c);
		}
		this.chart = c;
		d.moved = dt !== 0 || dLane !== 0 || dv !== 0;
		this.version++; this.timing.rebuild(c);
		this.hitsDirty = true;
	}

	// ---------------------------------------------------------------- lasers
	sectionsOverlap(lane, t0, t1, ignoreId) {
		for (const s of this.chart.laser[lane]) {
			if (s.id === ignoreId) continue;
			if (t1 >= s.t && t0 <= K.sectionEndTick(s)) return s;
		}
		return null;
	}
	curvePreset() { const p = K.CURVE_PRESETS.find(c => c.id === this.newCurve) || K.CURVE_PRESETS[0]; return { a: p.a, b: p.b }; }
	commitLaserNew(d) {
		let { t0, v0, t1, v1 } = d;
		if (t1 < t0) [t0, v0, t1, v1] = [t1, v1, t0, v0];
		let pts;
		const cv = this.curvePreset();
		if (t1 === t0 || (t1 - t0 <= K.SLAM_LEN && v1 !== v0)) {
			if (v1 === v0) return;
			pts = [{ id: K.nid(), ry: 0, v: v0, vf: v1, a: 0, b: 0 }];
			t1 = t0;
		} else pts = [{ id: K.nid(), ry: 0, v: v0, vf: v0, ...cv }, { id: K.nid(), ry: t1 - t0, v: v1, vf: v1, a: 0, b: 0 }];
		const ov = this.sectionsOverlap(d.lane, t0, t1 + (pts.length === 1 ? K.SLAM_LEN : 0));
		if (ov) { toast('There is already a ' + (d.lane ? 'right' : 'left') + ' laser there. Drag from its end point to extend it.', true); return; }
		this.begin();
		const sec = { id: K.nid(), t: t0, wide: this.newWide, pts };
		const arr = this.chart.laser[d.lane].slice(); K.insertSorted(arr, sec); this.chart.laser[d.lane] = arr;
		this.sel = new Set([pts[pts.length - 1].id]);
		this.commit(pts.length === 1 ? 'Laser slam' : 'Laser');
		this.emit('select');
	}
	commitLaserExtend(d) {
		const arr = this.chart.laser[d.lane];
		const s = arr.find(o => o.id === d.secId); if (!s) return;
		const last = s.pts[s.pts.length - 1], tl = s.t + last.ry;
		const { t1, v1 } = d;
		let pts = s.pts.slice(), merged = null;
		if (t1 === tl || (t1 - tl <= K.SLAM_LEN && v1 !== last.vf)) {
			if (v1 === last.vf) return;
			pts[pts.length - 1] = { ...last, vf: v1 };
			const next = arr[arr.indexOf(s) + 1];
			if (next && next.t <= tl + K.SLAM_LEN) { toast('Not enough room for a slam before the next laser.', true); return; }
		} else {
			const next = arr[arr.indexOf(s) + 1];
			if (next && t1 > next.t) { toast('That would run into the next laser.', true); return; }
			const cv = this.curvePreset();
			pts[pts.length - 1] = { ...last, ...cv };
			if (next && t1 === next.t) { // connect to the following laser
				merged = next;
				const off = next.t - s.t;
				pts = pts.concat(next.pts.map(p => ({ ...p, ry: p.ry + off })));
			} else pts.push({ id: K.nid(), ry: t1 - s.t, v: v1, vf: v1, a: 0, b: 0 });
		}
		this.begin();
		const la = this.chart.laser[d.lane].slice();
		this.replaceIn(la, s.id, { ...s, pts });
		if (merged) this.removeId(la, merged.id);
		this.chart.laser[d.lane] = la;
		this.sel = new Set([pts[pts.length - 1].id]);
		this.commit(t1 === tl ? 'Laser slam' : 'Extend laser');
		this.emit('select');
	}
	applyLaserPointMove(x, y, alt) {
		const d = this.drag, tv = this.tl;
		this.chart = K.cloneChart(this._snapDrag);
		const arr = this.chart.laser[d.lane];
		const s = arr.find(o => o.id === d.secId); if (!s) return;
		const i = s.pts.findIndex(p => p.id === d.ptId); if (i < 0) return;
		const p = s.pts[i];
		const nt = this.snapT(tv.tickAt(y), alt);
		const nv = this.snapV(tv.vAtX(x), alt);
		const prev = s.pts[i - 1], next = s.pts[i + 1];
		let ry = nt - s.t;
		if (prev && ry <= prev.ry) ry = p.ry;
		if (next && ry >= next.ry) ry = p.ry;
		if (!prev) { // first point: section start moves
			const prevSec = arr[arr.indexOf(s) - 1];
			if (prevSec && s.t + ry <= K.sectionEndTick(prevSec)) ry = p.ry;
			if (s.t + ry < 0) ry = p.ry;
		}
		let np;
		if (d.which === 'vf') np = { ...p, ry, vf: nv };
		else np = p.v === p.vf ? { ...p, ry, v: nv, vf: nv } : { ...p, ry, v: nv };
		if (np.v === np.vf && p.v !== p.vf && d.which === 'vf') np.vf = p.vf; // don't collapse a slam by accident
		let pts = s.pts.slice(); pts[i] = np;
		let st = s.t;
		if (i === 0 && ry !== 0) { st = s.t + ry; pts = pts.map(q => ({ ...q, ry: q.ry - ry })); }
		this.replaceIn(arr, s.id, { ...s, t: st, pts });
		K.sortByT(arr);
		d.moved = true;
		this.version++; this.hitsDirty = true;
	}

	// ---------------------------------------------------------------- camera keyframes
	applyCamMove(x, y, alt, shift) {
		const d = this.drag, tv = this.tl;
		this.chart = K.cloneChart(this._snapDrag);
		const arr = this.camArr(d.key).slice();
		const i = arr.findIndex(p => p.id === d.id); if (i < 0) return;
		const p = arr[i];
		let t = shift ? p.t : this.snapT(tv.tickAt(y), alt);
		if (arr.some(q => q.id !== p.id && q.t === t)) t = p.t;
		let v = p.v;
		if (typeof p.v === 'number') v = this.snapCam(d.key, tv.colV(d.col, x), alt);
		const np = { ...p, t, v };
		if (np.vf !== undefined && typeof np.vf === 'number' && typeof p.v === 'number') np.vf = p.vf + (v - p.v);
		arr.splice(i, 1); K.insertSorted(arr, np);
		this.setCamArr(d.key, arr);
		d.moved = d.moved || t !== d.t0 || v !== d.v0;
		this.version++;
	}
	applyTimingMove(y, alt) {
		const d = this.drag, h = d.hit;
		this.chart = K.cloneChart(this._snapDrag);
		const t = Math.max(1, this.snapT(this.tl.tickAt(y), alt));
		const arr = h.kind === 'bpm' ? this.chart.bpm : this.chart.stops;
		if (arr.some(o => o.id !== h.item.id && o.t === t)) return;
		this.replaceIn(arr, h.item.id, { ...h.item, t }); K.sortByT(arr);
		d.moved = t !== d.t0;
		this.version++; this.timing.rebuild(this.chart); this.hitsDirty = true;
	}

	// ---------------------------------------------------------------- delete / clipboard / mirror
	deleteAt(x, y, reg) {
		let h = null;
		if (reg.kind === 'track') h = (this.tool === 'select' && this.hitSpin(x, y)) || this.hitTrack(x, y, this.tool === 'laserL' || this.tool === 'laserR' ? this.tool : 'select');
		else if (reg.kind === 'cam') h = this.hitCam(reg.col, x, y);
		else if (reg.kind === 'timing') h = this.hitTiming(x, y);
		if (!h) return;
		this.begin();
		const c = this.chart;
		switch (h.kind) {
			case 'bt': c.bt[h.lane] = c.bt[h.lane].filter(n => n.id !== h.item.id); break;
			case 'fx': c.fx[h.lane] = c.fx[h.lane].filter(n => n.id !== h.item.id); break;
			case 'lpt': this.deleteLaserPoints(new Set([h.item.id])); break;
			case 'lseg': case 'lslam': c.laser[h.lane] = c.laser[h.lane].filter(s => s.id !== h.sec.id); break;
			case 'cam': this.setCamArr(h.key, this.camArr(h.key).filter(p => p.id !== h.item.id)); break;
			case 'bpm': if (h.item.t === 0) { toast('The first BPM cannot be deleted. Double-click it to change the value.', true); this._snap = null; return; } c.bpm = c.bpm.filter(b => b.id !== h.item.id); break;
			case 'sig': if (h.item.m === 0) { toast('The first time signature cannot be deleted.', true); this._snap = null; return; } c.sig = c.sig.filter(b => b.id !== h.item.id); break;
			case 'stop': c.stops = c.stops.filter(b => b.id !== h.item.id); break;
			case 'spin': c.spins = c.spins.filter(b => b.id !== h.item.id); break;
		}
		this.sel.delete(h.item.id);
		this.hover = null;
		this.commit('Delete');
		this.emit('select');
	}
	deleteLaserPoints(ids) {
		const c = this.chart;
		c.laser = c.laser.map(lane => {
			const out = [];
			for (const s of lane) {
				if (!s.pts.some(p => ids.has(p.id))) { out.push(s); continue; }
				const pts = s.pts.filter(p => !ids.has(p.id));
				if (!pts.length || (pts.length === 1 && pts[0].v === pts[0].vf)) continue;
				const off = pts[0].ry;
				out.push({ ...s, t: s.t + off, pts: pts.map(p => ({ ...p, ry: p.ry - off })) });
			}
			return out;
		});
	}
	deleteSelection() {
		if (!this.sel.size) return;
		const ids = this.sel;
		this.begin();
		const c = this.chart;
		c.bt = c.bt.map(l => l.filter(n => !ids.has(n.id)));
		c.fx = c.fx.map(l => l.filter(n => !ids.has(n.id)));
		this.deleteLaserPoints(ids);
		for (const k of K.CAM_KEYS) c.cam[k] = c.cam[k].filter(p => !ids.has(p.id));
		c.tilt = c.tilt.filter(p => !ids.has(p.id));
		c.stops = c.stops.filter(p => !ids.has(p.id));
		c.spins = c.spins.filter(p => !ids.has(p.id));
		c.bpm = c.bpm.filter(p => !ids.has(p.id) || p.t === 0);
		c.sig = c.sig.filter(p => !ids.has(p.id) || p.m === 0);
		const n = ids.size;
		this.sel = new Set();
		this.commit('Delete ' + n + ' item' + (n > 1 ? 's' : ''));
		this.emit('select');
	}
	selectAll() {
		const c = this.chart, ids = [];
		c.bt.forEach(l => l.forEach(n => ids.push(n.id))); c.fx.forEach(l => l.forEach(n => ids.push(n.id)));
		c.laser.forEach(l => l.forEach(s => s.pts.forEach(p => ids.push(p.id))));
		this.setSel(ids);
	}
	copy(cut) {
		const items = this.selected();
		if (!items.length) return;
		const out = { notes: [], secs: [], cams: [], minT: Infinity };
		const secSeen = new Set();
		for (const e of items) {
			if (e.kind === 'bt' || e.kind === 'fx') { out.notes.push({ kind: e.kind, lane: e.lane, n: e.item }); out.minT = Math.min(out.minT, e.item.t); }
			else if (e.kind === 'lpt' && !secSeen.has(e.sec.id)) { secSeen.add(e.sec.id); out.secs.push({ lane: e.lane, s: e.sec }); out.minT = Math.min(out.minT, e.sec.t); }
			else if (e.kind === 'cam') { out.cams.push({ key: e.key, p: e.item }); out.minT = Math.min(out.minT, e.item.t); }
		}
		this.clipboard = out;
		toast('Copied ' + (out.notes.length + out.secs.length + out.cams.length) + ' item(s)');
		if (cut) this.deleteSelection();
	}
	paste(mirror) {
		const cb = this.clipboard; if (!cb) return;
		const base = this.snapT(this.playing ? this.playTick : this.cursor);
		const off = base - cb.minT;
		this.begin();
		const c = this.chart, ids = [];
		for (const { kind, lane, n } of cb.notes) {
			const li = mirror ? (kind === 'bt' ? 3 - lane : 1 - lane) : lane;
			const arr = (kind === 'bt' ? c.bt : c.fx)[li] = (kind === 'bt' ? c.bt : c.fx)[li].slice();
			const nn = { ...n, id: K.nid(), t: n.t + off };
			this.clearLaneSpan(arr, nn.t, nn.l);
			K.insertSorted(arr, nn); ids.push(nn.id);
		}
		for (const { lane, s } of cb.secs) {
			const li = mirror ? 1 - lane : lane;
			const ns = { ...s, id: K.nid(), t: s.t + off, pts: s.pts.map(p => ({ ...p, id: K.nid(), v: mirror ? 50 - p.v : p.v, vf: mirror ? 50 - p.vf : p.vf })) };
			const end = K.sectionEndTick(ns);
			c.laser[li] = c.laser[li].filter(o => !(end >= o.t && ns.t <= K.sectionEndTick(o)));
			K.insertSorted(c.laser[li], ns); ns.pts.forEach(p => ids.push(p.id));
		}
		for (const { key, p } of cb.cams) {
			const arr = this.camArr(key).filter(q => q.t !== p.t + off);
			const neg = mirror && (key === 'zoom_side' || key === 'rotation_deg' || key === 'tilt');
			const f = (v) => neg && typeof v === 'number' ? -v : v;
			const np = { ...p, id: K.nid(), t: p.t + off, v: f(p.v) }; if (p.vf !== undefined) np.vf = f(p.vf);
			K.insertSorted(arr, np); this.setCamArr(key, arr); ids.push(np.id);
		}
		this.sel = new Set(ids);
		this.commit(mirror ? 'Paste mirrored' : 'Paste');
		this.emit('select');
	}
	mirrorSelection() {
		const items = this.selected(); if (!items.length) return;
		this.begin();
		const c = this.chart, ids = this.sel;
		const flipLanes = (lanes, max) => {
			const res = lanes.map(() => []);
			lanes.forEach((lane, li) => lane.forEach(n => res[ids.has(n.id) ? max - li : li].push(n)));
			return res.map(K.sortByT);
		};
		c.bt = flipLanes(c.bt, 3); c.fx = flipLanes(c.fx, 1);
		const moved = [[], []];
		c.laser = c.laser.map((lane, li) => lane.filter(s => {
			if (!s.pts.some(p => ids.has(p.id))) return true;
			moved[1 - li].push({ ...s, pts: s.pts.map(p => ({ ...p, v: 50 - p.v, vf: 50 - p.vf })) });
			return false;
		}));
		for (let i = 0; i < 2; i++) for (const s of moved[i]) {
			const end = K.sectionEndTick(s);
			c.laser[i] = c.laser[i].filter(o => !(end >= o.t && s.t <= K.sectionEndTick(o)));
			K.insertSorted(c.laser[i], s);
		}
		this.commit('Mirror');
	}
	nudgeSelection(dir) { // move selection one grid step up/down
		if (!this.sel.size) return;
		const step = this.step * dir;
		this.begin();
		this._snapDrag = K.cloneChart(this.chart);
		this.drag = { type: 'move', anchor: { kind: 'none' }, x0: 0, y0: 0 };
		const tv = this.tl;
		this.applyMove(0, tv.yOf(tv.tickAt(0) + step) , { altKey: false });
		this.drag = null; this._snapDrag = null;
		this.commit('Nudge');
	}

	// ---------------------------------------------------------------- timing events
	addTimingPopover(t, cx, cy) {
		const ms = this.timing.measureOf(t);
		popover(cx, cy, 'Add at ' + posLabel(this.timing, t, this.div), [
			{ key: 'type', label: 'Type', type: 'select', value: 'bpm', options: [['bpm', 'BPM change'], ['sig', 'Time signature (measure ' + (ms.m + 1) + ')'], ['stop', 'Stop (pause scroll)'], ['spin', 'Spin / swing']] },
			{ key: 'bpm', label: 'BPM', type: 'number', value: K.fmtNum(this.timing.bpmAt(t)), show: v => v.type === 'bpm' },
			{ key: 'sig', label: 'Beats', type: 'text', value: ms.n + '/' + ms.d, show: v => v.type === 'sig' },
			{ key: 'stop', label: 'Length', type: 'text', value: '1/8', show: v => v.type === 'stop', hint: 'measures, e.g. 1/8, 3/16, 1' },
			{ key: 'spin', label: 'Kind', type: 'select', value: '@)', options: SPIN_OPTIONS, show: v => v.type === 'spin' },
			{ key: 'slen', label: 'Length', type: 'text', value: '1', show: v => v.type === 'spin', hint: 'measures' },
		], (v) => {
			if (v.type === 'bpm') { const b = parseFloat(v.bpm); if (!(b > 0)) return toast('Enter a BPM above 0', true); this.setBpmAt(t, b); }
			else if (v.type === 'sig') { const [n, d] = String(v.sig).split('/').map(x => parseInt(x, 10)); if (!(n > 0 && [1, 2, 4, 8, 16, 32, 64].includes(d))) return toast('Use n/d where d is 1, 2, 4, 8, 16, 32 or 64', true); this.setSigAt(ms.m, n, d); }
			else if (v.type === 'stop') { const l = parseLen(v.stop); if (!(l > 0)) return toast('Enter a length like 1/8', true); this.edit('Add stop', c => { c.stops = c.stops.filter(s => s.t !== t); K.insertSorted(c.stops, { id: K.nid(), t, l }); }); }
			else if (v.type === 'spin') { const l = parseLen(v.slen); this.setSpinAt(t, v.spin, l > 0 ? l : 960); }
		});
	}
	editTimingItem(h, cx, cy) {
		if (h.kind === 'bpm') popover(cx, cy, 'BPM change', [{ key: 'v', label: 'BPM', type: 'number', value: K.fmtNum(h.item.v) }], v => { const b = parseFloat(v.v); if (b > 0) this.setBpmAt(h.item.t, b); });
		else if (h.kind === 'sig') popover(cx, cy, 'Time signature (measure ' + (h.item.m + 1) + ')', [{ key: 'v', label: 'Beats', type: 'text', value: h.item.n + '/' + h.item.d }], v => { const [n, d] = String(v.v).split('/').map(x => parseInt(x, 10)); if (n > 0 && [1, 2, 4, 8, 16, 32, 64].includes(d)) this.setSigAt(h.item.m, n, d); });
		else if (h.kind === 'stop') popover(cx, cy, 'Stop', [{ key: 'v', label: 'Length', type: 'text', value: fmtLen(h.item.l) }], v => { const l = parseLen(v.v); if (l > 0) this.edit('Edit stop', c => this.replaceIn(c.stops, h.item.id, { ...h.item, l })); });
	}
	setBpmAt(t, b) { this.edit('BPM ' + K.fmtNum(b), c => { const ex = K.findAt(c.bpm, t); if (ex) this.replaceIn(c.bpm, ex.id, { ...ex, v: b }); else K.insertSorted(c.bpm, { id: K.nid(), t, v: b }); }); }
	setSigAt(m, n, d) { this.edit('Time signature ' + n + '/' + d, c => { const ex = c.sig.find(s => s.m === m); if (ex) this.replaceIn(c.sig, ex.id, { ...ex, n, d }); else { c.sig.push({ id: K.nid(), m, n, d }); c.sig.sort((a, b) => a.m - b.m); } }); }
	setSpinAt(t, code, l, extra = {}) {
		this.edit('Spin', c => {
			c.spins = c.spins.filter(s => s.t !== t);
			if (!code) return;
			const sp = { id: K.nid(), t, kind: code[0] === 'S' ? 'swing' : (code[1] === '(' || code[1] === ')') ? 'spin' : 'half', dir: (code[1] === '(' || code[1] === '<') ? -1 : 1, l, amp: 250, rep: 3, dec: 2, ...extra };
			K.insertSorted(c.spins, sp);
		});
	}
	editCamPopover(key, p, cx, cy) {
		const isTilt = key === 'tilt';
		const fields = [];
		if (isTilt) fields.push({ key: 'mode', label: 'Type', type: 'select', value: typeof p.v === 'number' ? 'manual' : p.v, options: [['manual', 'Manual value'], ...K.TILT_AUTO.map(a => [a, 'Auto: ' + a])] });
		fields.push({ key: 'v', label: 'Value', type: 'number', value: typeof p.v === 'number' ? K.fmtNum(p.v) : '0', show: isTilt ? (v => v.mode === 'manual') : null });
		fields.push({ key: 'jump', label: 'Jump to', type: 'text', value: p.vf !== undefined ? String(p.vf) : '', hint: 'optional instant change' });
		popover(cx, cy, COL_INFO[key].label + ' keyframe', fields, (v) => {
			this.edit('Edit keyframe', c => {
				const arr = this.camArr(key).slice();
				const np = { ...p };
				if (isTilt && v.mode !== 'manual') np.v = v.mode; else np.v = parseFloat(v.v) || 0;
				const j = String(v.jump).trim();
				if (j === '') delete np.vf; else np.vf = isNaN(parseFloat(j)) ? j : parseFloat(j);
				this.replaceIn(arr, p.id, np); this.setCamArr(key, arr);
			});
		});
	}

	// ---------------------------------------------------------------- playback
	play() {
		if (this.playing) return;
		this.audio.ensure();
		const t = this.cursor;
		this.playStartTick = t;
		const s = this.songTimeOf(t);
		this.audio.play(s, this.settings.rate);
		this.playing = true; this.playTick = t;
		this.buildHits(s);
		this.emit('play');
	}
	pause() { // stop and leave the cursor where playback is
		if (!this.playing) return;
		this.audio.stop(); this.playing = false;
		this.cursor = Math.max(0, this.snapT(this.playTick));
		this.emit('play'); this.requestDraw();
	}
	stop() { // stop and return to where playback started
		if (!this.playing) return;
		this.audio.stop(); this.playing = false;
		this.cursor = this.playStartTick;
		this.emit('play'); this.requestDraw();
	}
	toggle() { this.playing ? this.pause() : this.play(); }
	seekTo(t) { const was = this.playing; if (was) { this.audio.stop(); this.playing = false; } this.cursor = Math.max(0, t); if (was) this.play(); this.requestDraw(); }
	buildHits(fromSong) {
		const c = this.chart, ev = [];
		const add = (t, k) => ev.push({ s: this.songTimeOf(t), k });
		c.bt.forEach(l => l.forEach(n => add(n.t, 'bt')));
		c.fx.forEach(l => l.forEach(n => add(n.t, 'fx')));
		c.laser.forEach(l => l.forEach(s => s.pts.forEach(p => { if (p.v !== p.vf) add(s.t + p.ry, 'slam'); })));
		ev.sort((a, b) => a.s - b.s);
		this.hits = ev;
		let i = 0; while (i < ev.length && ev[i].s < fromSong - 0.001) i++;
		this.hitPtr = i;
		this.nextBeat = null;
		this.hitsDirty = false;
	}
	scheduleHits() {
		if (!this.playing || !this.audio.ctx) return;
		const a = this.audio;
		const nowCtxSong = a.t0Song + (a.ctx.currentTime - a.t0Ctx) * a.rate;
		if (this.hitsDirty) this.buildHits(nowCtxSong);
		const horizon = nowCtxSong + 0.15 * a.rate;
		if (this.settings.hitsounds) {
			while (this.hitPtr < this.hits.length && this.hits[this.hitPtr].s <= horizon) {
				const h = this.hits[this.hitPtr++];
				if (h.s >= nowCtxSong - 0.01) a.schedule(h.k, h.s);
			}
		} else this.hitPtr = this.hits.length;
		if (this.settings.volMetro > 0) {
			if (this.nextBeat === null) { const t = this.tickOfSong(nowCtxSong); const ms = this.timing.measureOf(Math.max(0, t)); const bl = 960 / ms.d; this.nextBeat = ms.start + Math.ceil((t - ms.start) / bl - 1e-6) * bl; }
			for (let k = 0; k < 16; k++) {
				const s = this.songTimeOf(this.nextBeat); if (s > horizon) break;
				const ms = this.timing.measureOf(this.nextBeat);
				if (s >= nowCtxSong - 0.01) a.schedule(this.nextBeat === ms.start ? 'metroHi' : 'metro', s);
				this.nextBeat += 960 / ms.d;
				const nm = this.timing.measureOf(this.nextBeat); if (nm.m !== ms.m) this.nextBeat = nm.start;
			}
		}
	}
	chartEndTick() {
		const c = this.chart; let m = 0;
		for (const l of [...c.bt, ...c.fx]) if (l.length) { const n = l[l.length - 1]; m = Math.max(m, n.t + n.l); }
		for (const l of c.laser) if (l.length) m = Math.max(m, K.sectionEndTick(l[l.length - 1]));
		return m;
	}
}

const SPIN_OPTIONS = [['', 'None'], ['@(', 'Spin ← (@()'], ['@)', 'Spin → (@))'], ['@<', 'Half spin ← (@<)'], ['@>', 'Half spin → (@>)'], ['S<', 'Swing ← (S<)'], ['S>', 'Swing → (S>)']];
function spinCode(s) { return !s ? '' : s.kind === 'spin' ? (s.dir < 0 ? '@(' : '@)') : s.kind === 'half' ? (s.dir < 0 ? '@<' : '@>') : (s.dir < 0 ? 'S<' : 'S>'); }
function parseLen(str) { // "1/8" -> ticks (measures of 4/4), "1" -> 960, "0.5" -> 480
	str = String(str).trim();
	let v;
	if (str.includes('/')) { const [a, b] = str.split('/').map(Number); v = a / b; } else v = parseFloat(str);
	return Number.isFinite(v) ? Math.round(v * 960) : NaN;
}
function posLabel(tm, t, div) {
	const ms = tm.measureOf(t), rel = t - ms.start, bl = 960 / ms.d;
	const beat = Math.floor(rel / bl), sub = rel - beat * bl;
	const g = (a, b) => b ? g(b, a % b) : a;
	let s = (ms.m + 1) + '.' + (beat + 1);
	if (sub) { const d = g(sub, 960); s += ' +' + (sub / d) + '/' + (960 / d); }
	return s;
}
function loadJSON(key, def) {
	try { const s = localStorage.getItem(key); if (s) return Object.assign(JSON.parse(JSON.stringify(def)), JSON.parse(s)); } catch (e) { }
	return JSON.parse(JSON.stringify(def));
}
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
