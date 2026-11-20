import { z } from "zod";

/**
 * The app's `--perf-probe` numbers, posted here by the app and read by the UI tests over HTTP.
 * Reading them from the accessibility tree made XCUITest snapshot the whole app on its main
 * thread for every read, and those snapshots landed inside the very timings the performance
 * budgets hold (README "Performance budgets"). Each launch posts under the run id its test
 * passed it, so a test never reads the numbers of an earlier launch.
 */
const Posted = z.object({
  run: z.string().min(1).max(64),
  /**
   * The app numbers each post of a run in order. Posts go concurrently and can land out of
   * order, so an older sample never replaces a newer one. Absent: always taken.
   */
  seq: z.number().int().nonnegative().optional(),
  text: z.string().max(64 * 1024),
});

export class SpikePerfProbe {
  /** Newest last; a run that posts again moves to the end. */
  private readonly runs = new Map<string, { seq: number; text: string }>();
  private readonly keep: number;

  constructor(keep = 8) {
    this.keep = keep;
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== "/perf-probe") return undefined;
    if (request.method === "POST") {
      const posted = Posted.safeParse(await request.json().catch(() => undefined));
      if (!posted.success)
        return Response.json({ error: "run and text required" }, { status: 400 });
      const { run, seq, text } = posted.data;
      const held = this.runs.get(run);
      if (held && seq !== undefined && seq < held.seq) return Response.json({ ok: true });
      this.runs.delete(run);
      this.runs.set(run, { seq: seq ?? (held?.seq ?? 0), text });
      for (const run of this.runs.keys()) {
        if (this.runs.size <= this.keep) break;
        this.runs.delete(run);
      }
      return Response.json({ ok: true });
    }
    return Response.json({ text: this.runs.get(url.searchParams.get("run") ?? "")?.text ?? null });
  }
}
