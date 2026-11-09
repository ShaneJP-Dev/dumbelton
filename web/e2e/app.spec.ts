import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { M4A_DIR, SONG_DIR } from './global-setup';

const STEMS = ['drums', 'bass', 'keys', 'lead', 'click'].map((n) => resolve(SONG_DIR, `${n}.wav`));
const SR = 48000;

interface Truth {
  sections: { kind: string; start: number; end: number }[];
}

type Report = { frame: number; segment: number; playing: boolean; pending: { at: number; to: number } | null };
const report = (page: Page) =>
  page.evaluate(() => (window as unknown as { __engine: { clock: { report: Report } } }).__engine.clock.report);

/** A saved song: the one named `name`, or the first one. */
async function project(page: Page, name?: string) {
  return page.evaluate(
    (name) =>
      new Promise<{ sections: { name: string; start: number; end: number }[]; stems: { name: string; muted: boolean; gain: number }[] }>((res) => {
        const req = indexedDB.open('musical');
        req.onsuccess = () => {
          req.result.transaction('projects').objectStore('projects').getAll().onsuccess = (e) => {
            const all = (e.target as IDBRequest).result as { name: string }[];
            res((all.find((p) => p.name === name) ?? all[0]) as never);
          };
        };
      }),
    name,
  );
}

async function importSong(page: Page, name: string) {
  await page.goto('/');
  await page.getByTestId('new-song').click();
  await page.getByRole('dialog').getByTestId('file-input').setInputFiles(STEMS);
  await page.getByTestId('song-name').fill(name);
  await page.getByTestId('import').click();
  await page.waitForURL(/#\/song\//);
}

/** A mono 16-bit 48 kHz WAV of a sine tone. */
function toneWav(freq: number, seconds: number): Buffer {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(0.7 * 32767 * Math.sin((2 * Math.PI * freq * i) / SR)), 44 + i * 2);
  return buf;
}

/** Output level (RMS, dBFS) measured on the engine's output in the page. */
const outputLevel = (page: Page, ms = 700) =>
  page.evaluate(async (ms) => {
    const w = window as unknown as { __engine: { ctx: AudioContext; node: AudioNode }; __an?: AnalyserNode };
    if (!w.__an) {
      w.__an = w.__engine.ctx.createAnalyser();
      w.__an.fftSize = 2048;
      w.__engine.node.connect(w.__an);
    }
    const a = w.__an;
    const buf = new Float32Array(a.fftSize);
    let sum = 0;
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      a.getFloatTimeDomainData(buf);
      for (const v of buf) sum += v * v;
      n += buf.length;
      await new Promise((r) => setTimeout(r, 40));
    }
    return 10 * Math.log10(sum / n + 1e-20);
  }, ms);

test.describe.serial('song workflow', () => {
  let page: Page;
  const truth = JSON.parse(readFileSync(resolve(SONG_DIR, 'structure.json'), 'utf8')) as Truth;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('imports stems and finds the song sections', async () => {
    await importSong(page, 'E2E Song');
    await expect(page.getByTestId('track-header')).toHaveCount(5);
    await expect(page.getByTestId('section')).toHaveCount(truth.sections.length, { timeout: 120_000 });
    const names = await page.getByTestId('section').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
    expect(names).toEqual(['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro']);
    // edits are saved after a short debounce; wait for the stored copy before reading it
    await expect.poll(async () => (await project(page))?.sections?.length ?? 0).toBe(truth.sections.length);
    const p = await project(page);
    p.sections.forEach((s, i) => expect(Math.abs(s.start / SR - truth.sections[i].start)).toBeLessThan(0.1));
  });

  test('tapping a section moves the playhead to its start', async () => {
    const p = await project(page);
    const chorus2 = p.sections.find((s) => s.name === 'Chorus 2')!;
    await page.locator('[data-testid=section][data-name="Chorus 2"]').click();
    await expect.poll(async () => (await report(page)).frame).toBe(chorus2.start);
  });

  test('loop keeps playback inside the selected section', async () => {
    const p = await project(page);
    const chorus2 = p.sections.find((s) => s.name === 'Chorus 2')!;
    await page.getByRole('button', { name: /Loop/ }).click();
    await page.evaluate((f) => (window as unknown as { __engine: { seek(f: number): void } }).__engine.seek(f), chorus2.end - SR / 2);
    await page.getByTestId('play').click();
    await page.waitForTimeout(1500);
    const r = await report(page);
    expect(r.frame).toBeGreaterThanOrEqual(chorus2.start - 480);
    expect(r.frame).toBeLessThan(chorus2.start + 2 * SR);
    await page.getByTestId('play').click();
    await page.getByRole('button', { name: /Loop/ }).click();
  });

  test('mute is applied and saved', async () => {
    await page.getByRole('button', { name: 'Mute click' }).click();
    await expect(page.getByRole('button', { name: 'Mute click' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await project(page)).stems.find((s) => s.name === 'click')?.muted).toBe(true);
  });

  test('a track volume in dB changes the audible level by that amount', async () => {
    const keys = page.getByTestId('track-header').filter({ hasText: 'keys' });
    await page.getByRole('button', { name: 'Solo keys' }).click();
    await page.locator('[data-testid=section][data-name="Verse 1"]').click();
    await page.getByTestId('play').click();
    await page.waitForTimeout(300);
    const before = await outputLevel(page);
    await expect(keys.getByTestId('db-readout')).toHaveText('0.0 dB');
    await keys.getByTestId('db-readout').click();
    await keys.getByTestId('db-input').fill('-12');
    await keys.getByTestId('db-input').press('Enter');
    await expect(keys.getByTestId('db-readout')).toHaveText('\u221212.0 dB');
    await page.waitForTimeout(200);
    const after = await outputLevel(page);
    expect(after - before).toBeGreaterThan(-13.5);
    expect(after - before).toBeLessThan(-10.5);
    await expect.poll(async () => (await project(page)).stems.find((s) => s.name === 'keys')?.gain).toBeCloseTo(0.2512, 3);
    // double-click the fader: back to 0 dB
    await page.getByLabel('keys volume', { exact: true }).dblclick();
    await expect(keys.getByTestId('db-readout')).toHaveText('0.0 dB');
    await page.getByTestId('play').click();
    await page.getByRole('button', { name: 'Solo keys' }).click();
  });

  test('the master fader sets the whole song level in dB, and the meter shows it', async () => {
    const master = page.getByTestId('master');
    await expect(master.getByTestId('db-readout')).toHaveText('0.0 dB');
    await page.locator('[data-testid=section][data-name="Chorus 1"]').click();
    await page.getByTestId('play').click();
    await page.waitForTimeout(300);
    const before = await outputLevel(page);
    // the meter shows the song level while playing
    await expect.poll(async () => Number(await page.getByTestId('level-meter').getAttribute('data-db'))).toBeGreaterThan(-40);
    await master.getByTestId('db-readout').click();
    await master.getByTestId('db-input').fill('-6');
    await master.getByTestId('db-input').press('Enter');
    await expect(master.getByTestId('db-readout')).toHaveText('\u22126.0 dB');
    await page.waitForTimeout(200);
    const after = await outputLevel(page);
    expect(after - before).toBeGreaterThan(-7.5);
    expect(after - before).toBeLessThan(-4.5);
    await expect
      .poll(async () => ((await project(page)) as unknown as { masterGain?: number }).masterGain ?? 1)
      .toBeCloseTo(0.501, 2);
    // stopped: the meter falls back to empty
    await page.getByTestId('play').click();
    await expect.poll(async () => Number(await page.getByTestId('level-meter').getAttribute('data-db')), { timeout: 6000 }).toBeLessThanOrEqual(-60);
  });

  test('an arrangement exports with the right length', async () => {
    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await expect(page.getByTestId('arr-item')).toHaveCount(8);
    await page.getByRole('button', { name: 'Clear' }).click();
    for (const n of ['Chorus 1', 'Verse 1', 'Chorus 1']) await page.locator(`[data-testid=palette-chip][data-name="${n}"]`).click();
    await expect(page.getByTestId('arr-item')).toHaveCount(3);
    // the tracks show the arrangement itself, in its order
    const clipNames = () => page.getByTestId('clip').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
    await expect.poll(clipNames).toEqual(['Chorus 1', 'Verse 1', 'Chorus 1']);
    const p = await project(page);
    const len = (n: string) => {
      const s = p.sections.find((x) => x.name === n)!;
      return s.end - s.start;
    };
    const expected = 2 * len('Chorus 1') + len('Verse 1');
    await page.getByTestId('export').click();
    await page.getByTestId('export-run').click();
    await expect(page.getByTestId('save-file')).toBeVisible({ timeout: 60_000 });
    const frames = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
      const f = await (await dir.getFileHandle('mix.wav')).getFile();
      const v = new DataView(await f.slice(0, 44).arrayBuffer());
      return v.getUint32(40, true) / (v.getUint16(22, true) * (v.getUint16(34, true) / 8));
    });
    expect(frames).toBe(expected);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-file').click()]);
    expect(download.suggestedFilename()).toBe('E2E Song - My arrangement.wav');
    await page.getByRole('button', { name: 'Done' }).click();
    // removing a section from the arrangement takes it off the tracks too
    await page.getByRole('button', { name: 'Remove Verse 1', exact: true }).click();
    await expect.poll(clipNames).toEqual(['Chorus 1', 'Chorus 1']);
  });

  test('live: a queued section starts exactly at the end of the current one', async () => {
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.getByTestId('pad')).toHaveCount(8);
    const p = await project(page);
    const intro = p.sections[0];
    const bridgeIndex = p.sections.findIndex((s) => s.name === 'Bridge');
    await page.getByTestId('pad').first().click(); // go to the intro
    await page.getByRole('button', { name: 'At end of section' }).click();
    await page.getByTestId('fade-4').click(); // fade over 1 bar
    await page.getByTestId('play').click();
    await page.locator('[data-testid=pad][data-name="Bridge"]').click();
    await expect.poll(async () => (await report(page)).pending).toEqual({ at: intro.end, to: bridgeIndex });
    await expect(page.locator('[data-testid=pad][data-name="Bridge"]')).toContainText('Next');
    // the fade starts one bar before the boundary: the Bridge's lead-in comes in under the Intro
    await expect.poll(async () => (await report(page)).segment, { timeout: 15_000, intervals: [40] }).toBe(bridgeIndex);
    const db = (await project(page)) as unknown as { downbeats: number[] };
    const bar = db.downbeats[5] - db.downbeats[4];
    const bridgeStart = p.sections[bridgeIndex].start;
    const r = await report(page);
    expect(r.frame).toBeGreaterThan(bridgeStart - bar - 4800);
    expect(r.frame).toBeLessThan(bridgeStart);
    // ...and the Bridge itself plays from its first downbeat
    await expect.poll(async () => (await report(page)).frame, { timeout: 5000 }).toBeGreaterThanOrEqual(bridgeStart);
    await page.getByTestId('play').click();
  });

  test('the live screen lists every song and setlist', async () => {
    await importSong(page, 'Second Song');
    await expect(page.getByTestId('section').first()).toBeVisible({ timeout: 120_000 });
    await page.goto('/#/setlists');
    await page.getByTestId('new-setlist').click();
    await page.getByTestId('add-song').selectOption({ label: 'E2E Song' });
    await page.getByTestId('add-song').selectOption({ label: 'Second Song' });
    await expect(page.getByTestId('setlist-entry')).toHaveCount(2);
    // open a song in Live from the library: all songs are listed, the open one marked
    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    const list = page.getByTestId('live-song-list');
    await expect(list.getByTestId('live-song')).toHaveCount(2);
    await expect(list.locator('[data-testid=live-song][data-name="E2E Song"]')).toContainText('Now');
    // tapping another song switches to it and stays in Live
    await list.locator('[data-testid=live-song][data-name="Second Song"]').click();
    await expect(page.locator('input[aria-label="Song name"]')).toHaveValue('Second Song');
    // each song keeps its own master level (E2E Song was set to -6 dB earlier)
    await expect(page.getByTestId('master').getByTestId('db-readout')).toHaveText('0.0 dB');
    await expect(page.getByTestId('live-panel')).toBeVisible();
    // pick the setlist and start it from its first song
    await list.getByTestId('song-list-picker').selectOption({ label: 'Setlist 1 (2)' });
    await list.locator('[data-testid=live-song][data-name="E2E Song"]').click();
    await expect(page.locator('input[aria-label="Song name"]')).toHaveValue('E2E Song');
    await expect(list.getByTestId('next-song')).toHaveText(/Next: Second Song/);
    await expect(page.getByTestId('master').getByTestId('db-readout')).toHaveText('\u22126.0 dB');
    await expect(list.locator('[data-testid=live-song][data-name="E2E Song"]')).toContainText('Now');
  });

  test('multitrack outputs: each group lands on its own channels', async () => {
    // per-channel peak levels of the engine's 32 outputs, as the desk receives them (the Desk panel's meters)
    const levels = () =>
      page.evaluate(async () => {
        const e = (window as unknown as { __engine: { readChannelPeaks(): Float32Array } }).__engine;
        e.readChannelPeaks();
        const peak = new Array(32).fill(0);
        for (let t = 0; t < 12; t++) {
          await new Promise((r) => setTimeout(r, 50));
          e.readChannelPeaks().forEach((v, k) => (peak[k] = Math.max(peak[k], v)));
        }
        return peak as number[];
      });
    const engine = (fn: string, arg?: number) =>
      page.evaluate(([f, a]) => {
        const e = (window as unknown as { __engine: Record<string, (x?: number) => void> }).__engine;
        e[f as string](a as number | undefined);
      }, [fn, arg] as const);

    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.waitForURL(/#\/song\//);
    const songId = decodeURIComponent(page.url().split('#/song/')[1]);
    // wait until the audio engine has this song loaded (it opens in Live while a setlist runs)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __engine?: { activeSongId: string | null } }).__engine?.activeSongId ?? null))
      .toBe(songId);
    await page.goto('/#/outputs');
    await page.getByTestId('mode-multitrack').click();
    const routes = page.getByTestId('song-routing');
    await routes.getByLabel('Song').selectOption({ label: 'E2E Song' });
    const ch = (track: string) => routes.locator(`[data-testid=song-route][data-track="${track}"]`).getAttribute('data-channels');
    expect([await ch('click'), await ch('drums'), await ch('bass'), await ch('keys'), await ch('lead')]).toEqual(['1', '3–4', '5', '6–7', '12–13']);

    // play the first chorus (all instruments) and look at every output channel
    await engine('seek', 48000 * 26);
    await engine('play');
    let peak = await levels();
    const on = (k: number) => peak[k] > 0.01;
    // the song opened in Live (the setlist is running), where nothing is muted: the click track plays on 1
    expect([0, 2, 3, 4, 5, 6, 11, 12].filter(on)).toEqual([0, 2, 3, 4, 5, 6, 11, 12]); // click, drums, bass, keys, lead (Other)
    // guide (none), guitars, vocals and unused channels are silent
    expect([1, 7, 8, 9, 10, 13, 14, 20, 31].filter(on)).toEqual([]);

    // move Bass to channel 14
    await page.getByLabel('Bass first channel').fill('14');
    await expect.poll(() => ch('bass')).toBe('14');
    await page.waitForTimeout(150);
    peak = await levels();
    expect(peak[13]).toBeGreaterThan(0.01);
    expect(peak[4]).toBe(0);

    // test tone on the Guide channel (2), with playback stopped
    await engine('pause');
    await page.waitForTimeout(200);
    await page.getByTestId('test-guide').click();
    peak = await levels();
    expect(peak[1]).toBeGreaterThan(0.1);
    expect(peak[0]).toBe(0);

    await page.getByTestId('mode-stereo').click();
  });

  test('Live starts with nothing muted; tap a track or group to mute it, hold Mute all for 2 seconds', async () => {
    type E = { __engine: { stemParams: { mute?: boolean }[]; clickParams: { enabled?: boolean } } };
    const mutes = () => page.evaluate(() => (window as unknown as E).__engine.stemParams.map((p) => !!p.mute));
    const clickPlays = () => page.evaluate(() => !!(window as unknown as E).__engine.clickParams.enabled);
    const holdFor = async (target: ReturnType<typeof page.locator>, ms: number) => {
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(ms);
      await page.mouse.up();
    };
    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await page.getByRole('button', { name: 'Mute drums' }).click();
    await expect(page.getByRole('button', { name: 'Mute click' })).toHaveAttribute('aria-pressed', 'true'); // from an earlier test
    await expect.poll(async () => (await mutes()).filter(Boolean).length).toBe(2);
    await page.getByTitle('Click track from the beat grid').click(); // the app's own click on
    await expect.poll(clickPlays).toBe(true);

    // Live: everything plays
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    const chips = page.getByTestId('live-track');
    await expect(chips).toHaveCount(5);
    await expect.poll(mutes).toEqual([false, false, false, false, false]);
    const names = await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
    const only = (...muted: string[]) => names.map((n) => muted.includes(n!));
    const drums = page.locator('[data-testid=live-track][data-name="drums"]');

    // a tap mutes a track, another tap unmutes it
    await drums.click();
    await expect(drums).toHaveAttribute('data-muted', 'true');
    await expect.poll(mutes).toEqual(only('drums'));
    await drums.click();
    await expect(drums).toHaveAttribute('data-muted', 'false');
    await expect.poll(mutes).toEqual(only());

    // groups come from the Outputs screen ("lead" matches no group, so it is in Other)
    const groups = page.getByTestId('live-group');
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))).toEqual(['click', 'drums', 'bass', 'keys', 'other']);
    const group = (id: string) => page.locator(`[data-testid=live-group][data-group="${id}"]`);
    await group('drums').click();
    await expect.poll(mutes).toEqual(only('drums'));
    await expect(drums).toHaveAttribute('data-muted', 'true');
    await expect(drums).toContainText('Drums muted');
    // the Click group silences the click track and the app's click
    await group('click').click();
    await expect.poll(mutes).toEqual(only('drums', 'click'));
    await expect.poll(clickPlays).toBe(false);
    await group('click').click();
    await expect.poll(mutes).toEqual(only('drums'));
    await expect.poll(clickPlays).toBe(true);

    // Mute all: a short press does nothing, a 2-second hold silences everything
    const all = page.getByTestId('live-mute-all');
    await holdFor(all, 800);
    await expect(all).toHaveAttribute('data-muted', 'false');
    expect(await mutes()).toEqual(only('drums'));
    await holdFor(all, 2400);
    await expect(all).toHaveAttribute('data-muted', 'true');
    await expect.poll(mutes).toEqual([true, true, true, true, true]);
    await expect.poll(clickPlays).toBe(false);
    // a tap brings back exactly what was playing (the Drums group stays muted)
    await all.click();
    await expect(all).toHaveAttribute('data-muted', 'false');
    await expect.poll(mutes).toEqual(only('drums'));
    await expect.poll(clickPlays).toBe(true);

    // back in Practice the song's own mutes return
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await expect.poll(mutes).toEqual(only('drums', 'click'));
    // and opening Live again starts with nothing muted
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect.poll(mutes).toEqual(only());
    await expect(group('drums')).toHaveAttribute('data-muted', 'false');

    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await page.getByRole('button', { name: 'Mute drums' }).click();
    await page.getByTitle('Click track from the beat grid').click();
  });

  test('Repeat loops the current section until another one is tapped', async () => {
    type E = { __engine: { seek: (f: number, s?: number) => void; play: () => void; pause: () => void; repeat: boolean } };
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    const p = await project(page, 'E2E Song');
    const intro = p.sections[0];
    await page.getByTestId('pad').first().click();
    await page.getByRole('button', { name: 'At next bar' }).click();
    const repeat = page.getByTestId('live-repeat');
    await repeat.click();
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as unknown as E).__engine.repeat)).toBe(true);
    // start one second before the end of the intro: it comes round to its start instead of going on
    await page.evaluate((f) => {
      const e = (window as unknown as E).__engine;
      e.seek(f, 0);
      e.play();
    }, intro.end - SR);
    await page.waitForTimeout(1600);
    let r = await report(page);
    expect(r.segment).toBe(0);
    expect(r.frame).toBeLessThan(intro.start + SR);
    await expect(page.locator('[data-testid=pad]').first().getByTestId('pad-repeat')).toBeVisible();
    // tap the next section: it lands at the next bar and the repeat ends
    await page.getByTestId('pad').nth(1).click();
    await expect.poll(async () => (await report(page)).segment, { timeout: 8000 }).toBe(1);
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    // (an earlier test set a 1-bar fade, so the lead-in plays first) then it carries on in section 2
    await expect.poll(async () => (await report(page)).frame, { timeout: 5000 }).toBeGreaterThanOrEqual(p.sections[1].start);
    r = await report(page);
    expect(r.segment).toBe(1);
    await page.evaluate(() => (window as unknown as E).__engine.pause());
    // keyboard R toggles it too
    await page.keyboard.press('r');
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('r');
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
  });

  test('spoken cues say the next part on the Guide channel a bar before it starts', async () => {
    // a stand-in for the computer's voice: every word is a short 600 Hz tone
    const kinds = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'interlude', 'tag', 'vamp', 'solo', 'inst', 'break', 'outro'];
    await page.route('**/api/voice/en', (route) => route.fulfill({ json: { available: true, voice: 'Test Voice', kinds } }));
    await page.route('**/api/voice/en/*.wav', (route) =>
      route.fulfill({ body: toneWav(600, 0.3), headers: { 'content-type': 'audio/wav' } }),
    );
    type E = {
      __engine: {
        ctx: AudioContext;
        node: AudioNode;
        seek: (f: number, s?: number) => void;
        play: () => void;
        pause: () => void;
        cueParams: { enabled?: boolean; natural?: boolean };
        cueClipCount: number;
        readChannelPeaks(): Float32Array;
      };
    };
    await page.goto('/#/outputs');
    await page.getByTestId('mode-multitrack').click();
    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.waitForURL(/#\/song\//);
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    const cues = page.getByTestId('live-cues');
    await expect(cues).toHaveAttribute('data-voice', 'ready');
    await expect(cues).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as unknown as E).__engine.cueClipCount)).toBe(12);
    await expect.poll(() => page.evaluate(() => (window as unknown as E).__engine.cueParams)).toMatchObject({ enabled: true, natural: true });

    const intro = (await project(page, 'E2E Song')).sections[0];
    // play from 1.5 bars (3 s) before the end of the intro, watching the Guide channel (2)
    const trace = await page.evaluate(async (from) => {
      const e = (window as unknown as E).__engine;
      e.seek(from, 0);
      e.play();
      e.readChannelPeaks();
      const t0 = performance.now();
      const out: [number, number][] = [];
      while (performance.now() - t0 < 2400) {
        await new Promise((r) => setTimeout(r, 20));
        out.push([performance.now() - t0, e.readChannelPeaks()[1]]); // the Guide channel, as the desk gets it
      }
      e.pause();
      return out;
    }, intro.end - 3 * SR);
    const loud = trace.filter(([, pk]) => pk > 0.05).map(([t]) => t);
    expect(loud.length).toBeGreaterThan(3);
    // the word starts one bar (2 s) before the verse, i.e. about 1 s after playing from 3 s before it
    expect(loud[0]).toBeGreaterThan(700);
    expect(loud[0]).toBeLessThan(1500);
    expect(trace.filter(([t]) => t < 600).every(([, pk]) => pk < 0.01)).toBe(true);

    // turning cues off is remembered and tells the engine
    await cues.click();
    await expect(cues).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => (window as unknown as E).__engine.cueParams.enabled)).toBe(false);
    await cues.click();
    await expect(cues).toHaveAttribute('aria-pressed', 'true');

    await page.unroute('**/api/voice/en');
    await page.unroute('**/api/voice/en/*.wav');
    await page.goto('/#/outputs');
    await page.getByTestId('mode-stereo').click();
  });

  test('the key shows as a letter, changes by semitone or by choosing a key, and exports keep their length', async () => {
    type E = { __engine: { transpose: number } };
    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.waitForURL(/#\/song\//);
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    const value = page.getByTestId('key-value');
    // the analyzer found the synthetic song's key (it uses Am, F, C and G)
    await expect(value).toHaveText(/^(C|Am)$/);
    // correct it by hand to G
    await page.getByTestId('key-name').click();
    await page.getByTestId('original-key').selectOption({ label: 'G' });
    await expect(value).toHaveText('G');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('key-menu')).toHaveCount(0);
    await page.getByTestId('key-up').click();
    await page.getByTestId('key-up').click();
    await expect(value).toHaveText('A');
    expect(await page.evaluate(() => (window as unknown as E).__engine.transpose)).toBe(2);
    // choose the key to play in: G -> D is 5 down
    await page.getByTestId('key-name').click();
    await expect(page.locator('[data-testid=play-in][data-key="A"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-testid=play-in][data-key="D"]').click();
    await expect(value).toHaveText('D');
    expect(await page.evaluate(() => (window as unknown as E).__engine.transpose)).toBe(-5);
    await expect.poll(async () => ((await project(page, 'E2E Song')) as unknown as { transpose?: number; key?: { tonic: number; source: string } }).key).toEqual({
      tonic: 7,
      minor: false,
      source: 'set',
    });
    // it comes back with the song
    await page.reload();
    await expect(value).toHaveText('D');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __engine?: E['__engine'] }).__engine?.transpose)).toBe(-5);

    // an export in the new key has the same length as the arrangement
    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    const p = await project(page, 'E2E Song');
    const chorus = p.sections.find((x) => x.name === 'Chorus 1')!;
    await expect(page.getByTestId('arr-item')).toHaveCount(2); // Chorus 1, Chorus 1 (from the export test)
    await page.getByTestId('export').click();
    await expect(page.getByText('In D (−5 semitones)')).toBeVisible();
    await page.getByTestId('export-run').click();
    await expect(page.getByTestId('save-file')).toBeVisible({ timeout: 60_000 });
    const frames = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
      const f = await (await dir.getFileHandle('mix.wav')).getFile();
      const v = new DataView(await f.slice(0, 44).arrayBuffer());
      return v.getUint32(40, true) / (v.getUint16(22, true) * (v.getUint16(34, true) / 8));
    });
    expect(frames).toBe(2 * (chorus.end - chorus.start));
    await page.getByRole('button', { name: 'Done' }).click();

    // back to the original key
    await page.getByTestId('key-name').click();
    await page.locator('[data-testid=play-in][data-key="G"]').click();
    await expect(value).toHaveText('G');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
  });

  test('the Desk panel shows every output channel with a meter, and the laptop can listen to one', async () => {
    type E = {
      __engine: {
        ctx: AudioContext;
        node: AudioNode;
        outputChannels: number;
        monitor: { kind: string; ch?: number } | null;
        play: () => void;
        pause: () => void;
        seek: (f: number) => void;
        readChannelPeaks(): Float32Array;
      };
    };
    await page.goto('/#/outputs');
    await page.getByTestId('mode-multitrack').click();
    await page.getByLabel('Bass first channel').fill('5'); // an earlier test moved it to 14
    await page.goto('/');
    await page.getByTestId('song-card').filter({ hasText: 'E2E Song' }).click();
    await page.waitForURL(/#\/song\//);
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await page.getByTestId('desk-toggle').click();
    await expect(page.getByTestId('desk-panel')).toBeVisible();
    const strips = page.getByTestId('desk-strip');
    expect(await strips.evaluateAll((els) => els.map((e) => e.getAttribute('data-label')))).toEqual([
      'Click',
      'Guide',
      'Drums L',
      'Drums R',
      'Bass',
      'Keys L',
      'Keys R',
      'Guitars L',
      'Guitars R',
      'Vocals L',
      'Vocals R',
      'Other L',
      'Other R',
    ]);
    await expect(page.locator('[data-testid=desk-strip][data-ch="12"]')).toContainText('lead');
    // this test browser has a 2-channel output, like a laptop: it plays the full mix
    expect(await page.evaluate(() => (window as unknown as E).__engine.outputChannels)).toBeLessThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => (window as unknown as E).__engine.monitor)).toEqual({ kind: 'mix' });
    await expect(page.getByTestId('desk-mix')).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => {
      const e = (window as unknown as E).__engine;
      e.seek(48000 * 10);
      e.play();
    });
    const strip = (ch: number) => page.locator(`[data-testid=desk-strip][data-ch="${ch}"]`);
    const level = async (ch: number) => {
      const v = await strip(ch).getAttribute('data-level');
      return v === '-inf' ? -Infinity : Number(v);
    };
    await expect.poll(() => level(3), { timeout: 5000 }).toBeGreaterThan(-40); // drums
    await expect.poll(() => level(5)).toBeGreaterThan(-40); // bass
    expect(await level(2)).toBe(-Infinity); // nothing on the Guide channel in this song
    expect(await level(8)).toBe(-Infinity); // no guitars

    // listen to the bass channel on the laptop: outputs 1-2 then carry just the bass
    await strip(5).getByTestId('desk-listen').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as E).__engine.monitor)).toEqual({ kind: 'channel', ch: 4 });
    // over the same half second: the loudest the laptop's output 1 got, and the loudest the Bass and Drums strips showed
    const m = await page.evaluate(async () => {
      const e = (window as unknown as E).__engine;
      const split = e.ctx.createChannelSplitter(32);
      e.node.connect(split);
      const a = e.ctx.createAnalyser();
      a.fftSize = 2048;
      split.connect(a, 0);
      const stripDb = (ch: number) => {
        const v = document.querySelector(`[data-testid=desk-strip][data-ch="${ch}"]`)?.getAttribute('data-level');
        return v && v !== '-inf' ? Number(v) : -Infinity;
      };
      let out = 0;
      let bass = -Infinity;
      let drums = -Infinity;
      const buf = new Float32Array(2048);
      for (let t = 0; t < 25; t++) {
        await new Promise((r) => setTimeout(r, 20));
        a.getFloatTimeDomainData(buf);
        for (const v of buf) out = Math.max(out, Math.abs(v));
        bass = Math.max(bass, stripDb(5));
        drums = Math.max(drums, stripDb(3));
      }
      split.disconnect();
      return { out: 20 * Math.log10(out), bass, drums };
    });
    // output 1 now plays the bass channel, at the level its strip shows
    expect(m.bass).toBeGreaterThan(-40);
    expect(Math.abs(m.out - m.bass)).toBeLessThan(3);
    // tap again: back to the full mix
    await strip(5).getByTestId('desk-listen').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as E).__engine.monitor)).toEqual({ kind: 'mix' });

    await page.evaluate(() => (window as unknown as E).__engine.pause());
    await page.getByTestId('desk-toggle').click();
    await expect(page.getByTestId('desk-panel')).toHaveCount(0);
    await page.goto('/#/outputs');
    await page.getByTestId('mode-stereo').click();
  });
});

test('without the analyzer, sections can be marked by hand and added anywhere', async ({ page }) => {
  await page.route('**/api/jobs', (route) => route.fulfill({ status: 502, body: 'Bad Gateway' }));
  await importSong(page, 'Offline Song');
  await expect(page.getByText(/analysis server is not running/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Mark sections by hand' }).click();
  await expect(page.getByTestId('section')).toHaveCount(1);
  const seek = (sec: number) =>
    page.evaluate((f) => (window as unknown as { __engine: { seek(f: number): void } }).__engine.seek(f), 48000 * sec);
  // Add section at the playhead; the new section is selected so it can be retyped
  await seek(30);
  await page.waitForTimeout(200);
  await page.getByTestId('add-section').click();
  await expect(page.getByTestId('section')).toHaveCount(2);
  await page.getByRole('group', { name: 'Section type' }).getByRole('button', { name: 'Tag' }).click();
  await expect(page.locator('[data-testid=section][data-name="Tag"]')).toHaveCount(1);
  // the A key adds one while listening
  await seek(60);
  await page.waitForTimeout(200);
  await page.keyboard.press('a');
  await expect(page.getByTestId('section')).toHaveCount(3);
  // too close to the start of a section: refused with a message
  await seek(60.3);
  await page.waitForTimeout(200);
  await page.keyboard.press('a');
  await expect(page.getByRole('status')).toContainText('Too close to the start');
  await expect(page.getByTestId('section')).toHaveCount(3);
  // double-click the bar to add a section right there
  const last = page.getByTestId('section').last();
  const box = (await last.boundingBox())!;
  await last.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByTestId('section')).toHaveCount(4);

  // with no key yet the key shows in semitones; "Find the key" asks the analyzer for it alone
  await expect(page.getByTestId('key-value')).toHaveText('0');
  await page.route('**/api/key', (route) => route.fulfill({ json: { key: { tonic: 2, mode: 'major', name: 'D', confidence: 0.2 } } }));
  await page.getByTestId('key-name').click();
  await page.getByTestId('find-key').click();
  await expect(page.getByTestId('key-value')).toHaveText('D');
  await expect(page.getByRole('status')).toContainText('This song is in D');
  await expect(page.locator('[data-testid=play-in][data-key="D"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a guide track is sent with the mix, and its spoken cues place the sections', async ({ page }, testInfo) => {
  const truth = JSON.parse(readFileSync(resolve(SONG_DIR, 'structure.json'), 'utf8')) as Truth & { duration: number };
  let body = '';
  await page.route('**/api/jobs', async (route) => {
    body = route.request().postDataBuffer()?.toString('latin1') ?? '';
    await route.fulfill({ status: 202, json: { id: 'guide-job' } });
  });
  const beats = Array.from({ length: Math.floor(truth.duration / 0.5) }, (_, i) => i * 0.5);
  await page.route('**/api/jobs/guide-job', (route) =>
    route.fulfill({
      json: {
        id: 'guide-job',
        status: 'done',
        progress: 1,
        result: {
          backend: 'librosa',
          duration: truth.duration,
          bpm: 120,
          beats,
          downbeats: beats.filter((_, i) => i % 4 === 0),
          sections: truth.sections.map((s) => ({ start: s.start, end: s.end, label: s.kind })),
          sectionsFrom: 'guide',
          guide: {
            status: 'ok',
            language: 'es',
            cues: truth.sections.slice(1).map((s) => ({ time: s.start - 2, end: s.start - 1.6, kind: s.kind, word: s.kind, conf: 1 })),
          },
        },
      },
    }),
  );
  // the click file stands in for a guide track
  const guide = testInfo.outputPath('guide.wav');
  mkdirSync(dirname(guide), { recursive: true });
  copyFileSync(resolve(SONG_DIR, 'click.wav'), guide);
  const files = [...STEMS.filter((f) => !f.endsWith('click.wav')), guide];
  await page.goto('/');
  await page.getByTestId('new-song').click();
  await page.getByRole('dialog').getByTestId('file-input').setInputFiles(files);
  await page.getByTestId('song-name').fill('Guide Song');
  await page.getByTestId('import').click();
  await page.waitForURL(/#\/song\//);

  await expect(page.getByText(/Sections placed from the guide track's spoken cues \(7 cues, Spanish\)/)).toBeVisible({ timeout: 30_000 });
  expect(body).toContain('name="audio"; filename="mix.wav"');
  expect(body).toContain('name="guide"; filename="guide.wav"');
  await expect(page.getByTestId('section')).toHaveCount(truth.sections.length);
  await expect(page.getByTestId('from-guide')).toBeVisible();
});

test('MIDI pedals: learn a pedal for a job, then it drives Live', async ({ browser }) => {
  const context = await browser.newContext();
  // a stand-in MIDI foot controller: the test "presses" it with window.__midiSend
  await context.addInitScript(() => {
    const input = { id: 'p1', name: 'Test Pedal', state: 'connected', onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    const access = { inputs: new Map([['p1', input]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
    (navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = async () => access;
    (window as unknown as { __midiSend: (b: number[]) => void }).__midiSend = (b) => input.onmidimessage?.({ data: new Uint8Array(b) });
  });
  const page = await context.newPage();
  const send = (...msgs: number[][]) =>
    page.evaluate((m) => m.forEach((b) => (window as unknown as { __midiSend: (b: number[]) => void }).__midiSend(b)), msgs);
  await importSong(page, 'MIDI Song');
  await expect(page.getByTestId('section')).toHaveCount(8, { timeout: 30_000 });

  await page.goto('/#/controls');
  await page.getByTestId('midi-connect').click();
  await expect(page.getByTestId('midi-inputs')).toContainText('Test Pedal');
  const row = (a: string) => page.locator(`[data-testid=midi-action][data-action="${a}"]`);
  await row('next-section').getByTestId('midi-learn').click();
  await expect(row('next-section').getByTestId('midi-trigger')).toHaveText('Press a pedal…');
  await send([0xb0, 64, 127], [0xb0, 64, 0]);
  await expect(row('next-section').getByTestId('midi-trigger')).toHaveText('CC 64 · ch 1');
  await row('mute-all').getByTestId('midi-learn').click();
  await send([0x90, 60, 100], [0x80, 60, 0]);
  await expect(row('mute-all').getByTestId('midi-trigger')).toHaveText('Note C4 · ch 1');
  await expect(page.getByTestId('midi-last')).toContainText('Note C4 · ch 1 · released');
  // the map is saved, and MIDI reconnects by itself next time
  await page.reload();
  await expect(page.getByTestId('midi-inputs')).toContainText('Test Pedal');
  await expect(row('next-section').getByTestId('midi-trigger')).toHaveText('CC 64 · ch 1');

  await page.goto('/');
  await page.getByTestId('song-card').filter({ hasText: 'MIDI Song' }).click();
  await page.waitForURL(/#\/song\//);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect.poll(async () => (await report(page))?.segment).toBe(0);
  // the pedal moves to the next section (stopped: straight there)
  await send([0xb0, 64, 127], [0xb0, 64, 0]);
  await expect.poll(async () => (await report(page)).segment).toBe(1);
  // a pedal that repeats its "pressed" value only counts once
  await send([0xb0, 64, 127], [0xb0, 64, 127], [0xb0, 64, 127], [0xb0, 64, 0]);
  await expect.poll(async () => (await report(page)).segment).toBe(2);

  // Mute all: a short press does nothing, a 2-second hold mutes, the next press unmutes
  const all = page.getByTestId('live-mute-all');
  await send([0x90, 60, 100]);
  await page.waitForTimeout(500);
  await send([0x80, 60, 0]);
  await page.waitForTimeout(1800);
  await expect(all).toHaveAttribute('data-muted', 'false');
  await send([0x90, 60, 100]);
  await page.waitForTimeout(2300);
  await send([0x80, 60, 0]);
  await expect(all).toHaveAttribute('data-muted', 'true');
  await send([0x90, 60, 100], [0x80, 60, 0]);
  await expect(all).toHaveAttribute('data-muted', 'false');
  await context.close();
});

test('imports m4a stems from a folder, skipping Ableton .asd files', async ({ page }) => {
  test.skip(!existsSync(resolve(M4A_DIR, 'click.m4a')), 'needs ffmpeg to make the m4a test files');
  await page.goto('/');
  await page.getByTestId('new-song').click();
  await page.getByRole('dialog').getByTestId('folder-input').setInputFiles(M4A_DIR);
  await expect(page.getByTestId('song-name')).toHaveValue('Folder Song');
  await expect(page.getByTestId('skipped-note')).toHaveText(
    'Skipped 5 Ableton .asd files (analysis data, not audio) and 1 other file.',
  );
  await expect(page.getByRole('dialog').getByRole('listitem')).toHaveCount(5);
  await page.getByTestId('import').click();
  await page.waitForURL(/#\/song\//);
  await expect(page.getByTestId('track-header')).toHaveCount(5);
  await expect(page.getByTestId('section')).toHaveCount(8, { timeout: 120_000 });
});

test('choosing only .asd files explains where the audio is', async ({ page }) => {
  test.skip(!existsSync(resolve(M4A_DIR, 'click.m4a')), 'needs ffmpeg to make the m4a test files');
  await page.goto('/');
  await page.getByTestId('new-song').click();
  await page
    .getByRole('dialog')
    .getByTestId('file-input')
    .setInputFiles(['drums', 'bass'].map((n) => resolve(M4A_DIR, `${n}.m4a.asd`)));
  await expect(page.getByTestId('skipped-note')).toContainText('choose the audio files next to them');
  await expect(page.getByTestId('import')).toBeDisabled();
});

test('songs move to another browser with a backup file', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  await importSong(p1, 'Backup Song');
  await expect(p1.getByTestId('section')).toHaveCount(8, { timeout: 120_000 });
  // change the arrangement so we can check it travels with the song
  await p1.getByRole('button', { name: 'Arrange', exact: true }).click();
  await expect(p1.getByTestId('arr-item')).toHaveCount(8);
  await p1.getByRole('button', { name: 'Remove Bridge', exact: true }).click();
  await expect(p1.getByTestId('arr-item')).toHaveCount(7);
  await p1.waitForTimeout(600); // edits are saved after a short delay
  await p1.goto('/');
  await p1.getByTestId('backup-link').click();
  await p1.getByTestId('make-backup').click();
  const [download] = await Promise.all([p1.waitForEvent('download'), p1.getByTestId('save-backup').click()]);
  expect(download.suggestedFilename()).toMatch(/^Musical backup \d{4}-\d{2}-\d{2}\.tar$/);
  const file = testInfo.outputPath('backup.tar');
  await download.saveAs(file);
  await ctx1.close();

  // a different, empty browser profile
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto('/');
  await expect(p2.getByTestId('where-songs')).toContainText('Songs are saved in this browser');
  await p2.getByTestId('restore-from-empty').click();
  await p2.getByTestId('restore-input').setInputFiles(file);
  await expect(p2.getByTestId('restore-result')).toContainText('Restored 1 song: Backup Song.', { timeout: 60_000 });
  await p2.getByRole('button', { name: 'Done' }).click();
  await p2.getByTestId('song-card').filter({ hasText: 'Backup Song' }).click();
  await expect(p2.getByTestId('section')).toHaveCount(8);

  // audio arrived intact (same sizes as recorded), waveforms came along, and it plays
  const check = await p2.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('musical');
      r.onsuccess = () => res(r.result);
    });
    const all = <T,>(store: string) =>
      new Promise<T[]>((res) => {
        db.transaction(store).objectStore(store).getAll().onsuccess = (e) => res((e.target as IDBRequest).result);
      });
    const [p] = await all<{ id: string; stems: { id: string; bytes: number }[] }>('projects');
    const peaks = await all<{ stemId: string }>('peaks');
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('songs')).getDirectoryHandle(p.id);
    const sizesMatch = await Promise.all(
      p.stems.map(async (s) => (await (await dir.getFileHandle(`${s.id}.pcm`)).getFile()).size === s.bytes),
    );
    return { stems: p.stems.length, peaks: peaks.length, sizesMatch };
  });
  expect(check.stems).toBe(5);
  expect(check.peaks).toBe(5);
  expect(check.sizesMatch.every(Boolean)).toBe(true);
  await p2.getByTestId('play').click();
  await expect
    .poll(() => p2.evaluate(() => (window as unknown as { __engine: { clock: { report: { frame: number } } } }).__engine.clock.report.frame))
    .toBeGreaterThan(48000);
  await p2.getByTestId('play').click();
  await p2.getByRole('button', { name: 'Arrange', exact: true }).click();
  await expect(p2.getByTestId('arr-item')).toHaveCount(7);

  // restoring the same file again changes nothing
  await p2.goto('/');
  await p2.getByTestId('backup-link').click();
  await p2.getByTestId('restore-input').setInputFiles(file);
  await expect(p2.getByTestId('restore-result')).toContainText('1 already here');
  await p2.getByRole('button', { name: 'Done' }).click();
  await expect(p2.getByTestId('song-card')).toHaveCount(1);
  await ctx2.close();
});
