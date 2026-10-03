import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { discoverSdk, type SdkDiscoveryOptions } from "@ace/provider-kit/sdk";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { boundedJson } from "@ace/provider-kit/ipc";
import type { CursorHostSlots } from "./slots.ts";
import {
  Envelope,
  Limits,
  sdkVersion,
  type CursorEnvelope,
  type CursorLimits,
} from "./contracts.ts";

export interface HostOptions {
  env: NodeJS.ProcessEnv;
  slots?: CursorHostSlots;
  instanceId?: string;
  cwd?: string;
  limits?: Partial<CursorLimits>;
  spawn?: typeof spawnSupervised;
  node?: string;
  entry?: string;
  discovery?: SdkDiscoveryOptions;
  generation?: () => string;
}
export async function discoverCursorSdk(options: SdkDiscoveryOptions = {}) {
  const localResolve = createRequire(import.meta.url).resolve;
  const resolve = (id: string) =>
    id === "@cursor/sdk"
      ? localResolve(id)
      : createRequire(localResolve("@cursor/sdk")).resolve(id);
  return discoverSdk("@cursor/sdk", sdkVersion, { resolve, ...options });
}
export class CursorHost {
  readonly generation: string;
  readonly process: SupervisedProcess;
  private rpc: JsonRpcPeer;
  private stopped: Promise<void> | undefined;
  private limits: CursorLimits;
  constructor(
    options: HostOptions,
    onFrame: (frame: CursorEnvelope, payload: ProviderPayload) => void,
    onLoginUrl: (url: string) => void = () => {},
  ) {
    this.generation = (options.generation ?? randomUUID)();
    this.limits = Limits.parse(options.limits ?? {});
    const release = options.slots?.acquire();
    try {
      this.process = (options.spawn ?? spawnSupervised)({
        command: options.node ?? process.execPath,
        args: [
          `--max-old-space-size=${this.limits.heapMb}`,
          options.entry ?? fileURLToPath(new URL("./host-entry.ts", import.meta.url)),
        ],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...options.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        name: "cursor-sdk-host",
        maxLineBytes: this.limits.maxFrameBytes,
      });
    } catch (error) {
      release?.();
      throw error;
    }
    const untrack = options.instanceId
      ? options.slots?.track(options.instanceId, () => this.stop())
      : undefined;
    void this.process.exited.finally(() => {
      untrack?.();
      release?.();
    });
    this.rpc = new JsonRpcPeer(this.process, {
      timeoutMs: this.limits.timeoutMs,
      maxMessageBytes: this.limits.maxFrameBytes,
      maxQueuedBytes: this.limits.maxPendingBytes,
      maxPendingRequests: 16,
      onMalformed: () => {
        void this.stop();
      },
      onError: () => {
        void this.stop();
      },
    });
    this.rpc.onNotification = ({ method, params }) => {
      if (method === "login-url") {
        // Deliberately outside frame capture. Caller must use authorized ephemeral UI.
        const url =
          typeof params === "object" && params !== null && "url" in params ? params.url : undefined;
        if (typeof url !== "string" || url.length > 8192 || !url.startsWith("https://"))
          throw new Error("Unsafe login URL");
        onLoginUrl(url);
      } else if (method === "frame") {
        const payload = new ProviderPayload(boundedJson(params, this.limits.maxFrameBytes));
        const frame = Envelope.parse(payload.data);
        if (frame.generation !== this.generation) throw new Error("SDK generation mismatch");
        onFrame(frame, payload);
        if (frame.kind === "error") void this.stop();
      } else throw new Error("Unknown host notification");
    };
    // Drain diagnostics, but never persist SDK stderr or auth diagnostic text.
    this.process.stderr.on("line", () => {});
  }
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (params !== undefined) boundedJson(params, this.limits.maxFrameBytes - 1024);
    return this.rpc
      .request(method, params, timeoutMs === undefined ? {} : { timeoutMs })
      .catch(async () => {
        await this.stop();
        throw new Error(
          `Cursor SDK ${method} failed; delivery may be uncertain. Inspect history before resending.`,
        );
      });
  }
  stop(): Promise<void> {
    this.stopped ??= (async () => {
      this.rpc.close();
      await this.process.stop({ graceMs: this.limits.graceMs });
    })();
    return this.stopped;
  }
}
