import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeOwnershipCase, progress, reduce, start } from "./index.ts";
import { accounts, environment, plan, spec } from "./test-support.ts";

it("case-insensitive workspace aliases cannot dispatch independent owners", () => {
  const env = { ...environment(), ownershipCase: () => "insensitive" as const };
  let state = reduce(start("run", spec(), env).state, { type: "accounts", accounts }, env).state;
  const planner = progress(state).lanes[0];
  if (!planner) throw new Error("Planner missing");
  const project = plan({ a: [], b: [] });
  const a = project.workstreams[0],
    b = project.workstreams[1];
  if (!a || !b) throw new Error("Streams missing");
  a.brief.files = ["Foo.ts"];
  b.brief.files = ["foo.ts"];
  expect(() =>
    reduce(
      state,
      {
        type: "artifact",
        laneId: planner.id,
        generation: 0,
        artifact: { kind: "plan", plan: project },
      },
      env,
    ),
  ).toThrow("ownership");
  expect(progress(state).lanes.map((l) => l.role)).toEqual(["planner"]);
});

it("ownership probing follows real workspace inode aliases and removes its temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-conductor-case-test-"));
  try {
    await writeFile(join(root, "Foo.ts"), "upper");
    await writeFile(join(root, "foo.ts"), "lower");
    const [upper, lower] = await Promise.all([
      stat(join(root, "Foo.ts")),
      stat(join(root, "foo.ts")),
    ]);
    const same = upper.dev === lower.dev && upper.ino === lower.ino;
    expect(await probeOwnershipCase(root)).toBe(same ? "insensitive" : "sensitive");
    expect((await readdir(root)).filter((name) => name.startsWith(".ace-conductor-case-"))).toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["sensitive", "insensitive"] as const)(
  "%s ownership allows dependency-ordered aliases",
  (ownershipCase) => {
    const env = { ...environment(), ownershipCase: () => ownershipCase };
    let state = reduce(start("run", spec(), env).state, { type: "accounts", accounts }, env).state;
    const planner = progress(state).lanes[0];
    if (!planner) throw new Error("Planner missing");
    const project = plan({ a: [], b: ownershipCase === "sensitive" ? [] : ["a"] });
    const [a, b] = project.workstreams;
    if (!a || !b) throw new Error("Streams missing");
    a.brief.files = ["Foo.ts"];
    b.brief.files = ["foo.ts"];
    state = reduce(
      state,
      {
        type: "artifact",
        laneId: planner.id,
        generation: 0,
        artifact: { kind: "plan", plan: project },
      },
      env,
    ).state;
    state = reduce(
      state,
      { type: "status", laneId: planner.id, generation: 0, status: "done", at: env.now() },
      env,
    ).state;
    expect(progress(state).lanes.map((l) => l.workstream)).toEqual(
      ownershipCase === "sensitive" ? ["a", "b"] : ["a"],
    );
  },
);
