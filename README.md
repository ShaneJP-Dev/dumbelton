# Musical

A simpler take on Ableton for bands, worship teams and anyone learning songs. Upload a song's stems
(drums, bass, keys, vocals, click…) and you immediately **see its structure**: intro, verses, choruses,
bridge and outro, as coloured blocks above the tracks. Then:

- **Practice**: tap a section to jump to it, loop it, slow it down (50–100%) without changing the pitch,
  mute or solo tracks, and add a click track and a one-bar count-in.
- **Arrange**: build a new order (say an extra chorus at the end) by tapping and dragging sections, play
  it seamlessly, and export it as a WAV mix or a ZIP of per-track WAVs.
- **Live**: big pads for each section. Tap one and it starts at the end of the current section, or at
  the next bar. Setlists load the next song in advance. Works with keyboard shortcuts and Bluetooth
  page-turner pedals.

Everything runs in the browser and is stored on the device. A small Python service only analyses audio
to find beats and sections.

## Run it

You need [Node 22](https://nodejs.org) with pnpm (`corepack enable`), and [uv](https://docs.astral.sh/uv/getting-started/installation/).
uv fetches Python 3.11 and the analysis libraries itself.

```bash
git clone -b claude/inspiring-planck-o3882y https://github.com/SudoVault-Software/musical-app.git
```

```bash
cd musical-app
```

```bash
pnpm install
```

```bash
pnpm start
```

Then open http://localhost:8000. `pnpm start` builds the app and runs one server for the app and the
analysis service. The first start takes a few minutes while uv downloads Python and librosa. The first
song after a restart is analysed about 30 s more slowly while the analyzer warms up.

### Importing stems

Choose the stem files, choose a whole folder, or drag a folder onto the page. M4A, WAV, MP3, FLAC,
AIFF and OGG all work. Stems exported from Ableton often come with `.asd` files next to them
(`Drums.m4a.asd`). Those are Ableton's analysis data, not audio, so they are skipped, as are Ableton
project files and macOS `._` files.

### Working on the code

Run the analysis service and the Vite dev server (with hot reload) separately, then open
http://localhost:5173:

```bash
pnpm analyzer
```

```bash
pnpm dev
```

Or run the analysis service with Docker instead of uv:

```bash
docker compose up analyzer
```

### Using it from an iPad or another device

The browser features the app relies on (AudioWorklet and its private file storage) only work in a
**secure context**: `https://…`, or `http://localhost` on the same machine. Opening
`http://192.168.x.x:8000` from an iPad will not work. Put the server behind HTTPS (a reverse proxy with a
certificate, or a tunnel) and open that address. On iPad, add the page to the Home Screen so Safari
does not evict stored songs after 7 days without use.

### Better section names (optional)

The default analyzer (`librosa`) is fast and needs no machine-learning models. It finds boundaries
reliably and labels sections with musical heuristics: the loudest repeated part is the chorus, and so
on. For better labels on real recordings, the `allin1` backend uses the
[All-In-One](https://github.com/mir-aidj/all-in-one) model:

```bash
docker compose --profile allin1 up analyzer-allin1
```

It is much heavier (PyTorch plus model weights, about 1–3 minutes per song on CPU). Its image build
downloads from download.pytorch.org, shi-labs.com, github.com and huggingface.co. It has not been
verified in this repository's test environment, because those hosts were not reachable there.

Whatever the analyzer finds, every section can be adjusted by hand: drag the edges (they snap to bars or
beats), rename, change type, split, merge or delete. If the analyzer is not running, songs still import
and play, and you can mark sections by hand.

## Keyboard

| Key | Practice | Live |
| --- | --- | --- |
| Space | Play / pause | Play / pause |
| 1–9 | Jump to section | Queue section |
| ← → / PageUp PageDown | Previous / next section | Queue previous / next section |
| Shift + ← → | | Previous / next song in the setlist |
| L | Loop selected section | |
| C | Click on / off | Click on / off |

Held keys are ignored, so pedals that auto-repeat do not skip sections.

## How it works

```
web/                       React + TypeScript (Vite)
  src/audio/core/          RenderCore: the whole playback engine, no DOM (unit-tested)
    RenderCore.ts          one read position for all stems; programs, crossfades, queued jumps, click
    LinkedWsola.ts         time-stretch with identical splice points for every stem
  src/audio/worklet/       AudioWorklet wrapping RenderCore
  src/audio/engine/        main-thread API, playhead clock, iOS audio session
  src/audio/import/        decode -> 48 kHz Int16 blocks in OPFS, waveform peaks, analysis mixdown
  src/audio/export/        offline rendering with the same RenderCore -> WAV / ZIP
  src/lib, src/state, src/components, src/views    data model, storage (IndexedDB), UI
analyzer/                  FastAPI service: POST /api/jobs, GET /api/jobs/{id}
  app/backends/            librosa (default) and allin1
  app/postprocess.py       onset-refined downbeats, snapping to bars, numbering ("Verse 2")
scripts/make_test_song.py  synthetic multitrack song with a known structure (used by tests)
```

Key design choices:

- **Stems cannot drift.** Every stem is read from a single integer position inside one AudioWorklet,
  rather than one Web Audio source per stem.
- **Slowing down keeps stems together.** Separate time-stretchers would splice each stem at different
  points, so stems would wander 10–20 ms apart. Here one splice offset per grain is chosen on the full
  mix and applied to every stem. At 100% speed the audio passes through bit-exact.
- **Jumps land on the beat.** Live mode sends a rule ("end of section", "next bar") rather than a time.
  The audio thread resolves it against the downbeat grid, so a late tap or message cannot miss the
  boundary. Every join is a 10 ms equal-power crossfade that ends on the target downbeat.
- **Exports match playback.** Export runs the same engine faster than real time in a worker, streaming
  to disk.
- **Memory stays bounded on iPads.** Audio is stored as 16-bit, mono when L and R are identical, and
  silent 1.4-second blocks are not stored at all. Live mode keeps at most two songs loaded (the current
  one plus the preloaded next), within a memory budget.

## Tests

```bash
pnpm test
```

runs the web unit tests (Vitest: engine, stretch, export, sections) and the analyzer tests (pytest).

```bash
pnpm e2e
```

runs the end-to-end tests (Playwright, Chromium). They start both servers and drive the app with a
synthetic song: import, section detection, seek, loop, mute, arrangement export length, a Live
quantised jump, working without the analyzer, and importing a folder of `.m4a` stems with their
Ableton `.asd` files (that test needs ffmpeg to create the m4a files, and is skipped without it).

The engine benchmark test requires 12 stereo stems at 0.5× speed to render at least 40× faster than
real time (about 100× on a laptop).

## Not done yet

- Not tested on a real iPad. The iOS-specific handling (audio session, interruptions, wake lock,
  memory budget) is in place but has only run in desktop Chromium.
- A separate cue/in-ear output (click and guide on outputs 3–4), MIDI pedals, and cloud sync or sharing.
