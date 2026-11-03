import { describe, expect, it } from 'vitest';
import type { Project } from '../../lib/types';
import { canPreload, projectBytes } from './budget';

const proj = (mb: number[]) => ({ stems: mb.map((m) => ({ bytes: m * 1e6 })) }) as unknown as Project;

describe('memory budget', () => {
  it('sums stem bytes and checks current + next against the budget', () => {
    expect(projectBytes(proj([100, 50]))).toBe(150e6);
    expect(canPreload(proj([250]), proj([300]), 600e6)).toBe(true);
    expect(canPreload(proj([350]), proj([300]), 600e6)).toBe(false);
  });
});
