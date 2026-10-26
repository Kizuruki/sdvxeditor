// End-to-end UI test (Playwright). Usage: node tests/e2e.js <dir with click150.wav> <screenshot dir>
const { chromium } = require('playwright');
const path = require('path');
const [D, SHOTS] = process.argv.slice(2);
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message + '\n' + e.stack));
  p.on('dialog', d => d.accept());
  await p.goto('file://' + path.resolve(__dirname, '../index.html'));
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const { tl } = window.KSMEditor;
    window.__pos = (kind, a, b, c) => {
      const r = tl.cv.getBoundingClientRect();
      let x, y;
      if (kind === 'bt') { x = tl.btL(a) + tl.laneW / 2; y = tl.yOf(b) - 3; }
      if (kind === 'fx') { x = tl.fxL(a) + tl.laneW; y = tl.yOf(b) - 3; }
      if (kind === 'laser') { x = tl.laserX(a); y = tl.yOf(b); }
      if (kind === 'cam') { const col = tl.cols.find(c2 => c2.key === a); tl._ranges = tl._ranges || {}; x = col ? tl.colX(col, b) : 0; y = tl.yOf(c); }
      if (kind === 'timing') { x = tl.timingL + 20; y = tl.yOf(a) - 4; }
      if (kind === 'gutter') { x = 20; y = tl.yOf(a); }
      return { x: r.left + x, y: r.top + y };
    };
  });
  const pos = (...a) => p.evaluate((a) => window.__pos(...a), a);
  const st = () => p.evaluate(() => { const c = window.KSMEditor.ed.chart; return { bt: c.bt.map(l => l.map(n => [n.t, n.l])), fx: c.fx.map(l => l.map(n => [n.t, n.l, n.fx || ''])), laser: c.laser.map(l => l.map(s => ({ t: s.t, pts: s.pts.map(q => [q.ry, q.v, q.vf]) }))), bpm: c.bpm.map(x => [x.t, x.v]), o: c.meta.o, m: c.meta.m, zt: c.cam.zoom_top.map(q => [q.t, q.v]), spins: c.spins.map(s => [s.t, s.kind, s.dir, s.l]) }; });
  const click = async (q) => { await p.mouse.click(q.x, q.y); await p.waitForTimeout(60); };
  const drag = async (a, z, steps = 8) => { await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(z.x, z.y, { steps }); await p.mouse.up(); await p.waitForTimeout(80); };

  console.log('Audio + metadata');
  await p.setInputFiles('#fileInput', [path.join(D, 'click150.wav')]);
  await p.waitForFunction(() => window.KSMEditor.ed.audio.buffer !== null, null, { timeout: 10000 });
  ok((await st()).m === 'click150.wav', 'music file name set from loaded audio');
  await p.click('#tabs button:has-text("Chart")');
  const off = p.locator('.row:has(label:text("Offset (o)")) input');
  await off.fill('500'); await off.press('Enter'); await p.waitForTimeout(100);
  ok((await st()).o === '500', 'offset set to 500 ms through the Chart tab');
  await p.dblclick('#timeline', { position: await p.evaluate(() => { const { tl } = window.KSMEditor; return { x: tl.timingL + 20, y: tl.yOf(0) - 4 }; }) });
  await p.waitForSelector('#popover:not(.hidden)');
  await p.fill('#popover input', '150'); await p.press('#popover input', 'Enter');
  await p.waitForTimeout(100);
  ok(JSON.stringify((await st()).bpm) === '[[0,150]]', 'BPM changed to 150 via double-click popover');

  console.log('Notes');
  await p.keyboard.press('2');
  await click(await pos('bt', 0, 0));
  await drag(await pos('bt', 1, 240), await pos('bt', 1, 480));
  let s = await st();
  ok(JSON.stringify(s.bt[0]) === '[[0,0]]', 'BT chip placed on lane A at 0');
  ok(JSON.stringify(s.bt[1]) === '[[240,240]]', 'BT hold dragged on lane B 240..480');
  await p.keyboard.press('3');
  await p.selectOption('#optbar select >> nth=1', 'Retrigger');
  await click(await pos('fx', 0, 480));
  await drag(await pos('fx', 1, 720), await pos('fx', 1, 1200));
  s = await st();
  ok(JSON.stringify(s.fx[0]) === '[[480,0,""]]', 'FX chip placed on FX-L');
  ok(JSON.stringify(s.fx[1]) === '[[720,480,"Retrigger;8"]]', 'FX hold on FX-R with Retrigger;8 from the option bar');

  console.log('Lasers');
  await p.keyboard.press('4');
  await drag(await pos('laser', 0, 960), await pos('laser', 50, 1440));
  s = await st();
  ok(JSON.stringify(s.laser[0]) === '[{"t":960,"pts":[[0,0,0],[480,50,50]]}]', 'left laser drawn 0 -> 50 over 1/2 measure');
  await drag(await pos('laser', 50, 1440), await pos('laser', 0, 1440));
  s = await st();
  ok(JSON.stringify(s.laser[0][0].pts[1]) === '[480,50,0]', 'sideways drag from end point made a slam 50 -> 0');
  await drag(await pos('laser', 0, 1440), await pos('laser', 25, 1920));
  s = await st();
  ok(JSON.stringify(s.laser[0][0].pts) === '[[0,0,0],[480,50,0],[960,25,25]]', 'dragging from the slam end continued the laser');
  await p.keyboard.press('5');
  await drag(await pos('laser', 50, 2160), await pos('laser', 0, 2160));
  s = await st();
  ok(JSON.stringify(s.laser[1]) === '[{"t":2160,"pts":[[0,50,0]]}]', 'right laser single slam');
  // spin on the right slam (selected after creation)
  await p.click('#tabs button:has-text("Properties")');
  await p.selectOption('.sec:has(h4:text("Lane spin")) select', '@(');
  s = await st();
  ok(JSON.stringify(s.spins) === '[[2160,"spin",-1,960]]', 'spin @( added on the slam from the properties panel');

  console.log('Camera');
  await click(await pos('cam', 'zoom_top', 0, 960));
  await drag(await pos('cam', 'zoom_top', 0, 1920), await pos('cam', 'zoom_top', 150, 1920));
  s = await st();
  ok(s.zt.length === 2 && s.zt[0][0] === 960 && s.zt[1][0] === 1920 && s.zt[1][1] > 100, 'zoom_top keyframes added and dragged to ' + JSON.stringify(s.zt));

  console.log('Undo / redo / clipboard');
  const before = JSON.stringify(await st());
  await p.keyboard.press('Control+z'); await p.waitForTimeout(50);
  ok(JSON.stringify(await st()) !== before, 'undo changed the chart');
  await p.keyboard.press('Control+y'); await p.waitForTimeout(50);
  ok(JSON.stringify(await st()) === before, 'redo restored it');
  await p.keyboard.press('1');
  await p.keyboard.press('Control+a');
  await p.keyboard.press('Control+c');
  await click(await pos('gutter', 0));
  for (let i = 0; i < 4; i++) await p.keyboard.press('PageUp');
  ok(await p.evaluate(() => window.KSMEditor.ed.cursor) === 3840, 'PageUp x4 moves the cursor to measure 5');
  await p.keyboard.press('Control+v'); await p.waitForTimeout(80);
  s = await st();
  ok(s.bt[0].length === 2 && s.bt[0][1][0] === 3840 && s.laser[0].length === 2 && s.laser[0][1].t === 960 + 3840, 'copy/paste at the cursor duplicates notes and lasers');
  await p.keyboard.press('Control+z');
  // right-click delete
  await p.keyboard.press('Home');
  await p.keyboard.press('2');
  await p.mouse.click((await pos('bt', 0, 0)).x, (await pos('bt', 0, 0)).y - 2, { button: 'right' });
  s = await st();
  ok(s.bt[0].length === 0, 'right-click deletes the BT chip');
  await p.keyboard.press('Control+z');

  console.log('Save output');
  const txt = await p.evaluate(() => window.KSMEditor.K.exportKsh(window.KSMEditor.ed.chart).text);
  const back = await p.evaluate((t) => { const K = window.KSMEditor.K; const c = K.importKsh(t).chart; return { bt: c.bt.map(l => l.length), lsr: c.laser.map(l => l.length), spins: c.spins.length, fx: c.fx[1][0] && c.fx[1][0].fx }; }, txt);
  ok(back.bt.join() === '1,1,0,0' && back.lsr.join() === '1,1' && back.spins === 1 && back.fx === 'Retrigger;8', 'saved .ksh re-imports with the same notes, lasers, spin and effect');
  ok(/\r\nfx-r=Retrigger;8\r\n0000\|01\|/.test(txt), 'FX hold effect written as fx-r= before the hold');
  ok(/@\(192/.test(txt), 'spin written as @(192 on the slam line');
  ok(/zoom_top=0\r\n/.test(txt), 'zoom_top written');
  ok(txt.includes('o=500') && txt.includes('t=150') && txt.includes('m=click150.wav'), 'header has offset, BPM and music file');
  require('fs').writeFileSync(path.join(SHOTS, 'e2e_out.ksh'), txt);

  console.log('More editing');
  await p.keyboard.press('Home');
  await p.keyboard.press('2');
  { const a = await pos('bt', 1, 480); await drag({ x: a.x, y: a.y + 3 }, (await pos('bt', 1, 720))); }
  s = await st();
  ok(JSON.stringify(s.bt[1]) === '[[240,480]]', 'dragging a hold end resizes it (' + JSON.stringify(s.bt[1]) + ')');
  await p.keyboard.press('4');
  await p.keyboard.down('Alt'); await drag(await pos('laser', 25, 1920), await pos('laser', 40, 1920)); await p.keyboard.up('Alt');
  s = await st();
  ok(JSON.stringify(s.laser[0][0].pts[2]) === '[960,40,40]', 'Alt+drag moves a laser end point (' + JSON.stringify(s.laser[0][0].pts[2]) + ')');
  await p.keyboard.press('1');
  { const a = await pos('bt', 0, 0), z = await pos('bt', 3, 600); await drag({ x: a.x - 30, y: a.y + 15 }, { x: z.x + 30, y: z.y }); }
  const nsel = await p.evaluate(() => window.KSMEditor.ed.sel.size);
  ok(nsel === 3, 'box select picked the 3 notes in measure 1 (got ' + nsel + ')');
  await p.keyboard.press('Control+m'); await p.waitForTimeout(50);
  s = await st();
  ok(JSON.stringify(s.bt[3]) === '[[0,0]]' && JSON.stringify(s.bt[2]) === '[[240,480]]' && s.fx[1].length === 2, 'Ctrl+M mirrors the selection');
  await p.keyboard.press('Alt+ArrowUp'); await p.waitForTimeout(50);
  s = await st();
  ok(JSON.stringify(s.bt[3]) === '[[60,0]]', 'Alt+Up nudges the selection one 1/16 step');
  // make two holds touch and check the Check tab badge
  await p.evaluate(() => { const { ed, K } = window.KSMEditor; ed.edit('t', c => { c.bt[0].push({ id: K.nid(), t: 2400, l: 240 }, { id: K.nid(), t: 2640, l: 240 }); }); });
  await p.waitForTimeout(200);
  ok(await p.locator('#tabs .badge').count() === 1, 'Check tab shows a problem badge for touching holds');
  for (let i = 0; i < 4; i++) await p.keyboard.press('Control+z');

  console.log('Events in the timing column');
  await p.keyboard.press('1');
  await p.evaluate(() => { const { ed, K, tl } = window.KSMEditor; ed.edit('setup', c => { c.pfilterGain = [{ id: K.nid(), t: 1920, v: '30' }]; c.filterType = [{ id: K.nid(), t: 1920, v: 'lpf1' }]; c.slamVol = [{ id: K.nid(), t: 2400, v: '80' }]; }); ed.sel = new Set(); tl.bottomTick = 1500; ed.requestDraw(); });
  await p.waitForTimeout(120);
  const evRect = (key) => p.evaluate((key) => { const { tl } = window.KSMEditor; const r = tl.cv.getBoundingClientRect(); const h = (tl.timingHits || []).find(x => x.key === key); return h ? { x: r.left + (h.x0 + h.x1) / 2, y: r.top + (h.y0 + h.y1) / 2 } : null; }, key);
  let q = await evRect('pfilterGain');
  ok(!!q, 'pfiltergain label is drawn as a clickable item');
  await p.mouse.move(q.x, q.y); await p.waitForTimeout(60);
  ok(/strength/i.test(await p.evaluate(() => window.KSMEditor.tl.cv.title)), 'hovering an event shows its explanation as a tooltip');
  await click(q);
  ok(await p.evaluate(() => { const { ed } = window.KSMEditor; const e = ed.selected(); return e.length === 1 && e[0].key === 'pfilterGain'; }), 'clicking it selects it');
  ok(await p.locator('#tabBody .note:has-text("How strong")').count() > 0, 'Properties panel explains the event');
  // box select across the timing column
  const tlb = await p.evaluate(() => { const { tl } = window.KSMEditor; const r = tl.cv.getBoundingClientRect(); return { x0: r.left + tl.timingL + 2, x1: r.left + tl.timingR - 2, y0: r.top + tl.yOf(2600), y1: r.top + tl.yOf(1800) }; });
  await drag({ x: tlb.x0, y: tlb.y0 }, { x: tlb.x1, y: tlb.y1 });
  const selKinds = await p.evaluate(() => window.KSMEditor.ed.selected().map(e => e.key || e.kind).sort().join(','));
  ok(selKinds === 'filterType,pfilterGain,slamVol', 'box select in the timing column picks up every event (' + selKinds + ')');
  // copy + paste at a later cursor
  await p.keyboard.press('Control+c');
  await p.evaluate(() => { const { ed } = window.KSMEditor; ed.cursor = 3840; });
  await p.keyboard.press('Control+v'); await p.waitForTimeout(80);
  let evs = await p.evaluate(() => { const c = window.KSMEditor.ed.chart; return [c.pfilterGain.map(e => e.t + ':' + e.v), c.filterType.map(e => e.t + ':' + e.v), c.slamVol.map(e => e.t + ':' + e.v)].map(a => a.join(' ')).join(' | '); });
  ok(evs === '1920:30 3840:30 | 1920:lpf1 3840:lpf1 | 2400:80 4320:80', 'copy/paste duplicates events at the cursor (' + evs + ')');
  // nudge the pasted selection
  await p.keyboard.press('Alt+ArrowUp'); await p.waitForTimeout(60);
  evs = await p.evaluate(() => window.KSMEditor.ed.chart.pfilterGain.map(e => e.t).join(','));
  ok(evs === '1920,3900', 'Alt+Up moves selected events one step (' + evs + ')');
  await p.keyboard.press('Delete'); await p.waitForTimeout(60);
  evs = await p.evaluate(() => { const c = window.KSMEditor.ed.chart; return c.pfilterGain.length + c.filterType.length + c.slamVol.length; });
  ok(evs === 3, 'Delete removes the selected events');
  // double-click edits
  await p.evaluate(() => { const { ed, tl } = window.KSMEditor; ed.sel = new Set(); tl.bottomTick = 1500; ed.requestDraw(); });
  await p.waitForTimeout(80);
  q = await evRect('slamVol');
  await p.mouse.dblclick(q.x, q.y); await p.waitForSelector('#popover:not(.hidden)');
  await p.fill('#popover input', '65'); await p.press('#popover input', 'Enter'); await p.waitForTimeout(80);
  ok(await p.evaluate(() => window.KSMEditor.ed.chart.slamVol[0].v) === '65', 'double-click edits slam volume');
  // click on empty timing space opens the add popover with an explanation
  const emptyPt = await p.evaluate(() => { const { tl } = window.KSMEditor; const r = tl.cv.getBoundingClientRect(); return { x: r.left + tl.timingL + 30, y: r.top + tl.yOf(2880) - 20 }; });
  await click(emptyPt); await p.waitForSelector('#popover:not(.hidden)');
  await p.selectOption('#popover select >> nth=0', 'filterType');
  ok(/low-pass/.test(await p.locator('#popover .note').first().textContent()), 'add popover explains the laser effect');
  await p.keyboard.press('Escape');
  await p.evaluate(() => { const { ed } = window.KSMEditor; ed.edit('cleanup', c => { c.pfilterGain = []; c.filterType = []; c.slamVol = []; }); });

  console.log('Playback clock');
  await click(await pos('gutter', 0));
  await p.keyboard.press('Space');
  await p.waitForTimeout(400);
  const samples = await p.evaluate(async () => {
    const { ed } = window.KSMEditor, out = [];
    for (let i = 0; i < 40; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const ts = ed.audio.ctx.getOutputTimestamp(), pf = performance.now(), s = ed.audio.songTimeNow(), A = ed.audio;
      const raw = A.t0Song + (ts.contextTime + (pf - ts.performanceTime) / 1000 - A.t0Ctx) * A.rate;
      out.push({ perf: pf / 1000, raw, song: s, tick: ed.playTick, songTick: ed.tickOfSong(s), bpm: ed.timing.bpmAt(ed.playTick) });
    }
    return out;
  });
  const n = samples.length - 1;
  const err = Math.max(...samples.map(x => Math.abs(x.song - x.raw)));
  ok(err < 0.01, 'playhead within ' + (err * 1000).toFixed(1) + ' ms of the audio output clock');
  const steps = []; for (let i = 1; i <= n; i++) steps.push(Math.abs((samples[i].song - samples[i - 1].song) / (samples[i].perf - samples[i - 1].perf) - 1));
  steps.sort((x, y) => x - y);
  const p90 = steps[Math.floor(steps.length * 0.9)];
  ok(p90 < 0.05, 'playhead moves smoothly (90% of frames within ' + (p90 * 100).toFixed(2) + '% of real time)');
  const lag = Math.max(...samples.map(x => Math.abs(x.songTick - x.tick) / (x.bpm / 60 * 240)));
  ok(lag < 0.04, 'drawn playhead is within ' + Math.round(lag * 1000) + ' ms of the audio position');
  await p.screenshot({ path: path.join(SHOTS, 'e2e_play.png') });
  await p.keyboard.press('Space');
  await p.evaluate(() => { const { ed, tl } = window.KSMEditor; ed.cursor = 0; tl.bottomTick = -100; ed.setSel([]); ed.requestDraw(); });
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(SHOTS, 'e2e_chart.png') });

  ok(errs.length === 0, 'no page errors' + (errs.length ? ':\n' + errs.join('\n') : ''));
  console.log(fails ? fails + ' FAILED' : 'all passed');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
