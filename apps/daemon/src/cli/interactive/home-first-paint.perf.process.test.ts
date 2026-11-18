/**
 * The interactive home's first paint (ADR 0178 §9's budget): bare `ace` in a real
 * pseudo-terminal draws the last run's rows within 150 ms of starting. A process test because
 * the budget covers the runtime's start and every module the CLI loads before its first
 * frame, which only a real process on a real terminal measures. No daemon runs, so nothing but
 * the CLI's own start is timed; the best of a few runs is taken, so a busy machine's one slow
 * start doesn't fail it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openPty } from "../pty-test-support.ts";
import { homeCachePath, keptRows } from "./home-cache.ts";

const budgetMs = 150;
const runs = 5;

async function firstPaint(home: string, empty: string, title: string): Promise<number> {
  const started = performance.now();
  const terminal = openPty(home, empty);
  const painted = await new Promise<number>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`No first frame in ${seen}`)), 10_000);
    terminal.pty.onData((input) => {
      seen +=
        typeof input === "string"
          ? input
          : input instanceof Uint8Array
            ? Buffer.from(input).toString("utf8")
            : "";
      if (!seen.includes(title)) return;
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
  });
  // Keys typed before the shell has loaded aren't read yet; the run is stopped from outside.
  terminal.pty.kill();
  await terminal.exited;
  return painted;
}

test("bare ace draws the kept rows within 150 ms of starting", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-first-paint-"));
  const empty = mkdtempSync(join(tmpdir(), "ace-first-paint-cwd-"));
  try {
    const title = "The last kept thread";
    writeFileSync(
      homeCachePath(home),
      JSON.stringify({
        version: 1,
        rows: Array.from({ length: keptRows }, (_, index) => ({
          id: `t${index}`,
          title: index === 0 ? title : `Kept thread ${index}`,
          project: "ace",
          projectId: "p",
          branch: `ace/branch-${index}`,
          provider: "codex",
        })),
      }),
    );
    const times: number[] = [];
    for (let run = 0; run < runs; run++) times.push(await firstPaint(home, empty, title));
    const best = Math.min(...times);
    console.info(
      `first paint: best ${best.toFixed(0)} ms of ${times.map((ms) => ms.toFixed(0)).join(", ")}`,
    );
    expect(best).toBeLessThan(budgetMs);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
