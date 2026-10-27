import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("a project or thread document can't turn on working while the Mac is locked", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.write(join(f.workspace, ".ace", "settings.json"), { "computer.lockedUse": true });
  await f.write(join(f.dataDir, "threads", "t1", "settings.json"), { "computer.lockedUse": true });
  const scope = { workspace: f.workspace, thread: "t1" };
  expect(await f.service.get("computer.lockedUse", scope)).toEqual({
    key: "computer.lockedUse",
    value: false,
    provenance: "defaults",
  });
  expect((await f.service.read({ keys: ["computer.lockedUse"], scope })).entries[0]).toMatchObject({
    value: false,
    provenance: "defaults",
  });

  await f.service.set("computer.lockedUse", true, { kind: "global" });
  expect(await f.service.get("computer.lockedUse", scope)).toMatchObject({
    value: true,
    provenance: "global",
  });
  await expect(
    f.service.set("computer.lockedUse", true, { kind: "thread", thread: "t1" }),
  ).rejects.toThrow("global setting");
});
