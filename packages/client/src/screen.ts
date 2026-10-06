import {
  ScreenStatus,
  ScreenPermissions,
  ScreenGrant,
  ScreenOperation,
  ScreenServerMessage,
  ScreenState,
  ScreenOpenedApp,
  type ScreenTarget,
  type ScreenAgentScope,
} from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { ClientError, type RequestOptions } from "./types.ts";

export class ScreenClientError extends Error {
  readonly errorCode: Extract<ScreenServerMessage, { type: "screen.result" }>["errorCode"];
  readonly holder: { sessionId: string; owner: string } | undefined;
  constructor(result: Extract<ScreenServerMessage, { type: "screen.result" }>) {
    super(result.error ?? "Computer use request failed");
    this.errorCode = result.errorCode;
    this.holder = result.holder;
  }
}
/** One-shot human screen controls. Requests use the client's existing non-replayed service
 * path. Import this subpath when opening computer-use controls to keep startup schemas lazy. */
export class ScreenClient {
  private readonly client: Pick<ClientApi, "request" | "onMessage">;
  constructor(client: Pick<ClientApi, "request" | "onMessage">) {
    this.client = client;
  }
  private async call(operation: ScreenOperation, options?: RequestOptions): Promise<unknown> {
    const response = ScreenServerMessage.parse(
      await this.client.request(
        { type: "screen.request", operation: ScreenOperation.parse(operation) },
        options,
      ),
    );
    if (response.type !== "screen.result")
      throw new ClientError("protocol", "Expected screen result");
    if (!response.ok) throw new ScreenClientError(response);
    return response.data;
  }
  async status(options?: RequestOptions): Promise<ScreenStatus> {
    return ScreenStatus.parse(await this.call({ op: "status" }, options));
  }
  async permissions(options?: RequestOptions): Promise<ScreenPermissions> {
    return ScreenPermissions.parse(await this.call({ op: "permissions" }, options));
  }
  async requestPermission(
    permission: "screenRecording" | "accessibility",
    options?: RequestOptions,
  ): Promise<ScreenPermissions> {
    return ScreenPermissions.parse(
      await this.call({ op: "permissions.request", permission }, options),
    );
  }
  watchEnabled(listener: (enabled: boolean) => void): () => void {
    return this.client.onMessage((message) => {
      if (message.type === "screen.enabled") listener(message.enabled);
    });
  }
  async enable(enabled: boolean, options?: RequestOptions): Promise<void> {
    await this.call({ op: "enable", enabled }, options);
  }
  async approve(
    bundleId: string,
    allowed: boolean,
    scope: ScreenGrant["scope"] = "always",
    threadId?: string,
    options?: RequestOptions,
  ): Promise<void> {
    await this.call({ op: "approve", bundleId, allowed, scope, threadId }, options);
  }
  async approvals(threadId?: string, options?: RequestOptions): Promise<ScreenGrant[]> {
    return ScreenGrant.array()
      .max(256)
      .parse(await this.call({ op: "approvals", threadId }, options));
  }
  async sessions(options?: RequestOptions): Promise<ScreenState[]> {
    return ScreenState.array()
      .max(8)
      .parse(await this.call({ op: "sessions" }, options));
  }
  /** State pushes do not request pixels. Reload sessions after reconnect through Client.connectionState(). */
  watch(listener: (state: ScreenState) => void): () => void {
    return this.client.onMessage((message) => {
      if (message.type === "screen.state") listener(ScreenState.parse(message.state));
    });
  }
  async start(
    target: ScreenTarget,
    threadId?: string,
    options?: RequestOptions,
  ): Promise<ScreenState> {
    return ScreenState.parse(await this.call({ op: "start", target, threadId, fps: 10 }, options));
  }
  async openApp(bundleId: string, options?: RequestOptions) {
    return ScreenOpenedApp.parse(await this.call({ op: "open.app", bundleId }, options));
  }
  async takeover(sessionId: string, options?: RequestOptions): Promise<void> {
    await this.call({ op: "controller", sessionId, controller: "human" }, options);
  }
  async delegate(
    sessionId: string,
    holder: ScreenAgentScope,
    options?: RequestOptions,
  ): Promise<void> {
    await this.call({ op: "controller", controller: "agent", sessionId, ...holder }, options);
  }
  async mode(
    sessionId: string,
    mode: ScreenState["mode"],
    reason?: string,
    options?: RequestOptions,
  ): Promise<ScreenState> {
    return ScreenState.parse(
      await this.call({ op: "mode", sessionId, mode, reason }, { timeoutMs: 65_000, ...options }),
    );
  }
  async secureInput(
    sessionId: string,
    allowed: boolean,
    options?: RequestOptions,
  ): Promise<ScreenState> {
    return ScreenState.parse(await this.call({ op: "secure.input", sessionId, allowed }, options));
  }
  async stop(sessionId: string, options?: RequestOptions): Promise<void> {
    await this.call({ op: "stop", sessionId }, options);
  }
  async stopAll(options?: RequestOptions): Promise<void> {
    await this.call({ op: "stop.all" }, options);
  }
}
