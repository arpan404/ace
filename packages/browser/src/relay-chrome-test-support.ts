import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserBackendServerMessage, type BrowserBackendClientMessage } from "@ace/protocol";
import type { EmbeddedBackend } from "./embedded.ts";

const Reply = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** One raw CDP connection to a page target: every event, no Playwright in between. */
class RawPage {
  private socket: WebSocket;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private listeners = new Set<(method: string, params: unknown) => void>();
  readonly ready: Promise<void>;
  constructor(url: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = Reply.parse(JSON.parse(String(data)));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method)
        for (const listener of this.listeners) listener(message.method, message.params);
    });
    this.socket.on("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP closed"));
      this.pending.clear();
    });
  }
  send(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }
  onEvent(listener: (method: string, params: unknown) => void): void {
    this.listeners.add(listener);
  }
  close(): void {
    this.listeners.clear();
    this.socket.terminate();
  }
}

interface DomNode {
  nodeId: number;
  attributes?: string[] | undefined;
  children?: DomNode[] | undefined;
  shadowRoots?: DomNode[] | undefined;
}
const DomNode: z.ZodType<DomNode> = z.lazy(() =>
  z.object({
    nodeId: z.number(),
    attributes: z.array(z.string()).optional(),
    children: z.array(DomNode).optional(),
    shadowRoots: z.array(DomNode).optional(),
  }),
);
const BoxModel = z.object({ model: z.object({ border: z.array(z.number()).length(8) }) });

function findLabelled(node: DomNode, label: string): DomNode | undefined {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2)
    if (attributes[index] === "aria-label" && attributes[index + 1] === label) return node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const found = findLabelled(child, label);
    if (found) return found;
  }
  return undefined;
}

const Target = z.array(
  z.object({ id: z.string(), type: z.string(), webSocketDebuggerUrl: z.string().optional() }),
);
const Navigated = z.object({
  frame: z.object({ url: z.string(), parentId: z.string().optional() }),
});

/**
 * Stands in for the desktop's side of the relay (ADR 0055) the way `page-group.ts` does it:
 * tab commands arrive as `ace.tabs.cdp` and pass through to the page's debugger unchanged, and
 * page events go back as `ace.tabs.event`. The page is a real Chrome tab over raw CDP.
 */
export async function chromeDesktop(executablePath: string) {
  const profile = await mkdtemp(join(tmpdir(), "ace-relay-chrome-"));
  const child = spawn(
    executablePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Tests run with a temporary HOME; the real keychain would block Chrome's network stack.
      "--use-mock-keychain",
      "--password-store=basic",
      "--window-size=1280,720",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const found = /DevTools listening on ws:\/\/([^/]+)\//.exec(output);
      if (found?.[1]) resolve(found[1]);
    });
    child.once("exit", () => reject(new Error(`Chrome exited: ${output.slice(0, 500)}`)));
  });
  const connect = async () => {
    const targets = Target.parse(await (await fetch(`http://${endpoint}/json/list`)).json());
    const url = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
    if (!url) throw new Error("No page target");
    const page = new RawPage(url);
    await page.ready;
    return page;
  };
  let page = await connect();
  let backend: EmbeddedBackend | undefined;
  let sessionId = "";
  const tabId = "native-tab";
  let url = "about:blank";
  /** The next open hands back the kept page, as a desktop re-adopting its view does. */
  let adopted = false;
  const deliver = (message: BrowserBackendClientMessage) => backend?.handle(message);
  const event = (method: string, params: unknown) =>
    deliver({
      type: "browser.backend.event",
      backendId: backend?.id ?? "",
      sessionId,
      method,
      params,
    });
  const tabs = () => ({ activeTabId: tabId, tabs: [{ tabId, url, title: "" }] });
  const forward = (source: RawPage) =>
    source.onEvent((method, params) => {
      if (source !== page) return;
      if (method === "Page.screencastFrame") {
        const frame = z.object({ sessionId: z.number() }).safeParse(params);
        if (frame.success) void source.send("Page.screencastFrameAck", frame.data).catch(() => {});
        return;
      }
      const navigated = method === "Page.frameNavigated" ? Navigated.safeParse(params) : undefined;
      if (navigated?.success && !navigated.data.frame.parentId) {
        url = navigated.data.frame.url;
        event("ace.tabs.changed", tabs());
      }
      event("ace.tabs.event", { tabId, method, params });
    });
  forward(page);
  async function respond(message: BrowserBackendServerMessage): Promise<void> {
    if (message.type !== "browser.backend.request") return;
    const { operation } = message;
    const reply = (result: unknown, error?: string) =>
      deliver({
        type: "browser.backend.response",
        backendId: message.backendId,
        sessionId: message.sessionId,
        id: message.id,
        ...(error === undefined ? { result } : { error }),
      });
    try {
      if (operation.kind === "open") {
        sessionId = message.sessionId;
        const kept = adopted;
        adopted = false;
        return reply({ url, ...tabs(), ...(kept ? { adopted: true } : {}) });
      }
      if (operation.kind === "navigate") {
        await page.send("Page.navigate", { url: operation.url });
        return reply({ url: operation.url });
      }
      if (operation.kind !== "cdp") return reply({});
      const tab = operation.method === "ace.tabs.cdp";
      const inner = z
        .object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() })
        .parse(tab ? operation.params : { method: operation.method, params: operation.params });
      if (inner.method === "ace.tabs.list") return reply(tabs());
      if (inner.method.startsWith("ace.") || inner.method === "Page.screencastFrameAck")
        return reply({});
      reply(await page.send(inner.method, inner.params));
    } catch (error) {
      reply(undefined, error instanceof Error ? error.message : "failed");
    }
  }
  return {
    transport: {
      send: (message: unknown) => {
        const parsed = BrowserBackendServerMessage.parse(message);
        setImmediate(() => void respond(parsed));
        return true;
      },
      close: () => {},
    },
    attach(registered: EmbeddedBackend) {
      backend = registered;
    },
    /**
     * As a link blip does (ADR 0085): the daemon's relay loses the desktop, the page lives on
     * and its old debugger session goes away, then the desktop registers again (`register`)
     * and hands the same page back to the next open on a fresh debugger session.
     */
    async relink(register: () => EmbeddedBackend): Promise<void> {
      const old = backend;
      const stale = page;
      page = await connect();
      forward(page);
      stale.close();
      adopted = true;
      old?.disconnect("Desktop app disconnected");
      backend = register();
    },
    /**
     * As the desktop recovers a crashed renderer: crash it, attach a fresh debugger session,
     * reload, re-enable domains, then report `ace.rendererRestarted` for the tab.
     */
    async crashAndRestart(): Promise<void> {
      const old = page;
      const crashed = new Promise<void>((resolve) =>
        old.onEvent((method) => {
          if (method === "Inspector.targetCrashed") resolve();
        }),
      );
      void old.send("Page.crash").catch(() => {});
      await crashed;
      old.close();
      page = await connect();
      forward(page);
      // The browser process owns navigation, so a crashed tab can be reloaded before its
      // new renderer has domains enabled.
      await page.send("Page.navigate", { url });
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = z
          .object({ result: z.object({ value: z.unknown() }) })
          .safeParse(await page.send("Runtime.evaluate", { expression: "document.readyState" }));
        if (state.success && state.data.result.value === "complete") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      event("ace.tabs.event", { tabId, method: "ace.rendererRestarted", params: {} });
    },
    /**
     * The viewport box of the element labelled `label`, looked up the way DevTools does: through
     * closed shadow roots, on a debugger session of its own. Undefined when absent or not shown.
     */
    async labelled(
      label: string,
    ): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
      const inspector = await connect();
      try {
        const { root } = z
          .object({ root: DomNode })
          .parse(await inspector.send("DOM.getDocument", { depth: -1, pierce: true }));
        const node = findLabelled(root, label);
        if (!node) return undefined;
        const box = BoxModel.safeParse(
          await inspector.send("DOM.getBoxModel", { nodeId: node.nodeId }).catch(() => ({})),
        );
        if (!box.success) return undefined;
        const [x1 = 0, y1 = 0, x2 = 0, , , y3 = 0] = box.data.model.border;
        return { x: x1, y: y1, width: x2 - x1, height: y3 - y1 };
      } finally {
        inspector.close();
      }
    },
    async close(): Promise<void> {
      page.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
      await rm(profile, { recursive: true, force: true });
    },
  };
}
