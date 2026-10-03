import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach } from "vitest";
import { BrowserBackendServerMessage, type BrowserControllerLease } from "@ace/protocol";
import {
  BrowserService,
  type BrowserServiceOptions,
  type BrowserBackend,
  type BackendOpen,
} from "./index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
export class FakePage {
  url = "about:blank";
  text = "";
  lease: BrowserControllerLease = { generation: 0, controller: "agent" };
  events = new EventEmitter();
  readonly cdp = {
    send: (method: string, params?: Record<string, unknown>) =>
      Promise.resolve(this.command(method, params)),
    on: (method: string, listener: (value: unknown) => void) => this.events.on(method, listener),
    off: (method: string, listener: (value: unknown) => void) => this.events.off(method, listener),
  };
  command(method: string, params?: Record<string, unknown>): unknown {
    if (method === "Page.captureScreenshot") return { data: "AA==" };
    if (method === "Memory.getDOMCounters") return { nodes: 1 };
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          {
            nodeId: "1",
            ignored: false,
            backendDOMNodeId: 1,
            role: { value: "textbox" },
            name: { value: "Name" },
          },
        ],
      };
    if (method === "DOM.resolveNode") return { object: { objectId: "1" } };
    if (method === "Runtime.callFunctionOn")
      return { result: { value: { x: 0, y: 0, width: 100, height: 100 } } };
    if (method === "Runtime.evaluate") return { result: { value: "1" } };
    if (method === "Input.insertText") this.text += String(params?.["text"]);
    return {};
  }
}
export class FakeHeadless implements BrowserBackend {
  readonly kind = "headless";
  readonly pages: FakePage[] = [];
  readonly opens: BackendOpen[] = [];
  async open(request: BackendOpen) {
    const page = new FakePage();
    this.pages.push(page);
    this.opens.push(request);
    let viewport = { width: 1280, height: 720 };
    return {
      cdp: page.cdp,
      url: () => page.url,
      navigate: async (url: string) => {
        page.url = url;
        request.navigation();
      },
      insertText: async (text: string) => {
        page.text += text;
      },
      click: async () => {},
      press: async () => {},
      wheel: async () => {},
      screenshot: async () => Buffer.from([0]),
      resize: async (width: number, height: number) => {
        viewport = { width, height };
      },
      viewport: () => viewport,
      media: async () => {},
      controller: async (lease: BrowserControllerLease) => {
        page.lease = lease;
      },
      close: async () => {},
    };
  }
}
export async function backendFixture(options: Partial<BrowserServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-backend-"));
  const headless = new FakeHeadless();
  const service = new BrowserService({ dataDir: home, headlessBackend: headless, ...options });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Socket address missing");
  const connected = once(server, "connection");
  const desktop = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(desktop, "open");
  const connection = (await connected)[0];
  if (!(connection instanceof WebSocket)) throw new Error("Socket missing");
  let pressured = false;
  const backend = service.registerEmbedded({
    send: (_message, serialized) => {
      if (pressured) return false;
      connection.send(serialized ?? JSON.stringify(_message));
      return true;
    },
    close: () => connection.close(),
  });
  connection.on("message", (data) => backend.handle(JSON.parse(data.toString())));
  connection.on("close", () => backend.disconnect("Desktop disconnected"));
  const pages = new Map<string, FakePage>();
  const requests = new EventEmitter();
  let hold: string | undefined;
  let redirectUrl: string | undefined;
  let controllerError: string | undefined;
  const sendEvent = (sessionId: string, method: string, params: unknown) =>
    desktop.send(
      JSON.stringify({
        type: "browser.backend.event",
        backendId: backend.id,
        sessionId,
        method,
        params,
      }),
    );
  desktop.on("message", (data) => {
    const message = BrowserBackendServerMessage.parse(JSON.parse(data.toString()));
    if (message.type !== "browser.backend.request") {
      requests.emit(message.type, message);
      return;
    }
    const op = message.operation;
    requests.emit(op.kind === "cdp" ? op.method : op.kind, message);
    if (op.kind === "cdp" && hold === op.method) return;
    let result: unknown = {};
    if (op.kind === "open") {
      pages.set(message.sessionId, new FakePage());
      result = { url: "about:blank" };
    }
    const page = pages.get(message.sessionId);
    if (!page) throw new Error("Unknown desktop session");
    if (op.kind === "cdp") result = page.command(op.method, op.params);
    if (op.kind === "controller" && !controllerError) page.lease = op.lease;
    if (op.kind === "navigate") {
      page.url = redirectUrl ?? op.url;
      result = { url: page.url };
      sendEvent(message.sessionId, "Page.frameNavigated", { frame: { url: page.url } });
    }
    if (op.kind === "close") pages.delete(message.sessionId);
    desktop.send(
      JSON.stringify({
        type: "browser.backend.response",
        backendId: backend.id,
        sessionId: message.sessionId,
        id: message.id,
        ...(op.kind === "controller" && controllerError ? { error: controllerError } : { result }),
      }),
    );
  });
  cleanups.push(async () => {
    await service.close();
    desktop.terminate();
    connection.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  return {
    service,
    headless,
    pages,
    home,
    desktop,
    backend,
    requests,
    sendEvent,
    redirect(url: string) {
      redirectUrl = url;
    },
    failController(reason: string) {
      controllerError = reason;
    },
    pressure() {
      pressured = true;
    },
    hold(method: string) {
      hold = method;
    },
    async disconnect() {
      const closed = once(connection, "close");
      desktop.close();
      await closed;
    },
    open(threadId = "thread") {
      return service.open({ threadId, workspaceId: `workspace-${threadId}` });
    },
  };
}
