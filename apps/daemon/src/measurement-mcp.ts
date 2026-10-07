import { createHash } from "node:crypto";
import { z } from "zod";
import {
  InteractionMeasurement,
  InteractionFilmstrip,
  StepMeasurement,
  ItemId,
  ThreadId,
  type McpAttribution,
} from "@ace/protocol";
import type { ContextService } from "@ace/context";
import type { CallObserver } from "@ace/mcp-server";
import type { Store } from "./store.ts";
import { argumentKey, measurementTool, measurementCall } from "./measurement-correlation.ts";

interface Runtime {
  store: Store;
  now(): number;
  id(): string;
  context(): ContextService | undefined;
}
const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z
    .array(
      z
        .looseObject({ type: z.string(), text: z.string().max(32_768).optional() })
        .or(InteractionFilmstrip),
    )
    .max(8),
});

async function filmstrip(
  runtime: Runtime,
  caller: McpAttribution,
  image: z.infer<typeof InteractionFilmstrip>,
) {
  const context = runtime.context();
  if (!context) throw new Error("Measurement attachment service unavailable");
  const bytes = Buffer.from(image.data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const device = "daemon-measurement";
  const begin = await context.uploads.handle(device, {
    op: "upload.begin",
    threadId: caller.threadId,
    sha256,
    bytes: bytes.length,
    name: "interaction-filmstrip.jpg",
    mimeType: image.mimeType,
  });
  if (begin.kind !== "upload") throw new Error("Filmstrip upload refused");
  try {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      await context.uploads.handle(device, {
        op: "upload.chunk",
        uploadId: begin.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 64 * 1024).toString("base64"),
      });
    const committed = await context.uploads.handle(device, {
      op: "upload.commit",
      uploadId: begin.uploadId,
    });
    if (committed.kind !== "attachment") throw new Error("Filmstrip commit refused");
    return committed.attachment;
  } catch (error) {
    await context.uploads.handle(device, { op: "upload.cancel", uploadId: begin.uploadId });
    throw error;
  }
}

/** A scoped call result is captured before any provider echo or inline raw cap. */
export function measurementObserver(runtime: Runtime) {
  const leases = new Map<string, number>();
  const { store } = runtime;
  function correlate(id: string): void {
    const row = store
      .statement("SELECT * FROM step_measurements WHERE id=? AND item_id IS NULL")
      .get(id);
    if (!row || row.bound_id === "") return;
    const candidates =
      row.bound_id === null
        ? store.measurements.candidates(
            String(row.thread_id),
            String(row.name),
            String(row.args),
            Number(row.since_seq),
            Number(row.started),
            Number(row.finished),
          )
        : store
            .statement(
              "SELECT id FROM measurement_tools t WHERE id=? AND NOT EXISTS(SELECT 1 FROM step_measurements m WHERE m.item_id=t.id)",
            )
            .all(String(row.bound_id));
    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    if (!candidate) return;
    const thread = ThreadId.parse(row.thread_id);
    const item = store.measurements.item(thread, String(candidate.id));
    if (item?.type !== "tool_call") return;
    store.atomic(() => {
      store
        .statement("UPDATE step_measurements SET item_id=? WHERE id=? AND item_id IS NULL")
        .run(item.id, id);
      store.appendEvents(
        thread,
        [
          {
            type: "item.updated",
            item: {
              ...item,
              measurement: StepMeasurement.parse(JSON.parse(String(row.measurement))),
            },
          },
          { type: "item.deleted", itemId: ItemId.parse(id) },
        ],
        runtime.now(),
      );
    });
  }
  const stop = store.subscribe((events) => {
    for (const event of events) {
      if (event.payload.type !== "item.created" && event.payload.type !== "item.updated") continue;
      if (event.payload.item.type !== "tool_call" || event.payload.item.measurement) continue;
      const call = measurementCall(event.payload.item);
      if (!call) continue;
      const rows = store
        .statement(
          `SELECT id FROM step_measurements WHERE thread_id=? AND name=? AND args=? AND item_id IS NULL AND finished>=? LIMIT 64`,
        )
        .all(event.threadId, call.name, call.key, runtime.now() - 5000);
      for (const row of rows) correlate(String(row.id));
    }
  });
  const observeCall: CallObserver = (name, input, { caller }) => {
    if (!measurementTool(name)) return;
    const key = argumentKey(input);
    const started = runtime.now();
    const since = store.headSeq();
    const prior = store.measurements.running(
      caller.threadId,
      name,
      key,
      leases.get(caller.sessionId) ?? since,
      started,
    );
    const bound = prior.length > 1 ? "" : (prior[0]?.id ?? null);
    store
      .statement(
        "UPDATE step_measurements SET bound_id='' WHERE session_id=? AND name=? AND args=? AND item_id IS NULL",
      )
      .run(caller.sessionId, name, key);
    return async (result) => {
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success || parsed.data.isError) return;
      const text = parsed.data.content.find((part) => part.type === "text");
      if (!text || !("text" in text) || !text.text) return;
      let value: unknown;
      try {
        value = JSON.parse(text.text);
      } catch {
        return;
      }
      const metrics = InteractionMeasurement.safeParse(value);
      if (!metrics.success) return;
      const image = parsed.data.content.find((part) => part.type === "image");
      const checkedImage = InteractionFilmstrip.safeParse(image ?? metrics.data.filmstrip);
      const { filmstrip: _inline, ...numbers } = metrics.data;
      const measurement = StepMeasurement.parse({
        ...numbers,
        ...(checkedImage.success
          ? { filmstrip: await filmstrip(runtime, caller, checkedImage.data) }
          : {}),
      });
      const thread = store.getThread(caller.threadId);
      if (!thread || thread.deletedAt !== undefined) return;
      const id = ItemId.parse(runtime.id());
      const finished = runtime.now();
      store.atomic(() => {
        store
          .statement("INSERT INTO step_measurements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            caller.threadId,
            caller.agentId,
            caller.sessionId,
            name,
            key,
            started,
            finished,
            since,
            null,
            bound,
            JSON.stringify(measurement),
            measurement.filmstrip?.sha256 ?? null,
          );
        store.appendEvents(
          caller.threadId,
          [
            {
              type: "item.created",
              item: {
                type: "notice",
                id,
                agentId: caller.agentId,
                createdAt: finished,
                complete: true,
                level: "info",
                code: "interaction_measurement",
                text: "Measured smoothness",
                measurement,
                raw: [],
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
            "UPDATE step_measurements SET bound_id='' WHERE session_id=? AND item_id IS NULL",
          )
          .run(sessionId);
      };
    },
    close: stop,
  };
}
