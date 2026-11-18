import { expect, test } from "vitest";
import { ProjectPushes } from "./project-pushes.ts";

type P = { id: string; name: string; remoteKey?: { remotes: string[]; subpath: string } };
const ace = { remotes: ["github.com/arpan/ace"], subpath: "" };

/** A paged read whose pages were all answered before `release` lets it land. */
function slowRead(list: P[]) {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { read: () => promise.then(() => list), release: () => resolve() };
}

test("a checkout unlinked while a read is out keeps no key when that read lands", async () => {
  const pushes = new ProjectPushes<P>();
  const read = slowRead([
    { id: "a", name: "ace", remoteKey: ace },
    { id: "b", name: "web" },
  ]);
  const out = pushes.track(read.read);
  pushes.record({ put: { id: "a", name: "ace" } });
  read.release();
  expect(await out).toEqual([
    { id: "a", name: "ace" },
    { id: "b", name: "web" },
  ]);
});

test("a project removed or added during a read stays removed or added", async () => {
  const pushes = new ProjectPushes<P>();
  const read = slowRead([{ id: "a", name: "ace" }]);
  const out = pushes.track(read.read);
  pushes.record({ drop: "a" });
  pushes.record({ put: { id: "c", name: "new" } });
  read.release();
  expect(await out).toEqual([{ id: "c", name: "new" }]);
});

test("a push before a read began is the read's to report, not replayed over it", async () => {
  const pushes = new ProjectPushes<P>();
  pushes.record({ put: { id: "a", name: "old name" } });
  expect(await pushes.track(async () => [{ id: "a", name: "renamed since" }])).toEqual([
    { id: "a", name: "renamed since" },
  ]);
});

test("a failed read lets the next read start clean", async () => {
  const pushes = new ProjectPushes<P>();
  const failed = pushes.track(async () => {
    pushes.record({ drop: "a" });
    throw new Error("socket closed");
  });
  await expect(failed).rejects.toThrow("socket closed");
  expect(await pushes.track(async () => [{ id: "a", name: "ace" }])).toEqual([
    { id: "a", name: "ace" },
  ]);
});
