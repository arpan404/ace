import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { rotateLaunchLog } from "./launch-log.ts";

const size = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
test("repeated launches keep the daemon start log and its one rotated segment under the cap", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-launch-log-"));
  const path = join(home, "daemon-start.log");
  const cap = 4096;
  try {
    for (let launch = 0; launch < 50; launch++) {
      rotateLaunchLog(path, cap);
      // Each run writes less than a quarter of the cap: a startup line, perhaps a crash trace.
      appendFileSync(path, `launch ${launch} ${"x".repeat(400)}\n`);
      expect(size(path) + size(`${path}.1`)).toBeLessThanOrEqual(cap);
    }
    expect(readFileSync(path, "utf8")).toContain("launch 49 ");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
