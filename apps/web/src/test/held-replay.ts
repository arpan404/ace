import type { FakeDaemon } from "@ace/fake-daemon";
import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";

type Frame = {
  type?: unknown;
  scope?: { kind?: unknown; threadId?: unknown };
  command?: { payload?: unknown };
};
const frame = (text: string): Frame => {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
};

/**
 * The daemon on the far side of a reconnect, in slow motion: `hold()` drops the connection and
 * lets the next one through to its welcome, but leaves its thread and thread-list subscriptions
 * unanswered, so the client is connected while what it shows hasn't caught up. `release()` lets
 * them through on a fresh connection. `hold({ threads })` holds only those threads' replays: the
 * rest, the thread list included, catch up. Install before the client connects. Also records every
 * command payload the client sends (`sent`).
 */
export function slowReplay(daemon: FakeDaemon) {
  const state = {
    held: false,
    commands: false,
    only: undefined as ReadonlySet<string> | undefined,
  };
  const heldScope = (scope: Frame["scope"]) => {
    if (scope?.kind !== "thread" && scope?.kind !== "threads") return false;
    if (!state.only) return true;
    return (
      scope.kind === "thread" &&
      typeof scope.threadId === "string" &&
      state.only.has(scope.threadId)
    );
  };
  const sent: { type: string; [key: string]: unknown }[] = [];
  const connect = daemon.connect.bind(daemon);
  daemon.connect = (wire) => {
    const connection = connect(wire);
    const receive = connection.receive.bind(connection);
    connection.receive = (text: string) => {
      const message = frame(text);
      if (message.type === "command" && message.command?.payload)
        sent.push(message.command.payload as (typeof sent)[number]);
      // Lost on the way: the client keeps it in its outbox and sends it again on reconnect.
      if (state.commands && message.type === "command") return;
      if (state.held && message.type === "subscribe" && heldScope(message.scope)) return;
      receive(text);
    };
    return connection;
  };
  return {
    sent,
    /** Reconnect, with the replay held back after the welcome. */
    async hold(
      client: { readonly state: string; reconnectNow(): void },
      options: { threads?: readonly string[] } = {},
    ) {
      state.held = true;
      state.only = options.threads && new Set(options.threads);
      act(() => daemon.disconnectAll());
      act(() => client.reconnectNow());
      await waitFor(() => expect(client.state).toBe("ready"), { timeout: 10_000 });
    },
    /** Commands the client sends from now on are lost on the way, until `deliverCommands`. */
    loseCommands() {
      state.commands = true;
    },
    /** Reconnect with commands getting through: the client's outbox replays what was lost. */
    deliverCommands(client: { reconnectNow(): void }) {
      state.commands = false;
      act(() => daemon.disconnectAll());
      act(() => client.reconnectNow());
    },
    /** Reconnect again and let the replay through. */
    release(client: { reconnectNow(): void }) {
      state.held = false;
      act(() => daemon.disconnectAll());
      act(() => client.reconnectNow());
    },
  };
}
