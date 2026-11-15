/**
 * What head-of-line.ts reads from its bench daemon about the event loop: the longest gaps
 * between turns, and each synchronous deflate the relay channel ran (size and time). The
 * deflates are recorded by head-of-line-zlib.ts, which head-of-line-daemon.ts loads in place of
 * `node:zlib` for the relay channel only. Bench code; nothing in the product imports it.
 */
export interface Deflate {
  bytes: number;
  ms: number;
  at: number;
}

const deflates: Deflate[] = [];
const gaps: { at: number; ms: number }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;

export function recordDeflate(bytes: number, ms: number): void {
  deflates.push({ bytes, ms, at: performance.now() });
}

/** Start (or restart) watching: each turn of the event loop records how late it ran. */
export function resetProbe(): void {
  deflates.length = 0;
  gaps.length = 0;
  if (timer) clearTimeout(timer);
  last = performance.now();
  const tick = () => {
    const now = performance.now();
    // Gaps under 4 ms are the timer's own resolution: kept out so a long run stays small.
    if (now - last >= 4) gaps.push({ at: now, ms: now - last });
    last = now;
    timer = setTimeout(tick, 1);
  };
  timer = setTimeout(tick, 1);
}

/**
 * What happened since the reset: the longest gaps, and for each the deflate time inside it
 * (deflates that ended within the gap), plus every deflate's size.
 */
export function readProbe() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const longest = gaps.toSorted((a, b) => b.ms - a.ms).slice(0, 5);
  return {
    longestGaps: longest.map((gap) => ({
      ms: Math.round(gap.ms * 10) / 10,
      deflateMs:
        Math.round(
          deflates
            .filter((deflate) => deflate.at <= gap.at && deflate.at >= gap.at - gap.ms)
            .reduce((total, deflate) => total + deflate.ms, 0) * 10,
        ) / 10,
    })),
    deflates: deflates.map((deflate) => ({
      bytes: deflate.bytes,
      ms: Math.round(deflate.ms * 100) / 100,
    })),
  };
}
