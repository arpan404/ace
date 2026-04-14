import { DEFAULT_SERVER_SETTINGS, WS_METHODS } from "@ace/contracts";
import {
  buildWebSocketAuthProtocol,
  extractWebSocketClientSessionIdFromProtocolHeader,
  extractWebSocketConnectionIdFromProtocolHeader,
} from "@ace/shared/wsAuth";
import { Duration } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;
type DomListener = () => void;

const sockets: MockWebSocket[] = [];
const windowListeners = new Map<string, Set<DomListener>>();
const documentListeners = new Map<string, Set<DomListener>>();
let visibilityState: DocumentVisibilityState = "visible";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly protocols: string | string[] | undefined;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string, protocols?: string | string[]) {
    this.protocols = protocols;
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalDocument = globalThis.document;

function addDomListener(map: Map<string, Set<DomListener>>, type: string, listener: DomListener) {
  const listeners = map.get(type) ?? new Set<DomListener>();
  listeners.add(listener);
  map.set(type, listeners);
}

function removeDomListener(
  map: Map<string, Set<DomListener>>,
  type: string,
  listener: DomListener,
) {
  map.get(type)?.delete(listener);
}

function emitDomEvent(map: Map<string, Set<DomListener>>, type: string) {
  const listeners = map.get(type);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

function emitWindowEvent(type: string) {
  emitDomEvent(windowListeners, type);
}

const mockServerConfig = {
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.ace-keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  settings: DEFAULT_SERVER_SETTINGS,
} as const;

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

beforeEach(() => {
  sockets.length = 0;
  windowListeners.clear();
  documentListeners.clear();
  visibilityState = "visible";
  const sessionStorageState = new Map<string, string>();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          sessionStorageState.set(key, value);
        },
      },
      addEventListener: (type: string, listener: DomListener) => {
        addDomListener(windowListeners, type, listener);
      },
      removeEventListener: (type: string, listener: DomListener) => {
        removeDomListener(windowListeners, type, listener);
      },
      desktopBridge: undefined,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (type: string, listener: DomListener) => {
        addDomListener(documentListeners, type, listener);
      },
      removeEventListener: (type: string, listener: DomListener) => {
        removeDomListener(documentListeners, type, listener);
      },
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and moves auth tokens into subprotocols", async () => {
    const transport = new WsTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    expect(socket.url).toBe("ws://localhost:3020/ws");
    const header = Array.isArray(socket.protocols)
      ? socket.protocols.join(",")
      : String(socket.protocols);
    expect(socket.protocols).toEqual(
      expect.arrayContaining([buildWebSocketAuthProtocol("secret-token")]),
    );
    expect(extractWebSocketClientSessionIdFromProtocolHeader(header)).toBeTruthy();
    expect(extractWebSocketConnectionIdFromProtocolHeader(header)).toBeTruthy();
    await transport.dispose();
  });

  it("uses wss when falling back to an https page origin", async () => {
    Object.assign(window.location, {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      port: "",
      protocol: "https:",
    });

    const transport = new WsTransport();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("retries unary requests after transient websocket disconnects", async () => {
    const transport = new WsTransport("ws://localhost:3020", {
      connectionProbeIntervalMs: 0,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetConfig]({}));

    await waitFor(() => {
      const request = firstSocket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; tag?: string })
        .find(
          (message) => message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
        );
      expect(request).toBeDefined();
    });

    firstSocket.close(1006, "abnormal closure");

    await waitFor(() => {
      expect(sockets.length).toBeGreaterThan(1);
    });

    const retrySocket = getSocket();
    retrySocket.open();

    await waitFor(() => {
      const request = retrySocket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; tag?: string })
        .find(
          (message) => message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
        );
      expect(request).toBeDefined();
    });

    const retryRequest = retrySocket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
      );
    if (!retryRequest) {
      throw new Error("Expected a retried unary request");
    }
    retrySocket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: retryRequest.id,
        exit: {
          _tag: "Success",
          value: mockServerConfig,
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual(mockServerConfig);
    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("emits disconnect and reconnect notifications for resubscribed streams", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();
    const connectionListener = vi.fn();
    const unsubscribeConnection = transport.onConnectionStateChange(connectionListener);

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      expect(connectionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "disconnected",
        }),
      );
    });

    await waitFor(() => {
      expect(socket.sent.length).toBeGreaterThan(1);
    });

    await waitFor(() => {
      expect(connectionListener).toHaveBeenCalledWith({
        kind: "reconnected",
      });
    });

    unsubscribeConnection();
    unsubscribe();
    await transport.dispose();
  });

  it("probes the connection when the window regains focus", async () => {
    const transport = new WsTransport("ws://localhost:3020", {
      connectionProbeIntervalMs: 0,
      connectionProbeTimeoutMs: 500,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();
    emitWindowEvent("focus");

    await waitFor(() => {
      const probeRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; tag?: string })
        .find(
          (message) => message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
        );
      expect(probeRequest).toBeDefined();
    });

    const probeRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
      );
    if (!probeRequest) {
      throw new Error("Expected a connection probe request");
    }
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: probeRequest.id,
        exit: {
          _tag: "Success",
          value: mockServerConfig,
        },
      }),
    );

    await transport.dispose();
  });

  it("uses successful probes to restore connection state after disconnection", async () => {
    const transport = new WsTransport("ws://localhost:3020", {
      connectionProbeIntervalMs: 0,
      connectionProbeTimeoutMs: 500,
    });
    const connectionListener = vi.fn();
    const unsubscribeConnection = transport.onConnectionStateChange(connectionListener);

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      () => undefined,
      { retryDelay: Duration.seconds(60) },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const streamRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.tag === WS_METHODS.subscribeServerLifecycle,
      );
    if (!streamRequest) {
      throw new Error("Expected a server lifecycle request");
    }
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: streamRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      expect(connectionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "disconnected",
        }),
      );
    });

    emitWindowEvent("focus");

    await waitFor(() => {
      const probeRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; tag?: string })
        .find(
          (message) => message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
        );
      expect(probeRequest).toBeDefined();
    });

    const probeRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig,
      );
    if (!probeRequest) {
      throw new Error("Expected a connection probe request");
    }
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: probeRequest.id,
        exit: {
          _tag: "Success",
          value: mockServerConfig,
        },
      }),
    );

    await waitFor(() => {
      expect(connectionListener).toHaveBeenCalledWith({
        kind: "reconnected",
      });
    });

    unsubscribeConnection();
    unsubscribe();
    await transport.dispose();
  });

  it("streams finite request events without re-subscribing", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      clientScope: {} as never,
      probeListenerCleanups: [],
      connectionProbeIntervalHandle: null,
      queuedProbe: false,
      runtime,
    } as unknown as WsTransport;

    WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });
});
