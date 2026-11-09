import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useApp } from '../state/store';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger';

export function Button({
  variant = 'subtle',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-blue-600 hover:bg-blue-500 text-white',
    ghost: 'hover:bg-white/10 text-gray-200',
    subtle: 'bg-white/10 hover:bg-white/15 text-gray-100',
    danger: 'bg-red-600/90 hover:bg-red-500 text-white',
  };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 h-10 text-sm font-medium transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none select-none',
        styles[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Toggle({
  on,
  onClick,
  children,
  title,
  className,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg h-10 px-3 text-sm font-medium transition-colors select-none',
        on ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-label={title} className="w-full max-w-lg rounded-2xl bg-[#151924] p-5 shadow-2xl ring-1 ring-white/10">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ToastHost() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div
        role="status"
        className={cx(
          'rounded-xl px-4 py-3 text-sm shadow-xl ring-1',
          toast.kind === 'error' ? 'bg-red-950 text-red-100 ring-red-500/40' : 'bg-[#1d2333] text-gray-100 ring-white/10',
        )}
      >
        {toast.text}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white', className)}
      aria-hidden="true"
    />
  );
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
