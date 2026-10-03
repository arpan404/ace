import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConductorStore } from "./index.ts";
import { environment, spec, plan } from "./test-support.ts";
import { fixture } from "./review-test-support.ts";

test("Deck reads return the persisted plan and active lanes without execution artifacts", async () => {
  const f = fixture();
  try {
    const project = plan({ a: [], b: ["a"] });
    await f.install(project);
    const view = f.store.view("run");
    expect(view?.plan).toEqual(project);
    expect(view?.dag).toMatchObject([
      { id: "a", dependencies: [] },
      { id: "b", dependencies: ["a"] },
    ]);
    expect(view?.lanes.some((lane) => lane.role === "worker" && lane.workstream === "a")).toBe(
      true,
    );
    const cold = new ConductorStore(f.path);
    try {
      expect(cold.view("run")).toEqual(view);
    } finally {
      cold.close();
    }
  } finally {
    f.close();
  }
});

test("reading many stored Decks never consumes live execution capacity and lists page without omission", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-deck-views-"));
  const path = join(root, "conductor.sqlite");
  let store = new ConductorStore(path);
  const env = environment();
  try {
    for (let i = 0; i < 12; i++) {
      const id = `saved-${String(i).padStart(2, "0")}`;
      store.create(id, spec(), env);
      // Closing a lifetime frees actors without pretending a planning run is terminal.
      store.close();
      store = new ConductorStore(path);
    }
    const first = store.list(undefined, 8),
      second = store.list(first.next, 8);
    expect([...first.ids, ...second.ids]).toEqual(
      Array.from({ length: 12 }, (_, i) => `saved-${String(i).padStart(2, "0")}`),
    );
    for (const id of [...first.ids, ...second.ids])
      expect(store.summary(id)?.goal).toBe("Build the project");
    for (const id of [...first.ids, ...second.ids]) expect(store.view(id)?.phase).toBe("planning");
    for (let i = 0; i < 8; i++) store.create(`live-${i}`, spec(), env);
    expect(() => store.create("overflow", spec(), env)).toThrow("backpressure");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
