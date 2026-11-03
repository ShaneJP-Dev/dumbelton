import { useEffect } from 'react';

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

/** Global key handler that ignores typing in inputs and auto-repeat (page-turner pedals repeat keys). */
export function useShortcuts(handler: KeyHandler): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (handler(e) === true) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler]);
}
