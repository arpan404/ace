import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseVersion } from "@ace/provider-kit/discovery";
import { probe } from "@ace/provider-kit/process";
import {
  OpenCodeServer,
  OpenCodeTranslator,
  SessionOwnership,
  type ServerOptions,
} from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import { openCodeScenario } from "./opencode-v2-scenarios.ts";
import { interruptOnce } from "../interrupt.ts";
import type { Driver, RunContext } from "./types.ts";
const Record = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const p = Record.safeParse(value);
  return p.success ? p.data : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/** Authoring this driver does not authorize running it. Every recording needs owner approval. */
export function createOpenCodeRecorder(serverOptions: ServerOptions = {}): Driver {
  return {
    id: "opencode",
    unsupported: ["plan-review"],
    version: async () => {
      const version = parseVersion("opencode", await probe("opencode", ["--version"]));
      if (version !== "2.0.22") throw new Error("Recording requires inspected OpenCode 2.0.22");
      return version;
    },
    async run(ctx: RunContext) {
      if (ctx.scenario.planMode)
        throw new Error(
          "OpenCode v2 plan flow is unverified; record only after a configured flow is approved",
        );
      const { rec, workspace } = ctx;
      const scenario = openCodeScenario(ctx.scenario);
      const controller = new AbortController();
      const server = new OpenCodeServer(serverOptions);
      const ownership = new SessionOwnership(workspace, "");
      const translator = new OpenCodeTranslator({
        threadId: ThreadId.parse("thread_recorder"),
        rootKey: "root",
      });
      let sequence = 0;
      const aborted = () => controller.abort();
      ctx.signal.addEventListener("abort", aborted, { once: true });
      ctx.signal.throwIfAborted();
      let root = "";
      const sessions = new Set<string>();
      let rootEnded = false;
      const commands = new Set<Promise<void>>();
      const record = (dir: "send" | "recv" | "stderr" | "note", channel: string, data: unknown) => {
        const now = rec.elapsedMs();
        translator.translate({ seq: sequence++, t: now, dir, channel, data }, now);
        rec.frame(dir, channel, data, channel !== "transport.activity");
      };
      try {
        await server.ready(controller.signal);
        const client = server.scoped(workspace, record, controller.signal);
        const interrupt = interruptOnce(scenario.interruptAfterToolStartMs, () => {
          rec.note("interrupt-sent");
          void client.session
            .interrupt({ sessionID: root })
            .catch(() => rec.note("interrupt-failed"));
        });
        const settle = () => {
          if (rootEnded && translator.isSettled()) rec.mark("turn-end");
        };
        const handle = async (native: unknown): Promise<void> => {
          const event = object(native),
            p = object(event.data),
            type = text(event.type);
          if (type === "session.created") {
            const created = text(p.sessionID),
              parent = text(p.parentID);
            if (created === root || sessions.has(parent)) sessions.add(created);
          }
          const session = text(p.sessionID);
          if (!sessions.has(session) && type !== "form.created") return;
          if (type === "session.execution.started" && session === root) rootEnded = false;
          if (
            [
              "session.execution.succeeded",
              "session.execution.failed",
              "session.execution.interrupted",
            ].includes(type)
          ) {
            if (session === root) {
              rootEnded = true;
              settle();
            } else rec.mark("child-turn-end", { sessionID: session });
          }
          settle();
          if (type === "session.tool.input.started" && session === root && p.name === "shell")
            interrupt();
          if (type === "permission.asked") {
            ctx.interactions.open();
            try {
              await client.permission.reply({
                sessionID: session,
                requestID: text(p.id),
                decision: "once",
              });
            } finally {
              ctx.interactions.close();
            }
          }
          if (type === "form.created") {
            const form = object(p.form),
              owner = text(form.sessionID);
            if (!sessions.has(owner)) return;
            if (object(form.metadata).kind !== "question") {
              rec.note("unsupported-form", { id: form.id });
              return;
            }
            const fields = z.array(Record).parse(form.fields),
              answer: Record<string, string | string[]> = {};
            for (const field of fields) {
              const options = z.array(Record).parse(field.options ?? []),
                value = text(options[0]?.value) || "Tabs";
              answer[text(field.key)] = field.type === "multiselect" ? [value] : value;
            }
            ctx.interactions.open();
            try {
              await client.session.form.reply({ sessionID: owner, formID: text(form.id), answer });
            } finally {
              ctx.interactions.close();
            }
          }
        };
        const unsubscribe = server.subscribe({
          accepts: (event) => ownership.accept(event),
          receive: (event) => {
            record("recv", "sse", event);
            if (commands.size >= 128) throw new Error("Recorder interaction limit exceeded");
            const task = handle(event).catch(() => rec.note("handler-error"));
            commands.add(task);
            void task.finally(() => commands.delete(task));
          },
          frame: record,
          disconnected: () => {
            record("note", "lifecycle", { type: "disconnected" });
            rec.note("incomplete-disconnected");
            controller.abort();
          },
          reconcile: () => {},
          buffered: () => {},
          prepareReplay: () => {},
          close: async () => {
            controller.abort();
          },
          resync: async () => {
            throw new Error(
              "A disconnected recording is incomplete; approve a new attempt separately",
            );
          },
          finalizeSnapshots: () => {},
          recovered: () => rec.note("recovered"),
          exited: () => controller.abort(),
        });
        try {
          const model = ctx.model ?? "opencode-go/muse-spark-1.3-contributor",
            slash = model.indexOf("/");
          if (slash < 1) throw new Error("OpenCode model must be provider/model");
          const info = z
            .object({ id: z.string() })
            .passthrough()
            .parse(
              await client.session.create({
                title: "ace-recorder",
                location: { directory: workspace },
                model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
                permissions: [
                  { action: "edit", resource: "*", effect: "ask" },
                  { action: "shell", resource: "*", effect: "ask" },
                ],
              }),
            );
          ownership.establish(info);
          root = info.id;
          sessions.add(root);
          await client.session.prompt({
            sessionID: root,
            id: `msg_recorder_${randomBytes(16).toString("hex")}`,
            text: scenario.prompt,
            delivery: "queue",
          });
          await ctx.settled(() => rootEnded && translator.isSettled(), controller.signal);
          if (controller.signal.aborted) return;
          if (!translator.isSettled()) rec.note("incomplete-at-time-cap");
          // Capture projected history alongside the native lifecycle, with opaque cursors.
          for (const sessionID of sessions) {
            let cursor: string | undefined;
            for (let n = 0; n < 512; n++) {
              const page = await client.message.list({
                sessionID,
                limit: 128,
                ...(cursor ? { cursor } : { order: "asc" }),
              });
              if (!page.cursor.next) break;
              if (page.cursor.next === cursor || n === 511)
                throw new Error("Recorder history pagination incomplete");
              cursor = page.cursor.next;
            }
          }
          await Promise.all(commands);
        } finally {
          // Cleanup still runs if projected history fails, without another model turn.
          if (!controller.signal.aborted)
            for (const sessionID of [...sessions].toReversed())
              await client.session.remove({ sessionID }).catch(() => rec.note("cleanup-failed"));
          unsubscribe();
        }
      } finally {
        ctx.signal.removeEventListener("abort", aborted);
        controller.abort();
        await server.close();
      }
    },
  };
}
export const opencode = createOpenCodeRecorder();
