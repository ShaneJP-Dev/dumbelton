import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

async function project(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ sections: { name: string; start: number; end: number }[]; stems: { name: string; muted: boolean; gain: number }[] }>((res) => {
        const req = indexedDB.open('musical');
        req.onsuccess = () => {
          req.result.transaction('projects').objectStore('projects').getAll().onsuccess = (e) =>
            res((e.target as IDBRequest).result[0]);
        };
      }),
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
    const outputDb = (ms = 700) =>
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
    const keys = page.getByTestId('track-header').filter({ hasText: 'keys' });
    await page.getByRole('button', { name: 'Solo keys' }).click();
    await page.locator('[data-testid=section][data-name="Verse 1"]').click();
    await page.getByTestId('play').click();
    await page.waitForTimeout(300);
    const before = await outputDb();
    await expect(keys.getByTestId('db-readout')).toHaveText('0.0 dB');
    await keys.getByTestId('db-readout').click();
    await keys.getByTestId('db-input').fill('-12');
    await keys.getByTestId('db-input').press('Enter');
    await expect(keys.getByTestId('db-readout')).toHaveText('\u221212.0 dB');
    await page.waitForTimeout(200);
    const after = await outputDb();
    expect(after - before).toBeGreaterThan(-13.5);
    expect(after - before).toBeLessThan(-10.5);
    await expect.poll(async () => (await project(page)).stems.find((s) => s.name === 'keys')?.gain).toBeCloseTo(0.2512, 3);
    // double-click the fader: back to 0 dB
    await page.getByLabel('keys volume', { exact: true }).dblclick();
    await expect(keys.getByTestId('db-readout')).toHaveText('0.0 dB');
    await page.getByTestId('play').click();
    await page.getByRole('button', { name: 'Solo keys' }).click();
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
    await expect(page.getByTestId('live-panel')).toBeVisible();
    // pick the setlist and start it from its first song
    await list.getByTestId('song-list-picker').selectOption({ label: 'Setlist 1 (2)' });
    await list.locator('[data-testid=live-song][data-name="E2E Song"]').click();
    await expect(page.locator('input[aria-label="Song name"]')).toHaveValue('E2E Song');
    await expect(list.getByTestId('next-song')).toHaveText(/Next: Second Song/);
    await expect(list.locator('[data-testid=live-song][data-name="E2E Song"]')).toContainText('Now');
  });

  test('multitrack outputs: each group lands on its own channels', async () => {
    // per-channel peak levels of the engine's 32 outputs
    const levels = () =>
      page.evaluate(async () => {
        const w = window as unknown as { __engine: { ctx: AudioContext; node: AudioNode }; __an32?: AnalyserNode[] };
        if (!w.__an32) {
          const split = w.__engine.ctx.createChannelSplitter(32);
          w.__engine.node.connect(split);
          w.__an32 = Array.from({ length: 32 }, (_, k) => {
            const a = w.__engine.ctx.createAnalyser();
            a.fftSize = 2048;
            split.connect(a, k);
            return a;
          });
        }
        const peak = new Array(32).fill(0);
        const buf = new Float32Array(2048);
        for (let t = 0; t < 12; t++) {
          w.__an32.forEach((a, k) => {
            a.getFloatTimeDomainData(buf);
            for (const v of buf) peak[k] = Math.max(peak[k], Math.abs(v));
          });
          await new Promise((r) => setTimeout(r, 50));
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
    expect([2, 3, 4, 5, 6, 11, 12].filter(on)).toEqual([2, 3, 4, 5, 6, 11, 12]); // drums, bass, keys, lead (Other)
    // click (muted in an earlier test), guide (none), guitars, vocals and unused channels are silent
    expect([0, 1, 7, 8, 9, 10, 13, 14, 20, 31].filter(on)).toEqual([]);
    // the app's own click goes to the Click channel (1)
    await page.evaluate(() =>
      (window as unknown as { __engine: { setClick(p: object): void } }).__engine.setClick({ enabled: true, gain: 1 }),
    );
    peak = await levels();
    expect(on(0)).toBe(true);
    expect(on(1)).toBe(false);
    await page.evaluate(() => (window as unknown as { __engine: { setClick(p: object): void } }).__engine.setClick({ enabled: false }));

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
