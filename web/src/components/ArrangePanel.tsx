import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState } from 'react';
import { SAMPLE_RATE } from '../audio/core/types';
import { arrangementLength, arrangementProgram, newArrangement, playableItems } from '../lib/arrangement';
import { exportProgram, saveFile, type ExportedFile } from '../lib/exporter';
import { uid } from '../lib/ids';
import { barsIn, KIND_META } from '../lib/sections';
import type { Arrangement, ArrangementItem, Project, Section } from '../lib/types';
import { patchProject, syncProgram, toast } from '../state/actions';
import { getEngine } from '../state/engine';
import { getState, setState, useApp } from '../state/store';
import { Copy, Download, Play, Plus, Trash, X } from './icons';
import { Button, cx, formatTime, Modal, Spinner } from './ui';

function updateArrangement(id: string, fn: (a: Arrangement) => Arrangement): void {
  patchProject((p) => ({ ...p, arrangements: p.arrangements.map((a) => (a.id === id ? fn(a) : a)) }));
  syncProgram();
}

function Item({
  item,
  section,
  playing,
  downbeats,
  total,
  onRemove,
}: {
  item: ArrangementItem;
  section: Section;
  playing: boolean;
  downbeats: number[];
  total: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const len = section.end - section.start;
  const bars = barsIn(section, downbeats);
  return (
    <div
      ref={setNodeRef}
      data-testid="arr-item"
      data-name={section.name}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        background: KIND_META[section.kind].color,
        flexGrow: len / Math.max(1, total),
        flexBasis: 0,
        minWidth: 72,
      }}
      className={cx(
        'relative h-16 touch-none select-none rounded-lg px-2 py-1.5 text-white shadow',
        playing && 'ring-2 ring-white',
        isDragging && 'z-20 opacity-80 shadow-2xl',
      )}
      {...attributes}
      {...listeners}
    >
      <div className="truncate pr-5 text-[13px] font-semibold">{section.name}</div>
      <div className="text-[11px] text-white/80">{bars ? `${bars} bars` : formatTime(len / SAMPLE_RATE)}</div>
      <button
        type="button"
        aria-label={`Remove ${section.name}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute top-1 right-1 rounded p-0.5 text-white/70 hover:bg-black/20 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ExportDialog({ open, onClose, project, arr }: { open: boolean; onClose: () => void; project: Project; arr: Arrangement }) {
  const speed = useApp((s) => s.speed);
  const [mix, setMix] = useState(true);
  const [stems, setStems] = useState(false);
  const [useSpeed, setUseSpeed] = useState(false);
  const [click, setClickOpt] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<ExportedFile[]>([]);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setBusy(null);
    }
  }, [open]);

  const run = async () => {
    setBusy('Rendering… 0%');
    try {
      const program = arrangementProgram(project, arr);
      const res = await exportProgram(
        project,
        program,
        `${project.name} - ${arr.name}`,
        { mix, stemFiles: stems, speed: useSpeed ? speed : 1, click },
        (f, stage) => setBusy(stage === 'zip' ? `Packing tracks… ${Math.round(f * 100)}%` : `Rendering… ${Math.round(f * 100)}%`),
      );
      setFiles(res.files);
      if (res.clipped) toast('The mix peaked above 0 dB and was clipped. Lower some track volumes and export again.', 'error');
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const Check = ({ on, set, label, hint }: { on: boolean; set: (v: boolean) => void; label: string; hint?: string }) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-white/5">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="mt-1 h-4 w-4 accent-blue-500" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={`Export “${arr.name}”`}>
      {files.length === 0 ? (
        <>
          <Check on={mix} set={setMix} label="Mixed song (WAV)" hint="All tracks with your volume, mute and solo settings" />
          <Check on={stems} set={setStems} label="Separate tracks (ZIP of WAVs)" hint="One file per track, rearranged the same way" />
          {speed !== 1 && <Check on={useSpeed} set={setUseSpeed} label={`At ${Math.round(speed * 100)}% speed`} />}
          {project.beats.length > 0 && <Check on={click} set={setClickOpt} label="Include the click in the mix" />}
          <div className="mt-4 flex items-center justify-end gap-2">
            {busy && (
              <span className="mr-auto flex items-center gap-2 text-sm text-gray-300">
                <Spinner /> {busy}
              </span>
            )}
            <Button variant="ghost" onClick={onClose} disabled={!!busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run()} disabled={!!busy || (!mix && !stems)} data-testid="export-run">
              Export
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-400">Ready. Save your files:</p>
          <ul className="space-y-2">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 rounded-lg bg-white/5 p-2 pl-3">
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                <span className="text-xs text-gray-500">{(f.file.size / 1e6).toFixed(1)} MB</span>
                <Button variant="primary" onClick={() => void saveFile(f)} data-testid="save-file">
                  <Download size={16} /> Save
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ArrangePanel({ project }: { project: Project }) {
  const arrangementId = useApp((s) => s.arrangementId);
  const segment = useApp((s) => s.transport.segment);
  const [exportOpen, setExportOpen] = useState(false);
  const arr = project.arrangements.find((a) => a.id === arrangementId) ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // first visit: start from the song's own order
  useEffect(() => {
    // read the latest state (not the render closure) so this is idempotent under StrictMode
    const { current: cur, arrangementId: selectedId } = getState();
    if (!cur || cur.sections.length === 0) return;
    if (cur.arrangements.some((a) => a.id === selectedId)) return;
    if (cur.arrangements.length > 0) {
      setState({ arrangementId: cur.arrangements[0].id });
    } else {
      const a = newArrangement(cur, 'My arrangement');
      patchProject((p) => ({ ...p, arrangements: [...p.arrangements, a] }));
      setState({ arrangementId: a.id });
    }
    syncProgram();
  }, [arr, project.sections.length]);

  if (project.sections.length === 0) {
    return <p className="py-3 text-sm text-gray-400">Find or mark the song's sections first (Practice tab), then arrange them here.</p>;
  }
  if (!arr) return null;

  const sectionById = new Map(project.sections.map((s) => [s.id, s]));
  const items = playableItems(project, arr);
  const total = arrangementLength(project, arr);
  const bars = items.reduce((n, it) => n + barsIn(sectionById.get(it.sectionId)!, project.downbeats), 0);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    updateArrangement(arr.id, (a) => {
      const from = a.items.findIndex((x) => x.id === active.id);
      const to = a.items.findIndex((x) => x.id === over.id);
      return { ...a, items: arrayMove(a.items, from, to) };
    });
  };

  const playFromStart = async () => {
    const engine = await getEngine();
    syncProgram();
    engine.seek(project.sections.find((s) => s.id === items[0]?.sectionId)?.start ?? 0, 0);
    engine.play({ countIn: getState().countIn });
  };

  return (
    <div className="space-y-3 py-2" data-testid="arrange-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl bg-white/5 p-1">
          {project.arrangements.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={a.id === arr.id}
              onClick={() => {
                setState({ arrangementId: a.id });
                syncProgram();
              }}
              className={cx('h-8 rounded-lg px-3 text-sm', a.id === arr.id ? 'bg-white/20 font-medium text-white' : 'text-gray-400 hover:text-white')}
            >
              {a.name}
            </button>
          ))}
          <button
            type="button"
            aria-label="New arrangement"
            onClick={() => {
              const a = newArrangement(project);
              patchProject((p) => ({ ...p, arrangements: [...p.arrangements, a] }));
              setState({ arrangementId: a.id });
              syncProgram();
            }}
            className="h-8 rounded-lg px-2 text-gray-400 hover:text-white"
          >
            <Plus size={16} />
          </button>
        </div>
        <input
          value={arr.name}
          aria-label="Arrangement name"
          onChange={(e) => updateArrangement(arr.id, (a) => ({ ...a, name: e.target.value }))}
          className="h-10 w-44 rounded-lg bg-white/10 px-3 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Button
          variant="ghost"
          title="Duplicate arrangement"
          onClick={() => {
            const copy = { ...arr, id: uid('a_'), name: `${arr.name} copy`, items: arr.items.map((it) => ({ ...it, id: uid('i_') })) };
            patchProject((p) => ({ ...p, arrangements: [...p.arrangements, copy] }));
            setState({ arrangementId: copy.id });
            syncProgram();
          }}
        >
          <Copy size={16} />
        </Button>
        <Button
          variant="ghost"
          aria-label="Delete arrangement"
          onClick={() => {
            if (!window.confirm(`Delete “${arr.name}”?`)) return;
            const rest = project.arrangements.filter((a) => a.id !== arr.id);
            patchProject((p) => ({ ...p, arrangements: rest }));
            setState({ arrangementId: rest[0]?.id ?? null });
            syncProgram();
          }}
        >
          <Trash size={16} />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm tabular-nums text-gray-400">
            {formatTime(total / SAMPLE_RATE)}
            {bars ? ` · ${bars} bars` : ''}
          </span>
          <Button onClick={() => void playFromStart()} disabled={items.length === 0}>
            <Play size={14} /> From the top
          </Button>
          <Button variant="primary" onClick={() => setExportOpen(true)} disabled={items.length === 0} data-testid="export">
            <Download size={16} /> Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs uppercase tracking-wide text-gray-500">Add</span>
        {project.sections.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid="palette-chip"
            data-name={s.name}
            onClick={() => updateArrangement(arr.id, (a) => ({ ...a, items: [...a.items, { id: uid('i_'), sectionId: s.id }] }))}
            className="h-8 rounded-md px-2.5 text-xs font-semibold text-white brightness-90 hover:brightness-110"
            style={{ background: KIND_META[s.kind].color }}
          >
            + {s.name}
          </button>
        ))}
        {arr.items.length > 0 && (
          <button
            type="button"
            onClick={() => updateArrangement(arr.id, (a) => ({ ...a, items: [] }))}
            className="ml-1 h-8 rounded-md px-2 text-xs text-gray-400 hover:text-white"
          >
            Clear
          </button>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex min-h-16 gap-1 overflow-x-auto rounded-xl bg-black/20 p-1.5" data-testid="arr-strip">
            {items.length === 0 && (
              <div className="flex h-16 items-center px-3 text-sm text-gray-500">Tap the sections above to build your arrangement.</div>
            )}
            {items.map((it, i) => (
              <Item
                key={it.id}
                item={it}
                section={sectionById.get(it.sectionId)!}
                playing={i === segment}
                downbeats={project.downbeats}
                total={total}
                onRemove={() => updateArrangement(arr.id, (a) => ({ ...a, items: a.items.filter((x) => x.id !== it.id) }))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} project={project} arr={arr} />
    </div>
  );
}
