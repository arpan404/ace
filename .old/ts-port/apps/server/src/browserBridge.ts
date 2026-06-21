import { randomUUID } from "node:crypto";

import type {
  BrowserBridgeOperation,
  BrowserBridgeRequest,
  BrowserBridgeResolveInput,
  ThreadId,
} from "@ace/contracts";

const DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS = 30_000;

export interface BrowserBridgeRequestInput {
  readonly threadId: ThreadId;
  readonly operation: BrowserBridgeOperation;
  readonly args: Record<string, unknown>;
}

type BrowserBridgeListener = (request: BrowserBridgeRequest) => void;

interface PendingBrowserBridgeRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class BrowserBridge {
  private readonly listeners = new Set<BrowserBridgeListener>();
  private readonly pending = new Map<string, PendingBrowserBridgeRequest>();

  subscribe(listener: BrowserBridgeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(input: BrowserBridgeRequestInput): Promise<Record<string, unknown>> {
    if (this.listeners.size === 0) {
      return Promise.reject(new Error("Ace browser bridge is not connected."));
    }

    const request: BrowserBridgeRequest = {
      args: input.args,
      operation: input.operation,
      requestId: randomUUID(),
      threadId: input.threadId,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("Ace browser bridge timed out."));
      }, DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS);

      this.pending.set(request.requestId, {
        reject,
        resolve,
        timeout,
      });

      const listeners = Array.from(this.listeners);
      for (const listener of listeners) {
        try {
          listener(request);
        } catch {
          // One broken browser client must not prevent other connected clients
          // from receiving the request.
        }
      }
    });
  }

  resolve(input: BrowserBridgeResolveInput): void {
    const pending = this.pending.get(input.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(input.requestId);

    if (!input.ok) {
      pending.reject(new Error(input.error ?? "Ace browser bridge request failed."));
      return;
    }

    pending.resolve(input.result ?? {});
  }
}

export const browserBridge = new BrowserBridge();
