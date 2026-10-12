import { access, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hash, uploads, thread } from "./test-support.ts";

test("retention never collects a referenced attachment or an active provider lease", async () => {
  const f = await uploads();
  const bytes = Buffer.from("retained bytes");
  const sha = hash(bytes);
  try {
    await f.put(bytes);
    const referenced = await f.store.inspectCleanup(sha);
    await expect(f.store.removeCleanup(sha, referenced.fingerprint)).rejects.toMatchObject({
      code: "busy",
    });
    const lease = await f.store.acquire("device", thread, [sha]);
    await f.store.releaseThread(thread);
    const leased = await f.store.inspectCleanup(sha);
    expect(leased.leased).toBe(true);
    await expect(f.store.removeCleanup(sha, leased.fingerprint)).rejects.toMatchObject({
      code: "busy",
    });
    expect(await readFile(lease.blobs[0]?.path ?? "", "utf8")).toBe("retained bytes");
    lease.release();
    const reviewed = await f.store.inspectCleanup(sha);
    await f.store.removeCleanup(sha, reviewed.fingerprint);
    await expect(access(join(f.root, "blobs", sha))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("ordinary upload expiry leaves old unreferenced blobs available for reviewed cleanup", async () => {
  const f = await uploads();
  const bytes = Buffer.from("old bytes");
  const sha = hash(bytes);
  try {
    await f.put(bytes);
    await f.store.releaseThread(thread);
    await utimes(join(f.root, "blobs", sha), new Date(1), new Date(1));
    f.advance(100000000);
    await f.store.expire();
    expect(await readFile(join(f.root, "blobs", sha), "utf8")).toBe("old bytes");
    const plan = await f.store.cleanupInventory();
    expect(plan.entries.find((entry) => entry.hash === sha)?.referenced).toBe(false);
  } finally {
    await f.close();
  }
});
