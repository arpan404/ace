import { ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { CodexCatalogCache } from "./tool-facts.ts";
import type { CodexChannel } from "./host.ts";
import { sessionLifetime } from "./session-lifetime.ts";

/** A busy session alone on a shared host whose Windows tree outlives the stop. */
function busyAlone() {
  const controller = new AbortController();
  const notes: unknown[] = [];
  const lifetime = sessionLifetime({
    ctx: {
      threadId: ThreadId.parse("thread-1"),
      cwd: "/work",
      signal: controller.signal,
      onFrame: () => {},
      onExit: () => {},
    },
    generation: "g1",
    closing: () => {},
    cleanup: () => {},
    busy: () => true,
    stopWork: async () => {},
    emit: (dir, data) => {
      if (dir === "note") notes.push(data);
    },
  });
  const channel: CodexChannel = {
    pid: 1,
    shared: true,
    gone: false,
    alone: true,
    catalogs: new CodexCatalogCache(),
    request: () => Promise.resolve(undefined),
    detach: () => Promise.resolve(),
    retire: () => Promise.reject(new Error("Windows process tree survived its stop")),
    foreign: () => false,
  };
  lifetime.attached(channel);
  return { lifetime, controller, notes };
}

it("closing a busy session whose shells outlived the host's stop fails instead of reporting it closed", async () => {
  const { lifetime } = busyAlone();
  await expect(lifetime.close("user")).rejects.toThrow("survived its stop");
});

it("a cancelled session whose stop fails records it, and a later close still sees the failure", async () => {
  const { lifetime, controller, notes } = busyAlone();
  controller.abort(new Error("cancelled"));
  await expect.poll(() => notes).toContainEqual(
    expect.objectContaining({ event: "codex-stop-failed", retirement: "aborted" }),
  );
  await expect(lifetime.close("user")).rejects.toThrow("survived its stop");
});

it("a transport failure whose stop fails records it on the session", async () => {
  const { lifetime, notes } = busyAlone();
  lifetime.failTransport();
  await expect.poll(() => notes).toContainEqual(
    expect.objectContaining({ event: "codex-stop-failed", retirement: "rpc_failed" }),
  );
});
