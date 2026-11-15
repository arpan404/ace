/**
 * How long one stage of a connect (the socket opening, then the hello waiting for its welcome)
 * may take before the attempt is dropped and retried (ADR 0150): `floorMs`, or four times what
 * the same stage took last time on a slower link, never past `capMs`. A daemon that said
 * `starting` gets the whole `capMs` instead: its cold start may take that long. Pure.
 */
export function stageDeadline(floorMs: number, capMs: number, lastMs: number | undefined): number {
  const scaled = lastMs === undefined || !Number.isFinite(lastMs) ? 0 : 4 * Math.max(0, lastMs);
  return Math.min(capMs, Math.max(floorMs, scaled));
}
