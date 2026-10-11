import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { ClientMessage, ServerMessage, ThreadId } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import type { Schedule } from "../schedule.ts";
import { createTerminalEndDelivery } from "./end-delivery.ts";

/** Delay actual correlated replies at the wire boundary, leaving request slots occupied. */
class DelayedDaemon extends FakeDaemon {
  hold = false;
  replies: (() => void)[] = [];
  peak = 0;
  closes: string[] = [];
  private arrival = Promise.withResolvers<void>();
  override connect(wire: Parameters<FakeDaemon["connect"]>[0]) {
    const connection = super.connect({
      ...wire,
      send: (text) => {
        const frame = ServerMessage.parse(JSON.parse(text));
        if (
          this.hold &&
          (frame.type === "terminal.result" ||
            frame.type === "host.identity.result" ||
            frame.type === "error")
        ) {
          this.replies.push(() => wire.send(text));
          this.peak = Math.max(this.peak, this.replies.length);
          this.arrival.resolve();
        } else wire.send(text);
      },
    });
    const receive = connection.receive.bind(connection);
    connection.receive = (text) => {
      const frame = ClientMessage.parse(JSON.parse(text));
      if (frame.type === "terminal.request" && frame.operation.op === "close")
        this.closes.push(frame.operation.terminalId);
      receive(text);
    };
    return connection;
  }
  nextReply() {
    return this.replies.length ? Promise.resolve() : this.arrival.promise;
  }
  releaseReplies() {
    const replies = this.replies.splice(0);
    this.arrival = Promise.withResolvers<void>();
    for (const reply of replies) reply();
  }
}

function retryClock() {
  const due = new Set<() => void>();
  const schedule: Schedule = (callback) => {
    due.add(callback);
    return () => {
      due.delete(callback);
    };
  };
  return {
    schedule,
    advance() {
      const callbacks = [...due];
      due.clear();
      for (const callback of callbacks) callback();
    },
  };
}
function seed(daemon: FakeDaemon) {
  new ScenarioPlayer(daemon, failingSubagent()).step();
  return daemon.terminals.openNow({
    threadId: "thread-settings",
    cwd: "/project",
    cols: 80,
    rows: 24,
  });
}

test("hundreds of stale closes use bounded request slots and cannot strand a later live shell", async () => {
  const daemon = new DelayedDaemon({ clock: () => 1000, hostId: "bounded-closes" });
  const terminal = seed(daemon);
  const clock = retryClock();
  const delivery = createTerminalEndDelivery(clock.schedule);
  const client = fakeClient(daemon);
  const owner = delivery.bind(client);
  await client.start();
  await owner.identified;
  client.networkOnline(false);
  for (let handle = 0; handle < 256; handle++)
    delivery.end(client, { threadId: "thread-settings", terminalId: `stale-${handle}` });
  delivery.end(client, { threadId: "thread-settings", terminalId: terminal.id });
  daemon.hold = true;
  client.networkOnline(true);
  // Each stale close receives a failure, then an authoritative scoped list establishes absence.
  for (let reply = 0; reply < 512; reply++) {
    await daemon.nextReply();
    expect(daemon.replies).toHaveLength(1);
    expect(daemon.terminals.list("thread-settings").map((entry) => entry.id)).toEqual([
      terminal.id,
    ]);
    daemon.releaseReplies();
  }
  await waitFor(() => expect(daemon.terminals.list("thread-settings")).toEqual([]));
  await waitFor(() => expect(daemon.replies).toHaveLength(1));
  daemon.releaseReplies();
  expect(daemon.peak).toBe(1);
  expect(daemon.closes).toHaveLength(257);
  expect(daemon.closes.at(-1)).toBe(terminal.id);
  owner.release();
});

test("a close rejected by an occupied request budget retries after slots become available while still connected", async () => {
  const daemon = new DelayedDaemon({ clock: () => 1000, hostId: "saturated-closes" });
  const terminal = seed(daemon);
  const clock = retryClock();
  const delivery = createTerminalEndDelivery(clock.schedule);
  const client = fakeClient(daemon);
  const owner = delivery.bind(client);
  await client.start();
  await owner.identified;
  daemon.hold = true;
  const reads = Array.from({ length: 256 }, () => client.request({ type: "host.identity" }));
  await waitFor(() => expect(daemon.replies).toHaveLength(256));
  delivery.end(client, { threadId: "thread-settings", terminalId: terminal.id });
  // Flush the rejected promise before advancing the injected retry clock.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(client.state).toBe("ready");
  expect(daemon.terminals.list("thread-settings")).toHaveLength(1);
  expect(daemon.closes).toEqual([]);
  daemon.hold = false;
  daemon.releaseReplies();
  await Promise.all(reads);
  clock.advance();
  await waitFor(() => expect(daemon.terminals.list("thread-settings")).toEqual([]));
  expect(daemon.closes).toEqual([terminal.id]);
  owner.release();
});

test("an unacknowledged close retries on a replacement client and retires after definitive absence", async () => {
  const daemon = new DelayedDaemon({ clock: () => 1000, hostId: "unacknowledged-closes" });
  const terminal = seed(daemon);
  const delivery = createTerminalEndDelivery(retryClock().schedule);
  const client = fakeClient(daemon);
  const owner = delivery.bind(client);
  await client.start();
  await owner.identified;
  daemon.hold = true;
  delivery.end(client, { threadId: "thread-settings", terminalId: terminal.id });
  await waitFor(() => expect(daemon.terminals.list("thread-settings")).toEqual([]));
  await waitFor(() => expect(daemon.replies).toHaveLength(1));
  owner.release();
  await client.close();
  daemon.hold = false;
  // Drop the old connection's acknowledgement; it cannot settle a new connection's request.
  daemon.replies = [];
  const replacement = fakeClient(daemon);
  const replacementOwner = delivery.bind(replacement);
  await replacement.start();
  await replacementOwner.identified;
  await waitFor(() => expect(daemon.closes).toEqual([terminal.id, terminal.id]));
  // Await a later scoped read to ensure the absence response has reached this client.
  await replacement.request({
    type: "terminal.request",
    operation: { op: "list", threadId: ThreadId.parse("thread-settings") },
  });
  await Promise.resolve();
  replacementOwner.release();
  await replacement.close();
  const third = fakeClient(daemon);
  const thirdOwner = delivery.bind(third);
  await third.start();
  await thirdOwner.identified;
  await third.request({ type: "host.identity" });
  expect(daemon.closes).toEqual([terminal.id, terminal.id]);
  thirdOwner.release();
});
