# KSM Chart Editor

A fast SDVX / K-Shoot MANIA chart editor in the style of MikuMikuWorld. It runs in the browser from one file (`index.html`), works offline, and saves real `.ksh` charts.

**To use it, open `index.html`** (double-click it, or host the repo on GitHub Pages). Chrome or Edge is recommended, since they can also save straight back into your chart folder.

## Features

- **BT (white) and FX (orange) notes**: click for a chip, drag for a hold, drag a hold's end to resize.
- **Lasers (blue L / pink R)**: drag to draw, drag from the end point to continue, drag sideways for a slam. Also supports wide (2x) lasers, curves, and slam sounds.
- **Screen effects**: graph columns for `zoom_top`, `zoom_bottom`, `zoom_side`, `tilt`, `rotation_deg`, `center_split` and `scroll_speed`. Each keyframe can have an instant jump and an ease curve.
- **Lane spins, half spins and swings** ("screen shakes"), attached to slams with length and swing settings.
- **Timing**: BPM changes, time signatures and stops. FX hold effects (Retrigger, Gate, Flanger, Echo…) and FX chip key sounds. Laser filter type, slam volume, filter gain, comments and raw KSH option lines.
- **SDVX-style preview** built on a direct port of USC's camera. It covers zoom_top/bottom/side, center split, rotation around the far end of the lane, spins and swings, and the game's own automatic laser tilt (normal/bigger/biggest/keep/zero, pre-tilt, slam roll and shake). Speed is set like EG's LANE-SPEED (BPM × hi-speed ÷ 100), and there is a DRAW offset. The pane can be resized.
- **Engine tilt you can see and override**: the Tilt column shows the tilt the game will apply as a dashed line. Each laser can turn auto tilt off (`tilt=zero`) or change it for its span.
- **Slam kicks**: newly drawn slams can add a `zoom_side` kick (±30 by default) that jumps the lane in the slam's direction and eases back. The kicks are ordinary keyframes, and you can add or remove them for selected or all slams.
- **Hear the effects**: FX hold effects and the laser filter are applied to the music during playback by an AudioWorklet, in one of two modes (Settings → *Effects sound like*). *SOUND VOLTEX* (default) models the arcade engine with the exact parameters the `.vox` export writes: the built-in peak filter that follows the knob 80 ms late and ducks the music, knob-swept LPF/HPF/bitcrush, grid-locked Retrigger, the game's Gate pattern, multi-pass Flanger, Side Chain, Tape Stop, Wobble and Echo, and overlapping FX holds replacing rather than stacking. *USC* is a port of USC's DSP and honours `filtertype` / `pfiltergain`. Slam sounds follow `chokkakuse`/`chokkakuvol`, and FX chips play their key sounds.
- **Every object is selectable**, including laser effect, filter gain, slam volume/sound, BPM, stops, spins, camera keys and raw KSH lines. You can box-select, move, copy/paste and delete all of them, and each type has a plain explanation in tooltips and the Properties panel.
- **Exports**: `.ksh` for KSM, *Export for USC* (curves baked, `scroll_speed` as percent, `rotation_deg` → tilt), and *Export for SOUND VOLTEX*. The SDVX export makes a `.zip` laid out like the game's `data/music/<id>_<name>/` folder: the `.vox` chart (format 12, or 10 for older tools), song and preview `.2dx` (MS-ADPCM, the same layout as the game's files) and the three jacket sizes, plus a Shift-JIS `music_db` entry and a README. Laser FX effects become `#TRACK AUTO TAB` spans. It also lists anything that could not be converted.
- **Open official `.vox` charts**: notes, lasers, spins, BPM / beat changes, camera graphs and every FX hold, laser and auto-tab effect come in. Effects keep their exact SDVX parameters (as `sdvx=` in `#define_fx` / `#define_filter`, which USC and KSM ignore), so playback and a re-export match the original.
- **Editing tools**: copy/paste at the cursor, mirrored paste, mirror selection, box select, nudge, and undo/redo (400 steps).
- **Chart check tab**: warns about things KSH can't store, like holds that touch end-to-start, overlapping lasers, or 1/32 segments that turn into slams.
- **Autosave** to the browser, with a restore option.

Press **F1** in the editor for all controls. Quick reference:

| Key | Action |
| --- | --- |
| `1`–`5` | Select, BT, FX, Laser L, Laser R |
| Right-click | Delete the thing under the mouse |
| `Space` / `Shift+Space` | Play/pause / stop and jump back |
| Mouse wheel / `Ctrl`+wheel | Scroll / zoom |
| `Ctrl+↑/↓` or `[` `]` | Change grid snap |
| `Alt` while dragging | No snapping (Alt-drag on a laser end point moves it instead of extending) |
| `Ctrl+C/X/V`, `Ctrl+Shift+V`, `Ctrl+M` | Copy / cut / paste at cursor / paste mirrored / mirror |
| `Ctrl+S` / `Ctrl+O` | Save .ksh / open chart and audio (drag & drop works too) |

## Timing accuracy

Playback time comes from the Web Audio output clock (`AudioContext.getOutputTimestamp`), not from an `<audio>` element. Music and hitsounds are scheduled sample-accurately on that clock. In the tests, the drawn playhead stays within about 1 ms of what the speakers are playing, and drawing takes about 1.5 ms per frame on a full 99-measure chart.

- `o=` (offset) works like it does in KSM: it is where beat 1 of measure 1 sits in the audio. Line the waveform column up with the measure lines.
- Prefer `.ogg` audio (what KSM uses). Some MP3 encoders add a few ms of padding that decoders handle differently.
- Settings → *Visual latency* is only needed if your output device reports its delay wrongly (e.g. some Bluetooth headsets).

## KSH compatibility

The importer and exporter follow the [official KSH spec](https://github.com/kshootmania/ksm-chart-format) and mirror [libkson](https://github.com/kshootmania/libkson), KSM's own parser. That covers 240 ticks per beat, the shortest line division per measure, slams as 1/32 steps, `fx-l=`/`fx-r=` effects, curve lines, legacy FX letters and Shift-JIS files.

Importing a chart and saving it again keeps everything, including unknown options, comments and `#define_fx` lines. The four sample charts bundled with libkson re-export **byte-for-byte identical** to the files made by KSM's editor.

`scroll_speed`, `rotation_deg` and all `*_curve` lines are KSM v2 features. **File → Export for KSM v1** turns curves into straight steps and leaves out the v2-only events.

## Development

```
src/core.js      chart model, timing, KSH import/export, validation (no DOM; portable)
src/fx.js        FX hold / laser effects (SOUND VOLTEX engine model + USC DSP port) running in an AudioWorklet
src/audio.js     Web Audio playback clock, hitsound scheduling, waveform peaks
src/sdvx.js      SOUND VOLTEX export: .vox writer, MS-ADPCM + .2dx, music_db, zip
src/timeline.js  MMW-style timeline renderer
src/preview.js   SDVX highway preview (USC camera + engine tilt model)
src/editor.js    state, undo/redo, tools and mouse editing
src/ui.js        menus, panels, keyboard, files, main loop
build.js         inlines src/ into index.html
```

```
node build.js                                              # rebuild index.html
git clone https://github.com/kshootmania/libkson ../libkson
node tests/core.test.js ../libkson/tests/assets            # KSH tests against libkson's charts
node tests/export.test.js [chart.ksh reference.vox]        # USC / SDVX exporters (optionally vs a known-good .vox)
node tests/fx.test.js                                      # effect engine, rendered offline
node tests/make_wav.js click150.wav 150 0.5 40             # test click track
npm i playwright && node tests/e2e.js <dir with click150.wav> <screenshot dir>
```

The old React editor is kept in `legacy/`.

### Desktop port

`src/core.js` has no browser dependencies, so it can be ported to C++ (e.g. on top of libkson in the MikuMikuWorld fork). The other route is to wrap this exact app in a native window with Tauri or Electron, which gives native file dialogs and saving.
