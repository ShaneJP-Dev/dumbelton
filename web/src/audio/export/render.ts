import type { RenderCore } from '../core/RenderCore';
import type { Program } from '../core/types';

export function programLength(p: Program): number {
  return p.segments.reduce((n, s) => n + (s.end - s.start), 0);
}

/**
 * Render a program from its first segment to the end, faster than real time.
 * At speed 1 the output is exactly the sum of the segment lengths; otherwise
 * it runs until the engine reports the end and trims the final block.
 */
export function renderProgram(
  core: RenderCore,
  program: Program,
  opts: {
    speed: number;
    block?: number;
    stems?: number;
    onBlock: (main: Float32Array[], stemOuts: Float32Array[][] | null, n: number) => void;
    onProgress?: (fraction: number) => void;
  },
): number {
  const block = opts.block ?? 8192;
  const main = [new Float32Array(block), new Float32Array(block)];
  const stemOuts = opts.stems ? Array.from({ length: opts.stems }, () => [new Float32Array(block), new Float32Array(block)]) : null;
  const total = programLength(program);
  const expected = Math.ceil(total / opts.speed);
  const exact = opts.speed === 1 ? total : Infinity;
  const cap = expected + 48000 * 2;
  let ended = false;
  const prev = core.onEvent;
  core.onEvent = (e) => {
    if (e.type === 'ended') ended = true;
  };
  try {
    core.setProgram({ segments: program.segments, loop: false });
    if (program.segments.length) core.seek(program.segments[0].start, 0);
    core.play();
    let done = 0;
    let lastReport = 0;
    // at 100% the file is exactly the program's length (padded with silence if a key change ends a touch early)
    while (done < exact && done < cap) {
      if (ended && exact === Infinity) break;
      let n = Math.min(block, exact - done);
      core.render(main, n, stemOuts);
      if (ended && exact === Infinity) {
        // trim the silent remainder of the last block
        let last = n - 1;
        while (last >= 0 && main[0][last] === 0 && main[1][last] === 0) last--;
        n = last + 1;
      }
      if (n > 0) opts.onBlock(main, stemOuts, n);
      done += n;
      if (opts.onProgress && done - lastReport > 48000 * 5) {
        lastReport = done;
        opts.onProgress(Math.min(1, done / expected));
      }
    }
    return done;
  } finally {
    core.onEvent = prev;
  }
}
