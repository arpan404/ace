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

  it("hands the page an editor's icon only as a PNG data URL", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    const main = fakeIpc({ [requestChannel("shell.editorIcon")]: icon });
    await expect(createBridge(main.ipc, info).shell.editorIcon("zed")).resolves.toBe(icon);
    const odd = fakeIpc({ [requestChannel("shell.editorIcon")]: "https://example.com/zed.png" });
    await expect(createBridge(odd.ipc, info).shell.editorIcon("zed")).rejects.toBeInstanceOf(
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
    await expect(ace.settings.update({ globalShortcut: "x".repeat(200) })).rejects.toBeInstanceOf(
      BridgeError,
    );
    expect(main.sent).toEqual([]);
  });

  it("sends valid requests with their parsed payload", async () => {
    const main = fakeIpc({ [requestChannel("shell.openInEditor")]: true });
    const ace = createBridge(main.ipc, info);
    await expect(ace.shell.openInEditor({ path: "/repo/src/app.ts", line: 12 })).resolves.toBe(
      true,
    );
    expect(main.sent).toEqual([
      {
        channel: requestChannel("shell.openInEditor"),
        payload: { path: "/repo/src/app.ts", line: 12 },
      },
    ]);
  });

  it("hands back the folder chosen in the native picker, or null when cancelled", async () => {
    const chosen = fakeIpc({ [requestChannel("dialog.openFolder")]: "/Users/me/Code/app" });
    await expect(createBridge(chosen.ipc, info).dialogs.openFolder()).resolves.toBe(
      "/Users/me/Code/app",
    );
    expect(chosen.sent).toEqual([
      { channel: requestChannel("dialog.openFolder"), payload: undefined },
    ]);
    const cancelled = fakeIpc({ [requestChannel("dialog.openFolder")]: null });
    await expect(createBridge(cancelled.ipc, info).dialogs.openFolder()).resolves.toBeNull();
  });

  it("refuses a folder answer that isn't an absolute path", async () => {
    for (const answer of ["Code/app", "", 42, { path: "/x" }]) {
      const main = fakeIpc({ [requestChannel("dialog.openFolder")]: answer });
      await expect(createBridge(main.ipc, info).dialogs.openFolder()).rejects.toBeInstanceOf(
        BridgeError,
      );
    }
  });

  it("gives the page a dropped folder's absolute path and nothing for anything else", () => {
    const paths = new Map<unknown, string>();
    const native = {
      pathForFile(file: File) {
        const path = paths.get(file);
        if (path === undefined) throw new Error("not a file");
        return path;
      },
    };
    const ace = createBridge(fakeIpc().ipc, info, native);
    const folder = new File([], "app");
    const image = new File([], "image.png");
    const stray = new File([], "stray");
    paths.set(folder, "/Users/me/Code/app");
    paths.set(image, "");
    paths.set(stray, "relative/stray");
    expect(ace.files.pathForFile(folder)).toBe("/Users/me/Code/app");
    expect(ace.files.pathForFile(image)).toBeNull();
    expect(ace.files.pathForFile(stray)).toBeNull();
    expect(ace.files.pathForFile(new File([], "unknown"))).toBeNull();
    // Without Electron's webUtils (a test page), no path ever reaches the page.
    expect(createBridge(fakeIpc().ipc, info).files.pathForFile(folder)).toBeNull();
  });

  it("shows the daemon's logs and quits through the main process", async () => {
    const main = fakeIpc({
      [requestChannel("daemon.showLogs")]: false,
      [requestChannel("app.quit")]: undefined,
    });
    const ace = createBridge(main.ipc, info);
    await expect(ace.daemon.showLogs()).resolves.toBe(false);
    await expect(ace.app.quit()).resolves.toBeUndefined();
    expect(main.sent.map((entry) => entry.channel)).toEqual([
      requestChannel("daemon.showLogs"),
      requestChannel("app.quit"),
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
});

/** A page whose history pushes, dispatched events and `<html>` attributes are recorded. */
function page(path: string, options: { parsed?: boolean } = {}) {
  const pushed: string[] = [];
  const events: string[] = [];
  const attributes = new Set<string>();
  const root = {
    toggleAttribute(name: string, force?: boolean) {
      const on = force ?? !attributes.has(name);
      if (on) attributes.add(name);
      else attributes.delete(name);
      return on;
    },
  };
  let loaded: (() => void) | undefined;
  const document = {
    documentElement: options.parsed === false ? null : root,
    addEventListener: (_type: "DOMContentLoaded", listener: () => void) => {
      loaded = listener;
    },
  };
  const window: PageWindow = {
    history: { pushState: (_state, _title, url) => void pushed.push(String(url)) },
    location: { pathname: path, search: "" },
    dispatchEvent: (event) => {
      events.push(event.type);
      return true;
    },
    document,
  };
  /** The parser created `<html>` and finished the document. */
  const parse = () => {
    document.documentElement = root;
    loaded?.();
  };
  return { window, pushed, events, attributes, parse };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const windowState = (fullScreen: boolean) => ({ focused: true, maximized: false, fullScreen });

describe("page hooks", () => {
  it("routes a deep link through history so the router follows it", () => {
    const main = fakeIpc();
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("deep-link"), { kind: "thread", threadId: "t 1" });
    expect(target.pushed).toEqual(["/t/t%201"]);
    expect(target.events).toEqual(["popstate"]);
  });

  it("opens New thread on a folder from an ace://open link", () => {
    const main = fakeIpc();
    const target = page("/t/t-1");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("deep-link"), { kind: "open-folder", path: "/Users/me/My App" });
    expect(target.pushed).toEqual(["/new?folder=%2FUsers%2Fme%2FMy%20App"]);
    expect(target.events).toEqual(["popstate"]);
  });

  it("does not push the page it is already on", () => {
    const main = fakeIpc();
    const target = page("/offsets");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("deep-link"), { kind: "deck" });
    expect(target.pushed).toEqual([]);
  });

  it("marks <html> while the window is full screen", async () => {
    const main = fakeIpc({ [requestChannel("window.state")]: windowState(true) });
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    await settle();
    expect(target.attributes.has("data-fullscreen")).toBe(true);
    main.emit(eventChannel("window.changed"), windowState(false));
    expect(target.attributes.has("data-fullscreen")).toBe(false);
    main.emit(eventChannel("window.changed"), windowState(true));
    expect(target.attributes.has("data-fullscreen")).toBe(true);
  });

  it("marks full screen once <html> exists when the window starts full screen", async () => {
    const main = fakeIpc({ [requestChannel("window.state")]: windowState(true) });
    const target = page("/", { parsed: false });
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    await settle();
    expect(target.attributes.has("data-fullscreen")).toBe(false);
    target.parse();
    expect(target.attributes.has("data-fullscreen")).toBe(true);
  });

  it("keeps a full-screen change that arrives before the starting state", async () => {
    const main = fakeIpc({ [requestChannel("window.state")]: windowState(false) });
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("window.changed"), windowState(true));
    await settle();
    expect(target.attributes.has("data-fullscreen")).toBe(true);
  });

  it("tells the page it is online again after the machine wakes", () => {
    const main = fakeIpc();
    const target = page("/");
    attachPageHooks(createBridge(main.ipc, info), target.window, deepLinkRoute);
    main.emit(eventChannel("system.resumed"), undefined);
    expect(target.events).toEqual(["online"]);
  });
});
