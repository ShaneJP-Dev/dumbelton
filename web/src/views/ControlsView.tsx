import { Back } from '../components/icons';
import { Button, cx } from '../components/ui';
import { describeTrigger, midiActions } from '../lib/midi';
import { navigate } from '../state/actions';
import { clearMidi, connectMidi, learnMidi, midiSupported } from '../state/midi';
import { useApp } from '../state/store';

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/5" data-testid={testId}>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const KEYS: [string, string][] = [
  ['Space', 'Play / stop'],
  ['1–9', 'Section 1–9 (queued in Live)'],
  ['← → or Page Up / Page Down', 'Previous / next section (page-turner pedals send these)'],
  ['Shift + ← →', 'Previous / next song in the setlist'],
  ['R', 'Repeat on / off (Live)'],
  ['C', 'Click on / off'],
];

/** MIDI pedals and pads: connect, learn which pedal does what, see what arrives. */
export function ControlsView() {
  const midi = useApp((s) => s.midi);
  const map = useApp((s) => s.midiMap);
  const learning = useApp((s) => s.midiLearn);
  const last = useApp((s) => s.midiLast);
  const groups = useApp((s) => s.outputs.groups);
  const actions = midiActions(groups);
  const supported = midiSupported();

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
        <h1 className="text-2xl font-bold">Controls</h1>
      </header>

      <Card title="MIDI pedals and pads" testId="midi-card">
        {!supported ? (
          <p className="text-sm text-amber-200">
            This browser can't use MIDI. Open the app in <b>Chrome</b> or <b>Edge</b> (Safari, iPad and iPhone don't support MIDI in
            web pages). Bluetooth page-turner pedals still work everywhere: they send arrow keys.
          </p>
        ) : midi.status === 'on' ? (
          <div className="text-sm">
            <p className="text-gray-300" data-testid="midi-inputs">
              {midi.inputs.length ? (
                <>
                  Listening to <b>{midi.inputs.join(', ')}</b>.
                </>
              ) : (
                'MIDI is on, but no device is plugged in yet. Plug one in: it is picked up straight away.'
              )}
            </p>
            <p className="mt-1 text-xs text-gray-500" data-testid="midi-last">
              Last message: {last ?? 'none yet (press a pedal)'}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="primary" onClick={() => void connectMidi()} data-testid="midi-connect" disabled={midi.status === 'connecting'}>
              {midi.status === 'connecting' ? 'Connecting…' : 'Connect MIDI'}
            </Button>
            <span className="text-gray-400">
              {midi.status === 'denied'
                ? `The browser refused MIDI (${midi.message}). Allow it in the address bar's site settings, then try again.`
                : 'Use a USB or Bluetooth MIDI foot controller or pad. The browser asks once for permission.'}
            </span>
          </div>
        )}
      </Card>

      {supported && (
        <Card title="What each pedal does" testId="midi-map">
          <p className="mb-3 text-sm text-gray-400">
            Tap <b>Learn</b>, then press the pedal or pad you want for that job. Notes, CC switches and program changes all work.
            Mutes and Repeat act in Live. Mute all keeps the 2-second hold (a pedal that only sends a program change mutes at once);
            pressing it again unmutes.
          </p>
          <div className="divide-y divide-white/5">
            {actions.map((a) => {
              const t = map[a.id];
              const isLearning = learning === a.id;
              return (
                <div key={a.id} className="flex items-center gap-3 py-2" data-testid="midi-action" data-action={a.id}>
                  <span className="min-w-0 flex-1 text-sm">{a.label}</span>
                  <span
                    className={cx('w-40 text-right text-sm tabular-nums', isLearning ? 'text-amber-300' : t ? 'text-gray-200' : 'text-gray-600')}
                    data-testid="midi-trigger"
                  >
                    {isLearning ? 'Press a pedal…' : t ? describeTrigger(t) : '—'}
                  </span>
                  <Button
                    variant={isLearning ? 'primary' : 'ghost'}
                    onClick={() => learnMidi(isLearning ? null : a.id)}
                    disabled={midi.status !== 'on'}
                    data-testid="midi-learn"
                  >
                    {isLearning ? 'Cancel' : 'Learn'}
                  </Button>
                  <Button variant="ghost" onClick={() => clearMidi(a.id)} disabled={!t} aria-label={`Clear ${a.label}`}>
                    Clear
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card title="Keyboard and page-turner pedals">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {KEYS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-gray-200">{k}</dt>
              <dd className="text-gray-400">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
