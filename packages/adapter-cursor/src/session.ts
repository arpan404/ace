import type { ProviderSession, SessionContext } from "@ace/engine-api";
import type { Key } from "@ace/core";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { boundedJson } from "@ace/provider-kit/ipc";
import type { AceMcpConnection } from "@ace/mcp-server";
import { CursorHost, type HostOptions } from "./host.ts";
import { cursorCapabilitiesForSandbox } from "./policy.ts";
import { Limits, type CursorLimits } from "./contracts.ts";

export interface CursorSessionOptions extends HostOptions {
  instanceId: string;
  policy?: "restricted" | "full-access";
  autoReviewAvailable?: boolean;
  now?: () => number;
  operationId?: () => string;
  mcp?: AceMcpConnection;
  /** Validated, bounded checkpoint evidence; never appended as fresh live history. */
  recoverySnapshot?: Awaited<ReturnType<typeof import("./history.ts").readCursorSnapshot>>;
}
const OpenReply = z.object({ agentId: z.string().min(1).max(512) });
export async function openCursorSession(
  context: SessionContext,
  options: CursorSessionOptions,
): Promise<ProviderSession> {
  context.signal.throwIfAborted();
  if (context.resume && context.resume.backend !== "cursor-sdk")
    throw new Error("Cursor SDK cannot resume an ACP checkpoint; use explicit context handoff");
  if (context.resume && context.resume.instanceId !== options.instanceId)
    throw new Error("SDK resume is pinned to its original provider instance");
  const limits = Limits.parse(options.limits ?? {});
  let seq = 0;
  const now = options.now ?? Date.now;
  const started = now();
  const frame = (
    dir: "send" | "note",
    kind: "cancel" | "host-exit" | "snapshot",
    body: unknown,
    operationId: string,
    segment: number,
  ) => {
    const payload = new ProviderPayload(
      boundedJson({
        schemaVersion: 1,
        generation: host.generation,
        operationId,
        segment,
        kind,
        body,
      }),
    );
    context.onFrame({
      seq: ++seq,
      t: now() - started,
      dir,
      channel: "sdk",
      data: payload.data,
      payload,
    });
  };
  const host = new CursorHost(
    { ...options, ...(context.outputFlow ? { outputFlow: context.outputFlow } : {}) },
    async (data, payload) => {
      if (data.boundaryOffset) seq = data.boundaryOffset * 1024 - 1;
      if (data.kind === "open") {
        const support = z.object({ sandboxSupported: z.boolean() }).safeParse(data.body);
        context.onCapabilities?.(
          cursorCapabilitiesForSandbox(support.success && support.data.sandboxSupported),
        );
      }
      if (data.kind === "open" && data.agentId)
        context.onSessionIdentity?.({
          backend: "cursor-sdk",
          instanceId: options.instanceId,
          nativeSessionId: data.agentId,
        });
      if (
        (data.kind === "result" || data.kind === "error") &&
        data.operationId === operation &&
        data.segment === segment
      ) {
        const result = z.object({ status: z.string() }).safeParse(data.body);
        if (
          data.kind === "error" ||
          (result.success && ["finished", "cancelled", "error"].includes(result.data.status))
        )
          active = false;
        else uncertain = true;
      }
      await context.onFrame({
        seq: ++seq,
        t: now() - started,
        dir: data.kind === "send" ? "send" : "recv",
        channel: "sdk",
        data: payload.data,
        payload,
      });
    },
  );
  let deliberate = false;
  let exited = false;
  let operation = "open";
  let segment = 0;
  let active = false;
  let uncertain = false;
  let control = false;
  let closing: Promise<void> | undefined;
  const abort = () => {
    void close("shutdown").catch(() => {});
  };
  context.signal.addEventListener("abort", abort, { once: true });
  void host.process.exited.then(() => {
    exited = true;
    context.signal.removeEventListener("abort", abort);
    frame("note", "host-exit", { deliberate }, operation, segment);
    context.onExit({
      deliberate,
      ...(deliberate
        ? {}
        : {
            message: "Cursor stopped unexpectedly. Unfinished work needs your attention.",
          }),
    });
  });
  const close = (reason: "idle" | "user" | "shutdown"): Promise<void> => {
    closing ??= (async () => {
      deliberate = true;
      try {
        if (!exited) await host.request("close", { reason }, limits.graceMs);
      } finally {
        await host.stop();
        context.signal.removeEventListener("abort", abort);
      }
    })();
    return closing;
  };
  try {
    const reply = OpenReply.parse(
      await host.request("open", {
        cwd: context.cwd,
        threadId: context.threadId,
        generation: host.generation,
        ...(context.model ? { model: context.model } : {}),
        modelParams: readCursorModelParams(context.options),
        ...(context.resume
          ? {
              nativeSessionId: context.resume.nativeSessionId,
              afterFrameOffset: context.resume.afterFrameOffset ?? 0,
            }
          : {}),
        ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
        autoReviewAvailable: options.autoReviewAvailable ?? false,
        limits,
        ...(options.mcp ? { mcp: options.mcp } : {}),
      }),
    );
    context.signal.throwIfAborted();
    if (options.recoverySnapshot) frame("note", "snapshot", options.recoverySnapshot, "open", 0);
    return {
      nativeSessionId: reply.agentId,
      backend: "cursor-sdk",
      instanceId: options.instanceId,
      async configure(selection) {
        if (selection.provider !== "cursor" || !selection.model)
          throw new Error("Invalid Cursor selection");
        await host.request("configure", {
          model: selection.model,
          modelParams: readCursorModelParams(selection.options),
        });
      },
      async send(input: ContentPart[], delivery, commandId) {
        if (closing || exited) throw new Error("SDK host is closed");
        if (uncertain)
          throw new Error(
            "SDK delivery or terminal state is uncertain; close and reconcile before sending",
          );
        if (control) throw new Error("SDK control already in flight");
        boundedJson(input, limits.maxInputBytes);
        // The engine serializes queued sends. SDK terminal evidence clears active via cancel.
        control = true;
        try {
          if (delivery === "steer" && active) {
            frame("send", "cancel", { replacement: true, commandId }, operation, segment);
            await host.request("cancel");
            segment++;
          } else {
            // A previous run may already have settled; cancel also awaits its drain.
            if (active) await host.request("cancel");
            operation = commandId ?? options.operationId?.() ?? `${host.generation}:${++seq}`;
            segment = 0;
          }
          active = true;
          try {
            if (commandId) context.onInputMessage?.({ commandId, nativeId: commandId });
            await host.request("send", {
              operationId: operation,
              commandId: commandId ?? operation,
              segment,
              input,
            });
          } catch (error) {
            active = false;
            uncertain = true;
            throw error;
          }
        } finally {
          control = false;
        }
      },
      async interrupt(target: { agent?: Key; cascade: boolean }) {
        if (target.agent !== undefined && target.agent !== (context.rootKey ?? "root"))
          throw new Error("unsupported: Cursor SDK task children are read-only");
        if (control) throw new Error("SDK control already in flight");
        control = true;
        try {
          frame("send", "cancel", { replacement: false }, operation, segment);
          try {
            await host.request("cancel");
          } finally {
            // Root interruption owns the whole host; disposal/group exit also
            // stops work that outlived the SDK run handle. Steering stays separate.
            await close("user");
            active = false;
          }
        } finally {
          control = false;
        }
      },
      resolve(_interaction: Key, _resolution: InteractionResolution) {
        return Promise.reject(
          new Error(
            "unsupported: Cursor SDK has sandbox-only approvals and no question or plan-review callback",
          ),
        );
      },
      stopTask(_task: Key) {
        return Promise.reject(
          new Error("unsupported: Cursor SDK individual task control is unavailable"),
        );
      },
      close,
    };
  } catch (error) {
    await host.stop();
    context.signal.removeEventListener("abort", abort);
    throw error;
  }
}
export type { CursorLimits };
import { readCursorModelParams } from "@ace/provider-kit/cursor-selection";
