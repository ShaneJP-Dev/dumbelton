import type { Project } from '../../lib/types';

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/**
 * How much decoded audio we allow in memory (current + preloaded song).
 * iPads with 3-4 GB RAM kill tabs that use much more than this.
 */
export function memoryBudgetBytes(): number {
  if (isIOS()) return 600e6;
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (dm) return Math.min(1.5e9, dm * 1e9 * 0.3);
  return 1.5e9;
}

export function projectBytes(p: Project): number {
  return p.stems.reduce((n, s) => n + s.bytes, 0);
}

export function canPreload(current: Project, next: Project, budget = memoryBudgetBytes()): boolean {
  return projectBytes(current) + projectBytes(next) <= budget;
}
