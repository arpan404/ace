import { expect, test } from "vitest";
import {
  HostId,
  MachineStatusResult,
  ThreadId,
  type MachineCallOrigin,
  type MachineThreadView,
} from "@ace/protocol";
import { MachineCaller, type CallerDeps } from "./caller.ts";
import type { MachineDirectory } from "./directory.ts";
import { device, origin, target } from "./target-test-support.ts";

// A remotely delegated child that moved on (ADR 0191), as its parent's machine polls it.

const moved: MachineThreadView = {
  threadId: ThreadId.parse("child"),
  state: "working",
  title: "Child",
  elapsedSeconds: 3,
  status: {
    state: "moved",
    to: { hostId: HostId.parse("studio"), name: "Studio", threadId: ThreadId.parse("there") },
  },
  requests: [],
};

/** The target with one child the laptop delegated, which has moved. */
function withMovedChild() {
  const h = target({ value: "operate" });
  h.threads.owns = () => true;
  h.threads.view = () => moved;
  const status = (from: MachineCallOrigin) =>
    h.machine.handle(
      device,
      { origin: from, call: { op: "status", threadIds: ["child"] } },
      new AbortController().signal,
    );
  return { ...h, status };
}

test("a calling machine from before the moved status reads the moved child as waiting", async () => {
  const h = withMovedChild();
  const answer = await h.status(origin);
  expect(answer.status).toBe(200);
  expect(JSON.stringify(answer.body)).not.toContain('"moved"');
  expect(MachineStatusResult.parse(answer.body).threads[0]?.status).toEqual({
    state: "waiting",
    on: "upstream",
  });
});

test("a current calling machine says it reads moved, and gets it", async () => {
  const h = withMovedChild();
  // The laptop's own caller, reaching this target through its directory.
  const directory = {
    call: async (_machine: string, from: MachineCallOrigin, call: unknown) =>
      (await h.machine.handle(device, { origin: from, call }, new AbortController().signal)).body,
  } as Partial<MachineDirectory> as MachineDirectory;
  const caller = new MachineCaller({
    store: h.store,
    hostId: "laptop-host",
    hostName: async () => "Laptop",
    directory,
    ceiling: () => "operate",
  } as Partial<CallerDeps> as CallerDeps);
  const [view] = await caller.status("desk", ThreadId.parse("parent"), [ThreadId.parse("child")]);
  expect(view?.status).toEqual(moved.status);
});
