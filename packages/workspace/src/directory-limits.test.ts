import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace } from "./index.ts";

let root: string | undefined;
let preparation: Promise<void> | undefined;
const cancelled = new AbortController();

beforeAll(() => {
  // Keep bulk setup outside the assertion body. A timed-out setup cannot resume
  // assertions in the following test; teardown drains its current write batch.
  preparation = (async () => {
    root = await mkdtemp(join(tmpdir(), "ace-workspace-limit-"));
    const dir = join(root, "large");
    await mkdir(dir);
    for (let start = 0; start < 10_001; start += 200) {
      cancelled.signal.throwIfAborted();
      const writes = await Promise.allSettled(
        Array.from({ length: Math.min(200, 10_001 - start) }, (_, index) =>
          writeFile(join(dir, String(start + index)), ""),
        ),
      );
      const failures = writes.filter((write) => write.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((write) => write.reason));
    }
  })();
  return preparation;
});

afterAll(async () => {
  cancelled.abort();
  // A setup failure is already reported by beforeAll. Wait for every issued
  // write before deleting its directory, even after cancellation or a timeout.
  await preparation?.catch(() => {});
  if (root) await rm(root, { recursive: true, force: true });
});

it("rejects oversized directory scans and page requests before returning partial results", async () => {
  if (!root) throw new Error("Directory preparation did not complete");
  const service = await createWorkspace(root);
  await expect(service.list({ dir: "large" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  await expect(service.list({ dir: "", limit: 1001 })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
