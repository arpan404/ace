import {
  discoveryFailureCode,
  discoveryFailureReason,
  type DiscoveryFailureCode,
} from "@ace/provider-kit/discovery-failure";
import { safeCursorErrorMessage } from "./sdk-failure.ts";
import { z } from "zod";
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
  outputFlow?: import("@ace/provider-kit/flow-control").OutputFlow;
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
  private errorMessage: string | undefined;
  private metadataFailureDetail: string | undefined;
  private metadataFailureCode: DiscoveryFailureCode | undefined;
  get failureMessage(): string | undefined {
    return this.errorMessage;
  }
  constructor(
    options: HostOptions,
    onFrame: (frame: CursorEnvelope, payload: ProviderPayload) => void | Promise<void>,
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
          String(this.limits.graceMs),
        ],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...options.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        name: "cursor-sdk-host",
        ...(options.outputFlow ? { outputFlow: options.outputFlow } : {}),
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
    const receiveFrame = async (params: unknown) => {
      const payload = new ProviderPayload(boundedJson(params, this.limits.maxFrameBytes));
      const frame = Envelope.parse(payload.data);
      if (frame.generation !== this.generation && !(frame.replayed && frame.boundaryOffset))
        throw new Error("SDK generation mismatch");
      await onFrame(frame, payload);
      if (frame.kind === "error") {
        const error = z.object({ message: z.string() }).safeParse(frame.body);
        if (error.success)
          this.errorMessage = safeCursorErrorMessage(error.data.message, options.env);
        void this.stop();
      }
    };
    this.rpc.onRequest = async ({ method, params }) => {
      if (method !== "frame") throw new Error("Unknown SDK host request");
      await receiveFrame(params);
      return { committed: true };
    };
    this.rpc.onNotification = ({ method, params }) => {
      if (method === "login-url") {
        const url =
          typeof params === "object" && params !== null && "url" in params ? params.url : undefined;
        if (typeof url !== "string" || url.length > 8192 || !url.startsWith("https://"))
          throw new Error("Unsafe login URL");
        onLoginUrl(url);
      } else if (method === "frame")
        void receiveFrame(params).catch(() => {
          void this.stop();
        });
      else throw new Error("Unknown host notification");
    };
    // Retain only bounded, scrubbed prose. Auth workers never publish this buffer.
    this.process.stderr.on("line", (line: string) => {
      this.errorMessage = safeCursorErrorMessage(line, options.env);
      const code = discoveryFailureCode({ message: line });
      if (code !== "discovery_failed") this.metadataFailureCode = code;
      if (
        line.trim() &&
        !/^(?:\s*at\s|node:internal\/|Node\.js\sv)/.test(line) &&
        (!this.metadataFailureDetail ||
          code !== "discovery_failed" ||
          /\b[A-Za-z]*Error[:[]/.test(line))
      )
        this.metadataFailureDetail = discoveryFailureReason(
          { message: line },
          { env: options.env },
        );
    });
  }
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (params !== undefined) boundedJson(params, this.limits.maxFrameBytes - 1024);
    return this.rpc
      .request(method, params, timeoutMs === undefined ? {} : { timeoutMs })
      .catch(async (error: unknown) => {
        await this.stop();
        const exit = await this.process.exited;
        const code = discoveryFailureCode(
          error,
          this.metadataFailureCode ??
            (exit.reason === "spawn-error" || exit.code === 78
              ? "not_configured"
              : "discovery_failed"),
        );
        const suppliedReason = discoveryFailureReason(error);
        const reason =
          /^(?:process (?:exited|closed)|JSON-RPC closed|closed|EOF|write EPIPE)$/i.test(
            suppliedReason,
          )
            ? `Cursor SDK host ended with code ${exit.code ?? "none"} (${exit.reason}). ${this.metadataFailureDetail ?? suppliedReason}`.slice(
                0,
                2048,
              )
            : suppliedReason;
        throw Object.assign(
          new Error(
            `${["open", "send", "cancel"].includes(method) && this.errorMessage ? this.errorMessage + " " : ""}Cursor SDK ${method} failed; delivery may be uncertain. Inspect history before resending.`,
          ),
          {
            code,
            ...(method === "models" && code === "discovery_failed" ? { detail: reason } : {}),
          },
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
