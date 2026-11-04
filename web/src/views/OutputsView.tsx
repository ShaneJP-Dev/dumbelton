import { useCallback, useEffect, useState } from 'react';
import { Back, Plus, Trash, X } from '../components/icons';
import { Button, cx } from '../components/ui';
import { uid } from '../lib/ids';
import {
  channelLabel,
  channelProblems,
  defaultSetup,
  FALLBACK_GROUP,
  groupChannels,
  groupForStem,
  type OutputGroup,
  type OutputSetup,
} from '../lib/outputs';
import type { Project } from '../lib/types';
import { navigate, patchProjectById, setOutputs, syncRouting } from '../state/actions';
import { getEngine, peekEngine } from '../state/engine';
import { useApp } from '../state/store';

interface Device {
  deviceId: string;
  label: string;
}

async function listOutputs(): Promise<Device[]> {
  const all = await navigator.mediaDevices?.enumerateDevices?.();
  return (all ?? [])
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
}

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/5" data-testid={testId}>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Play the test tone on each channel of a group in turn. */
function testGroup(g: { first: number; stereo: boolean }): void {
  void getEngine().then((e) => {
    groupChannels(g).forEach((c, k) => setTimeout(() => e.testTone(c - 1), k * 750));
  });
}

function DeviceCard() {
  const setup = useApp((s) => s.outputs);
  const channels = useApp((s) => s.outputChannels);
  const [devices, setDevices] = useState<Device[]>([]);
  const [canChoose, setCanChoose] = useState<boolean | null>(null);
  const named = devices.some((d) => !/^Output \d+$/.test(d.label));

  const refresh = useCallback(async () => setDevices(await listOutputs()), []);
  useEffect(() => {
    void refresh();
    void getEngine().then((e) => setCanChoose(e.canChooseDevice));
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  const showNames = async () => {
    try {
      // the browser only reveals device names after a permission prompt; nothing is recorded
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* declined: keep generic names */
    }
    await refresh();
  };

  return (
    <Card title="Output device">
      {canChoose === false ? (
        <p className="text-sm text-gray-300">
          This browser can't choose the output here. Pick it in your Mac's <b>System Settings → Sound → Output</b> (e.g. "Dante
          Virtual Soundcard"), or use Chrome or Edge to choose it on this page.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={setup.deviceId}
            onChange={(e) => void setOutputs({ ...setup, deviceId: e.target.value })}
            aria-label="Output device"
            data-testid="output-device"
            className="h-10 min-w-0 max-w-full rounded-lg bg-white/10 px-2 text-sm"
          >
            <option value="" className="bg-[#151924]">
              System default
            </option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} className="bg-[#151924]">
                {d.label}
              </option>
            ))}
          </select>
          {!named && devices.length > 0 && (
            <Button variant="ghost" onClick={() => void showNames()} title="The browser asks for microphone access only to show device names. Nothing is recorded.">
              Show device names
            </Button>
          )}
        </div>
      )}
      <p className="mt-3 text-sm text-gray-400" data-testid="output-channels">
        {channels === null ? 'Starting audio…' : `This output takes ${channels} channel${channels === 1 ? '' : 's'}.`}
        {channels !== null && channels <= 2 && setup.mode === 'multitrack' && ' Choose a multi-channel output (such as Dante Virtual Soundcard) to use Multitrack.'}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Dante Virtual Soundcard: set it to 48 kHz and 16 or 32 channels, then choose it here. Browsers send up to 32 channels.
      </p>
    </Card>
  );
}

function GroupRow({ g, setup, onChange, onRemove }: { g: OutputGroup; setup: OutputSetup; onChange: (g: OutputGroup) => void; onRemove?: () => void }) {
  const [keywords, setKeywords] = useState(g.keywords.join(', '));
  useEffect(() => setKeywords(g.keywords.join(', ')), [g.keywords]);
  return (
    <tr className="border-t border-white/5" data-testid="output-group" data-name={g.name}>
      <td className="py-2 pr-2">
        <input
          value={g.name}
          aria-label="Group name"
          onChange={(e) => onChange({ ...g, name: e.target.value })}
          className="h-9 w-28 rounded-md bg-white/10 px-2 text-sm"
        />
      </td>
      <td className="py-2 pr-2 whitespace-nowrap">
        <input
          type="number"
          min={1}
          max={32}
          value={g.first}
          aria-label={`${g.name} first channel`}
          onChange={(e) => {
            const v = Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 1)));
            onChange({ ...g, first: v });
          }}
          className="h-9 w-16 rounded-md bg-white/10 px-2 text-sm tabular-nums"
        />
        <select
          value={g.stereo ? 'stereo' : 'mono'}
          aria-label={`${g.name} mono or stereo`}
          onChange={(e) => onChange({ ...g, stereo: e.target.value === 'stereo' })}
          className="ml-1 h-9 rounded-md bg-white/10 px-1 text-sm"
        >
          <option value="mono" className="bg-[#151924]">Mono</option>
          <option value="stereo" className="bg-[#151924]">Stereo</option>
        </select>
        <span className="ml-2 text-xs text-gray-400 tabular-nums">ch {channelLabel(g)}</span>
      </td>
      <td className="py-2 pr-2">
        {g.id === FALLBACK_GROUP ? (
          <span className="text-xs text-gray-500">Anything not matched above</span>
        ) : (
          <input
            value={keywords}
            aria-label={`${g.name} track names`}
            placeholder="e.g. drum, kick, snare"
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() => onChange({ ...g, keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) })}
            className="h-9 w-full min-w-40 rounded-md bg-white/10 px-2 text-sm"
          />
        )}
        {g.click && <div className="mt-1 text-[11px] text-gray-500">Also gets the app's click and count-in.</div>}
      </td>
      <td className="py-2 whitespace-nowrap">
        <Button variant="ghost" onClick={() => testGroup(g)} data-testid={`test-${g.id}`} title="Play a beep on these channels">
          Test
        </Button>
        {onRemove && (
          <Button variant="ghost" aria-label={`Remove ${g.name}`} onClick={onRemove}>
            <X size={16} />
          </Button>
        )}
      </td>
      {setup.mode === 'stereo' && null}
    </tr>
  );
}

function SongRouting({ setup }: { setup: OutputSetup }) {
  const projects = useApp((s) => s.projects);
  const current = useApp((s) => s.current);
  const [songId, setSongId] = useState<string>(current?.id ?? projects[0]?.id ?? '');
  const song: Project | undefined = (current?.id === songId ? current : undefined) ?? projects.find((p) => p.id === songId);
  if (!song) return <p className="text-sm text-gray-400">Import a song to see how its tracks are routed.</p>;

  const pin = async (stemId: string, output: string) => {
    await patchProjectById(song.id, (p) => ({
      ...p,
      stems: p.stems.map((s) => (s.id === stemId ? { ...s, output: output || undefined } : s)),
    }));
    syncRouting();
  };

  return (
    <>
      <select
        value={song.id}
        onChange={(e) => setSongId(e.target.value)}
        aria-label="Song"
        className="mb-3 h-9 max-w-full rounded-lg bg-white/10 px-2 text-sm"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id} className="bg-[#151924]">
            {p.name}
          </option>
        ))}
      </select>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="pb-1 font-normal">Track</th>
            <th className="pb-1 font-normal">Group</th>
            <th className="pb-1 font-normal">Channels</th>
          </tr>
        </thead>
        <tbody>
          {song.stems.map((s) => {
            const auto = groupForStem(setup, { name: s.name });
            const g = groupForStem(setup, s);
            return (
              <tr key={s.id} className="border-t border-white/5" data-testid="song-route" data-track={s.name} data-channels={channelLabel(g)}>
                <td className="py-1.5 pr-2">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </td>
                <td className="py-1.5 pr-2">
                  <select
                    value={s.output && setup.groups.some((x) => x.id === s.output) ? s.output : ''}
                    aria-label={`${s.name} output group`}
                    onChange={(e) => void pin(s.id, e.target.value)}
                    className="h-8 rounded-md bg-white/10 px-1 text-sm"
                  >
                    <option value="" className="bg-[#151924]">
                      Auto ({auto.name})
                    </option>
                    {setup.groups.map((x) => (
                      <option key={x.id} value={x.id} className="bg-[#151924]">
                        {x.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 tabular-nums text-gray-300">
                  {channelLabel(g)}
                  {setup.mix.enabled && !g.notInMix ? ` + mix ${setup.mix.first}–${setup.mix.first + 1}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function OutputsView() {
  const setup = useApp((s) => s.outputs);
  const channels = useApp((s) => s.outputChannels);
  const problems = channelProblems(setup, channels ?? 32);
  const update = (patch: Partial<OutputSetup>) => void setOutputs({ ...setup, ...patch });
  const setGroup = (g: OutputGroup) => update({ groups: setup.groups.map((x) => (x.id === g.id ? g : x)) });

  useEffect(() => {
    void getEngine(); // start audio so the device and its channel count are known
  }, []);

  const nextFree = () => {
    const used = new Set(setup.groups.flatMap(groupChannels));
    let c = 1;
    while (used.has(c) && c < 32) c++;
    return c;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 md:py-10">
      <header className="flex items-center gap-2">
        <Button
          variant="ghost"
          aria-label="Back"
          onClick={() => (window.history.length > 1 ? window.history.back() : navigate({ name: 'library' }))}
        >
          <Back />
        </Button>
        <h1 className="text-2xl font-bold">Outputs</h1>
      </header>

      <DeviceCard />

      <Card title="Channels">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Output mode">
          {(
            [
              ['stereo', 'Stereo', 'Everything mixed on channels 1–2.'],
              ['multitrack', 'Multitrack', 'Click, guide and each instrument on their own channels, for the desk and in-ears.'],
            ] as const
          ).map(([m, label, hint]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={setup.mode === m}
              data-testid={`mode-${m}`}
              onClick={() => update({ mode: m })}
              className={cx('rounded-xl p-3 text-left ring-1', setup.mode === m ? 'bg-blue-600/20 ring-blue-500' : 'ring-white/10 hover:bg-white/5')}
            >
              <div className="font-semibold">{label}</div>
              <div className="text-sm text-gray-400">{hint}</div>
            </button>
          ))}
        </div>
        {setup.mode === 'multitrack' && (
          <>
            <p className="mt-3 text-sm text-gray-400">
              Tracks go to a group by their name (e.g. a track called "Kick" goes to Drums). In Multitrack mode the sound goes to
              the desk, not the laptop's speakers. Use Test to find each group on the desk.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="pb-1 font-normal">Group</th>
                    <th className="pb-1 font-normal">Channels</th>
                    <th className="pb-1 font-normal">Track names containing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {setup.groups.map((g) => (
                    <GroupRow
                      key={g.id}
                      g={g}
                      setup={setup}
                      onChange={setGroup}
                      onRemove={g.id === FALLBACK_GROUP || g.click ? undefined : () => update({ groups: setup.groups.filter((x) => x.id !== g.id) })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                onClick={() =>
                  update({
                    // new groups go before "Other" so their keywords are checked first
                    groups: [
                      ...setup.groups.filter((g) => g.id !== FALLBACK_GROUP),
                      { id: uid('g_'), name: 'New group', keywords: [], first: nextFree(), stereo: false },
                      ...setup.groups.filter((g) => g.id === FALLBACK_GROUP),
                    ],
                  })
                }
              >
                <Plus size={16} /> Add group
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={setup.mix.enabled}
                  onChange={(e) => update({ mix: { ...setup.mix, enabled: e.target.checked } })}
                  className="h-4 w-4 accent-blue-500"
                  data-testid="mix-enabled"
                />
                Also send a stereo mix (no click or guide) to channels
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={setup.mix.first}
                  aria-label="Stereo mix first channel"
                  onChange={(e) => update({ mix: { ...setup.mix, first: Math.max(1, Math.min(31, Math.round(Number(e.target.value) || 1))) } })}
                  className="h-8 w-14 rounded-md bg-white/10 px-2 tabular-nums"
                />
                <span className="tabular-nums text-gray-400">–{setup.mix.first + 1}</span>
              </label>
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => window.confirm('Reset the channel layout to the defaults?') && update({ groups: defaultSetup().groups, mix: defaultSetup().mix })}
              >
                <Trash size={16} /> Reset layout
              </Button>
            </div>
            {problems.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200" data-testid="output-problems">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {setup.mode === 'multitrack' && (
        <Card title="This song" testId="song-routing">
          <SongRouting setup={setup} />
        </Card>
      )}
      {peekEngine() === null && <p className="text-xs text-gray-500">Audio starts when you open this page or a song.</p>}
    </div>
  );
}
