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
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Back, Grip, Play, Plus, Trash, X } from '../components/icons';
import { Button } from '../components/ui';
import { SAMPLE_RATE } from '../audio/core/types';
import { formatTime } from '../components/ui';
import { uid } from '../lib/ids';
import type { Project, Setlist, SetlistEntry } from '../lib/types';
import { deleteSetlist, navigate, saveSetlist } from '../state/actions';
import { goToSetlistIndex } from '../state/live';
import { useApp } from '../state/store';

export function SetlistsView() {
  const setlists = useApp((s) => s.setlists);
  const projects = useApp((s) => s.projects);
  const create = async () => {
    const sl: Setlist = { id: uid('l_'), name: `Setlist ${setlists.length + 1}`, createdAt: Date.now(), updatedAt: Date.now(), entries: [] };
    await saveSetlist(sl);
    navigate({ name: 'setlist', id: sl.id });
  };
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-10">
      <header className="mb-6 flex items-center gap-2">
        <Button variant="ghost" aria-label="Back to songs" onClick={() => navigate({ name: 'library' })}>
          <Back />
        </Button>
        <h1 className="text-2xl font-bold">Setlists</h1>
        <Button variant="primary" className="ml-auto" onClick={() => void create()} data-testid="new-setlist">
          <Plus size={16} /> New setlist
        </Button>
      </header>
      {setlists.length === 0 ? (
        <p className="mt-10 text-center text-gray-400">
          A setlist is the running order for a service or gig. Live mode plays it song by song and loads the next one in advance.
        </p>
      ) : (
        <ul className="space-y-2">
          {setlists.map((sl) => (
            <li key={sl.id} className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate({ name: 'setlist', id: sl.id })}>
                <div className="truncate font-semibold">{sl.name}</div>
                <div className="truncate text-sm text-gray-400">
                  {sl.entries.map((e) => projects.find((p) => p.id === e.projectId)?.name ?? '?').join(' · ') || 'No songs yet'}
                </div>
              </button>
              <Button variant="primary" disabled={sl.entries.length === 0} onClick={() => void goToSetlistIndex(sl.id, 0)}>
                <Play size={14} /> Live
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  index,
  project,
  onChange,
  onRemove,
}: {
  entry: SetlistEntry;
  index: number;
  project: Project | undefined;
  onChange: (e: SetlistEntry) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: entry.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="flex items-center gap-2 rounded-xl bg-white/5 p-2"
      data-testid="setlist-entry"
    >
      <button type="button" aria-label="Drag to reorder" className="touch-none cursor-grab p-2 text-gray-500" {...attributes} {...listeners}>
        <Grip size={18} />
      </button>
      <span className="w-6 text-center text-sm text-gray-500">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{project?.name ?? 'Missing song'}</div>
        {project && (
          <div className="text-xs text-gray-500">
            {formatTime(project.lengthFrames / SAMPLE_RATE)}
            {project.bpm ? ` · ${Math.round(project.bpm)} BPM` : ''}
          </div>
        )}
      </div>
      {project && project.arrangements.length > 0 && (
        <select
          value={entry.arrangementId ?? ''}
          aria-label="Arrangement"
          onChange={(e) => onChange({ ...entry, arrangementId: e.target.value || undefined })}
          className="h-10 max-w-40 rounded-lg bg-white/10 px-2 text-sm"
        >
          <option value="" className="bg-[#151924]">Song order</option>
          {project.arrangements.map((a) => (
            <option key={a.id} value={a.id} className="bg-[#151924]">
              {a.name}
            </option>
          ))}
        </select>
      )}
      <Button variant="ghost" aria-label="Remove from setlist" onClick={onRemove}>
        <X size={16} />
      </Button>
    </li>
  );
}

export function SetlistView({ id }: { id: string }) {
  const sl = useApp((s) => s.setlists.find((x) => x.id === id));
  const projects = useApp((s) => s.projects);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!sl) {
    return (
      <div className="p-8 text-center">
        <Button onClick={() => navigate({ name: 'setlists' })}>Back to setlists</Button>
      </div>
    );
  }
  const update = (fn: (s: Setlist) => Setlist) => void saveSetlist(fn(sl));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    update((s) => {
      const from = s.entries.findIndex((x) => x.id === e.active.id);
      const to = s.entries.findIndex((x) => x.id === e.over!.id);
      return { ...s, entries: arrayMove(s.entries, from, to) };
    });
  };
  const total = sl.entries.reduce((n, e) => n + (projects.find((p) => p.id === e.projectId)?.lengthFrames ?? 0), 0);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-10">
      <header className="mb-4 flex items-center gap-2">
        <Button variant="ghost" aria-label="Back to setlists" onClick={() => navigate({ name: 'setlists' })}>
          <Back />
        </Button>
        <input
          value={sl.name}
          aria-label="Setlist name"
          onChange={(e) => update((s) => ({ ...s, name: e.target.value }))}
          className="h-11 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-2xl font-bold outline-none hover:bg-white/5 focus:bg-white/10"
        />
        <Button variant="primary" disabled={sl.entries.length === 0} onClick={() => void goToSetlistIndex(sl.id, 0)} data-testid="start-live">
          <Play size={14} /> Start live
        </Button>
      </header>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sl.entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2">
            {sl.entries.map((e, i) => (
              <EntryRow
                key={e.id}
                entry={e}
                index={i}
                project={projects.find((p) => p.id === e.projectId)}
                onChange={(next) => update((s) => ({ ...s, entries: s.entries.map((x) => (x.id === next.id ? next : x)) }))}
                onRemove={() => update((s) => ({ ...s, entries: s.entries.filter((x) => x.id !== e.id) }))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value=""
          aria-label="Add a song"
          data-testid="add-song"
          onChange={(ev) => {
            const pid = ev.target.value;
            if (pid) update((s) => ({ ...s, entries: [...s.entries, { id: uid('e_'), projectId: pid }] }));
          }}
          className="h-10 rounded-lg bg-white/10 px-3 text-sm"
        >
          <option value="" className="bg-[#151924]">+ Add a song…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id} className="bg-[#151924]">
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-500">
          {sl.entries.length} songs · {formatTime(total / SAMPLE_RATE)}
        </span>
        <Button
          variant="ghost"
          className="ml-auto text-red-300"
          onClick={() => {
            if (window.confirm(`Delete “${sl.name}”?`)) {
              navigate({ name: 'setlists' });
              void deleteSetlist(sl.id);
            }
          }}
        >
          <Trash size={16} /> Delete setlist
        </Button>
      </div>
    </div>
  );
}
