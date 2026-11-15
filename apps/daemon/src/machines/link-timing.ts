/**
 * How long calls to each paired machine take, smoothed as TCP smooths round trips (RFC 6298:
 * SRTT gains 1/8 of each sample, RTTVAR 1/4 of its deviation). Only answered short reads
 * (status, describe, job reads) are samples: a call that got no answer measured nothing about
 * the link, so silence never stretches a timeout. Pure: the caller passes each duration and time.
 */
export class LinkTiming {
  private links = new Map<string, { srtt: number; rttvar: number; answeredAt: number }>();
  /** A call to `machine` was answered after `ms`, at `at`. */
  answered(machine: string, ms: number, at: number): void {
    this.sample(machine, ms);
    const link = this.links.get(machine);
    if (link) link.answeredAt = at;
  }
  /**
   * The timeout for a short read of `machine`: `baseMs` on a link as fast as a LAN, longer on a
   * slow one (four times the smoothed time plus four deviations), never past `capMs`.
   */
  timeout(machine: string, baseMs: number, capMs: number): number {
    const link = this.links.get(machine);
    if (!link) return baseMs;
    return Math.round(Math.min(capMs, Math.max(baseMs, 4 * (link.srtt + 4 * link.rttvar))));
  }
  /** The smoothed call time, when any call to `machine` has been timed. */
  smoothed(machine: string): number | undefined {
    return this.links.get(machine)?.srtt;
  }
  /** When `machine` last answered a timed call, if it has. */
  answeredAt(machine: string): number | undefined {
    const at = this.links.get(machine)?.answeredAt;
    return at === undefined || at < 0 ? undefined : at;
  }
  forget(machine: string): void {
    this.links.delete(machine);
  }
  private sample(machine: string, ms: number) {
    const link = this.links.get(machine);
    if (!link) {
      this.links.set(machine, { srtt: ms, rttvar: ms / 2, answeredAt: -1 });
      return;
    }
    link.rttvar = 0.75 * link.rttvar + 0.25 * Math.abs(link.srtt - ms);
    link.srtt = 0.875 * link.srtt + 0.125 * ms;
  }
}
