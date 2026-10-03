import { describe, expect, it } from "vitest";
import { eventChannel, requestChannel } from "../shared/channels.ts";
import { createBridge, BridgeError, type BridgeIpc } from "./bridge.ts";
import { attachPageHooks, type PageWindow } from "./page-hooks.ts";
import { deepLinkRoute } from "../shared/contract.ts";

const info = {
  version: "0.1.0",
  platform: "darwin",
  arch: "arm64",
  electron: "44.5.1",
  packaged: false,
} as const;

/** A fake main process: records what crossed the bridge and answers with canned values. */
function fakeIpc(answers: Record<string, unknown> = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const ipc: BridgeIpc = {
    async invoke(channel, payload) {
      sent.push({ channel, payload });
      return answers[channel];
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };
  const emit = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  return { ipc, sent, emit };
}

const token = "0123456789abcdef".repeat(4);

describe("window.ace bridge", () => {
  it("hands the page the daemon address and token from the main process", async () => {
    const main = fakeIpc({
      [requestChannel("daemon.connection")]: { mode: "daemon", url: "ws://127.0.0.1:4242/", token },
    });
    const ace = createBridge(main.ipc, info);
    await expect(ace.daemon.connection()).resolves.toEqual({
      mode: "daemon",
      url: "ws://127.0.0.1:4242/",
      token,
    });
  });

  it("refuses a malformed connection answer instead of passing it to the page", async () => {
    const main = fakeIpc({
      [requestChannel("daemon.connection")]: { mode: "daemon", url: "http://evil", token: "x" },
    });
    await expect(createBridge(main.ipc, info).daemon.connection()).rejects.toBeInstanceOf(
      BridgeError,
    );
  });

  it("never sends requests the main process would have to reject", async () => {
    const main = fakeIpc();
    const ace = createBridge(main.ipc, info);
    await expect(ace.shell.reveal("relative/path")).rejects.toBeInstanceOf(BridgeError);
    await expect(ace.shell.openExternal("file:///etc/passwd")).rejects.toBeInstanceOf(BridgeError);
    await expect(ace.shell.openExternal("javascript:alert(1)")).rejects.toBeInstanceOf(BridgeError);
    await expect(ace.notifications.setBadge(-1)).rejects.toBeInstanceOf(BridgeError);
    await expect(
      ace.settings.update({ globalShortcut: "x".repeat(200) }),
    ).rejects.toBeInstanceOf(BridgeError);
    expect(main.sent).toEqual([]);
  });

  it("sends valid requests with their parsed payload", async () => {
    const main = fakeIpc({ [requestChannel("shell.openInEditor")]: true });
    const ace = createBridge(main.ipc, info);
    await expect(ace.shell.openInEditor({ path: "/repo/src/app.ts", line: 12 })).resolves.toBe(
      true,
    );
    expect(main.sent).toEqual([
      { channel: requestChannel("shell.openInEditor"), payload: { path: "/repo/src/app.ts", line: 12 } },
    ]);
  });

  it("delivers well-formed events and drops malformed ones", () => {
    const main = fakeIpc();
    const ace = createBridge(main.ipc, info);
    const seen: unknown[] = [];
    const stop = ace.onDeepLink((link) => seen.push(link));
    main.emit(eventChannel("deep-link"), { kind: "thread", threadId: "t-1" });
    main.emit(eventChannel("deep-link"), { kind: "thread" });
    main.emit(eventChannel("deep-link"), "ace://thread/t-2");
    stop();
    main.emit(eventChannel("deep-link"), { kind: "thread", threadId: "t-3" });
    expect(seen).toEqual([{ kind: "thread", threadId: "t-1" }]);
  });

  it("exposes the app version and platform synchronously", () => {
    const ace = createBridge(fakeIpc().ipc, info);
    expect([ace.version, ace.platform]).toEqual(["0.1.0", "darwin"]);
  });
});

describe("page hooks", () => {
  function page(path: string) {
    const pushed: string[] = [];
    const events: string[] = [];
    const window: PageWindow = {
      history: { pushState: (_state, _title, url) => void pushed.push(String(url)) },
      location: { pathname: path, search: "" },
      dispatchEvent: (event) => {
        events.push(event.type);
        return true;
      },
    };
    return { window, pushed, events };
  }

  it("routes a deep link through history so the router follows it", () => {
    const main = fakeIpc();
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("deep-link"), { kind: "thread", threadId: "t 1" });
    expect(target.pushed).toEqual(["/t/t%201"]);
    expect(target.events).toEqual(["popstate"]);
  });

  it("does not push the page it is already on", () => {
    const main = fakeIpc();
    const target = page("/deck");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("deep-link"), { kind: "deck" });
    expect(target.pushed).toEqual([]);
  });

  it("tells the page it is online again after the machine wakes", () => {
    const main = fakeIpc();
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("system.resumed"), undefined);
    expect(target.events).toEqual(["online"]);
  });
});
