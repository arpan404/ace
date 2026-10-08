import { z } from "zod";
import { aceToolName, redactAceArguments } from "@ace/core";
import {
  ItemId,
  ThreadId,
  type McpAttribution,
  type ScreenState,
  type ToolResult,
} from "@ace/protocol";
import type { ContextService } from "@ace/context";
import type { CallObserver } from "@ace/mcp-server";
import type { ScreenManager } from "@ace/screen";
import type { Store } from "./store.ts";
import { argumentKey } from "./measurement-correlation.ts";
import { captureToolResult } from "./tool-result-content.ts";
interface Runtime {
  store: Store;
  now(): number;
  id(): string;
  context(): ContextService | undefined;
  screen(): ScreenManager | undefined;
}
const argumentsSchema = z.object({
  sessionId: z.string().optional(),
  bundleId: z.string().max(256).optional(),
});
function screenState(
  runtime: Runtime,
  caller: McpAttribution,
  input: unknown,
  name: string,
): ScreenState | undefined {
  const manager = runtime.screen();
  if (!manager) return;
  const args = argumentsSchema.safeParse(input);
  const requested = args.success ? args.data.sessionId : undefined;
  const owned = manager
    .states()
    .filter(
      (state) =>
        state.holder?.threadId === caller.threadId &&
        state.holder.agentId === caller.agentId &&
        (requested === undefined || state.sessionId === requested),
    );
  if (owned.length === 1) return owned[0];
  try {
    const id =
      name === "screen_measure_interaction"
        ? manager.measurementSession(caller, args.success ? args.data.sessionId : undefined)
        : manager.agentSession(caller, args.success ? args.data.sessionId : undefined);
    return manager.state(id);
  } catch {
    return;
  }
}
function target(
  state: ScreenState | undefined,
  input: unknown,
): Pick<ToolResult, "target" | "mode"> {
  const args = argumentsSchema.safeParse(input);
  const bundleId =
    state?.target.kind !== "display"
      ? (state?.target.bundleId ?? (args.success ? args.data.bundleId : undefined))
      : undefined;
  return {
    ...(state ? { mode: state.mode } : {}),
    ...(bundleId
      ? {
          target: {
            bundleId,
            displayName: bundleId.split(".").at(-1) ?? bundleId,
            ...(state?.target.kind === "window" ? { windowId: state.target.windowId } : {}),
          },
        }
      : {}),
  };
}
/** Results are observed at the registry, before provider-specific echoes lose images or errors. */
export function toolResultObserver(runtime: Runtime) {
  const { store } = runtime;
  const leases = new Map<string, number>();
  function correlate(id: string) {
    const row = store
      .statement("SELECT * FROM ace_results WHERE id=? AND item_id IS NULL AND result IS NOT NULL")
      .get(id);
    if (!row || row.bound_id === "") return;
    const candidates =
      row.bound_id === null
        ? store
            .statement(`SELECT id FROM ace_tools t WHERE thread_id=? AND agent_id=? AND name=? AND args=?
        AND seq>? AND started BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id) LIMIT 2`)
            .all(
              String(row.thread_id),
              String(row.agent_id),
              String(row.name),
              String(row.args),
              Number(row.since_seq),
              Number(row.started) - 90_000,
              Number(row.finished) + 5000,
            )
        : store
            .statement(
              "SELECT id FROM ace_tools t WHERE id=? AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id)",
            )
            .all(String(row.bound_id));
    if (candidates.length !== 1 || !candidates[0]) return;
    const thread = ThreadId.parse(row.thread_id);
    const item = store.measurements.item(thread, String(candidates[0].id));
    if (item?.type !== "tool_call") return;
    store.atomic(() => {
      store
        .statement("UPDATE ace_results SET item_id=? WHERE id=? AND item_id IS NULL")
        .run(item.id, id);
      store.appendEvents(thread, [{ type: "item.updated", item }], runtime.now());
      if (row.notice_id) {
        const notice = store.measurements.item(thread, String(row.notice_id));
        if (notice?.type === "notice")
          store.appendEvents(
            thread,
            [
              {
                type: "item.updated",
                item: {
                  ...notice,
                  toolCallId: item.id,
                  raw: notice.raw.map((raw) =>
                    "data" in raw
                      ? Object.assign({}, raw, {
                          data: {
                            ...z.record(z.string(), z.unknown()).parse(raw.data),
                            toolCallId: item.id,
                          },
                        })
                      : raw,
                  ),
                },
              },
            ],
            runtime.now(),
          );
      }
    });
  }
  const stop = store.subscribe((events) => {
    for (const event of events) {
      if (event.payload.type !== "item.created" && event.payload.type !== "item.updated") continue;
      const item = event.payload.item;
      if (
        item.type !== "tool_call" ||
        item.call.result ||
        item.call.detail.kind !== "mcp" ||
        item.call.detail.server !== "ace"
      )
        continue;
      const rows = store
        .statement(
          `SELECT id FROM ace_results WHERE thread_id=? AND agent_id=? AND name=? AND args=? AND item_id IS NULL AND finished>=? LIMIT 64`,
        )
        .all(
          event.threadId,
          item.agentId,
          item.call.detail.tool,
          argumentKey(item.call.detail.arguments),
          runtime.now() - 5000,
        );
      for (const row of rows) correlate(String(row.id));
    }
  });
  const observeCall: CallObserver = (name, input, { caller }) => {
    if (!aceToolName(name) || !store.getThread(caller.threadId)) return;
    const key = argumentKey(redactAceArguments(name, input));
    const started = runtime.now();
    const since = store.headSeq();
    const prior = store
      .statement(`SELECT id FROM ace_tools t WHERE thread_id=? AND agent_id=? AND name=? AND args=? AND seq>?
      AND started BETWEEN ? AND ? AND status IN ('pending','running','awaiting_approval')
      AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id OR r.bound_id=t.id) LIMIT 2`)
      .all(
        caller.threadId,
        caller.agentId,
        name,
        key,
        leases.get(caller.sessionId) ?? since,
        started - 90_000,
        started,
      );
    const id = runtime.id();
    const before = name.startsWith("screen_")
      ? screenState(runtime, caller, input, name)
      : undefined;
    store.atomic(() => {
      // Concurrent identical invocations cannot be identified from provider envelopes.
      const overlapping = store
        .statement(
          "SELECT 1 FROM ace_results WHERE session_id=? AND name=? AND args=? AND finished IS NULL LIMIT 1",
        )
        .get(caller.sessionId, name, key);
      if (overlapping)
        store
          .statement(
            "UPDATE ace_results SET bound_id='' WHERE session_id=? AND name=? AND args=? AND item_id IS NULL",
          )
          .run(caller.sessionId, name, key);
      store
        .statement(
          "INSERT INTO ace_results(id,thread_id,agent_id,session_id,name,args,started,since_seq,bound_id) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          caller.threadId,
          caller.agentId,
          caller.sessionId,
          name,
          key,
          started,
          since,
          overlapping || prior.length > 1 ? "" : (prior[0]?.id ?? null),
        );
    });
    return async (value) => {
      const thread = store.getThread(caller.threadId);
      if (!thread || thread.deletedAt !== undefined) return;
      const finished = runtime.now();
      const result = await captureToolResult(
        name,
        value,
        input,
        Math.max(0, finished - started),
        caller,
        runtime.context(),
      );
      const screen = name.startsWith("screen_");
      const metadata = screen
        ? target(screenState(runtime, caller, input, name) ?? before, input)
        : {};
      const captured: ToolResult = { ...metadata, ...result };
      if (name === "screen_request_app") {
        const requested = argumentsSchema.safeParse(input);
        if (requested.success && requested.data.bundleId)
          captured.target = {
            bundleId: requested.data.bundleId,
            displayName: requested.data.bundleId.split(".").at(-1) ?? requested.data.bundleId,
          };
      }
      const noticeId = screen ? ItemId.parse(runtime.id()) : undefined;
      const first = result.content.find((part) => part.type === "text");
      let outcome = result.isError ? "failed" : "completed";
      if (result.isError && first?.type === "text") {
        try {
          const error = z.object({ code: z.string().max(64) }).safeParse(JSON.parse(first.text));
          if (error.success) outcome = error.data.code;
        } catch {
          /* Registry failures can be plain text. */
        }
      }
      store.atomic(() => {
        store
          .statement("UPDATE ace_results SET result=?,finished=?,notice_id=? WHERE id=?")
          .run(JSON.stringify(captured), finished, noticeId ?? null, id);
        for (const part of result.content)
          if (part.type === "image")
            store
              .statement("INSERT OR IGNORE INTO ace_result_images VALUES(?,?,?)")
              .run(id, caller.threadId, part.attachment.sha256);
        if (noticeId)
          store.appendEvents(
            caller.threadId,
            [
              {
                type: "item.created",
                item: {
                  type: "notice",
                  id: noticeId,
                  agentId: caller.agentId,
                  createdAt: finished,
                  complete: true,
                  level: result.isError ? "warning" : "info",
                  code: "screen.step",
                  text: `${name} · ${captured.target?.displayName ?? "screen"} · ${captured.mode ?? "unavailable"} · ${outcome}`,
                  raw: [
                    {
                      type: "ace.screen.step",
                      data: {
                        sessionId: before?.sessionId,
                        action: name,
                        ...captured.target,
                        mode: captured.mode,
                        outcome,
                      },
                    },
                  ],
                },
              },
            ],
            finished,
          );
        correlate(id);
      });
    };
  };
  return {
    observeCall,
    lease(sessionId: string) {
      leases.set(sessionId, store.headSeq());
      return () => {
        leases.delete(sessionId);
        store
          .statement(
            "UPDATE ace_results SET bound_id='' WHERE session_id=? AND item_id IS NULL AND bound_id IS NULL",
          )
          .run(sessionId);
      };
    },
    close: stop,
  };
}
