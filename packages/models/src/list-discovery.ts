import { z } from "zod";
import { CatalogModel } from "@ace/protocol";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { base } from "./model.ts";
import type { ModelInstance } from "./types.ts";

export async function discoverListedModels(
  instance: ModelInstance,
  signal: AbortSignal,
  spawn: (options: SpawnOptions) => SupervisedProcess,
): Promise<CatalogModel[]> {
  signal.throwIfAborted();
  const proc = spawn({
    command: instance.executable,
    args: [
      ...instance.args,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
    ],
    cwd: instance.cwd,
    env: { ...instance.env, PI_OFFLINE: "1" },
    name: "model-discovery",
    maxOutputBytes: 4 * 1024 * 1024,
  });
  const abort = () => {
    void proc.stop({ graceMs: 0 });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const rows = await piModels(proc, instance, signal);
    const exit = await proc.stop({ graceMs: 0 });
    if (exit.reason === "output-limit") throw new Error("Pi model metadata exceeded output limit");
    if (exit.reason !== "stopped" && !(exit.reason === "exit" && exit.code === 0))
      throw new Error("Pi metadata process failed");
    signal.throwIfAborted();
    return rows;
  } finally {
    signal.removeEventListener("abort", abort);
    await proc.stop({ graceMs: 0 });
  }
}

const PiEnvelope = z
  .object({ type: z.string(), id: z.string().optional(), command: z.string().optional() })
  .passthrough();
const PiReply = z
  .object({
    type: z.literal("response"),
    id: z.literal("ace-models"),
    command: z.literal("get_available_models"),
    success: z.literal(true),
    data: z
      .object({
        models: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                provider: z.string().min(1).max(256),
                name: z.string().min(1).max(256),
                contextWindow: z.number().int().positive().optional(),
                input: z.array(z.string()).max(32).optional(),
              })
              .passthrough(),
          )
          .max(512),
      })
      .passthrough(),
  })
  .passthrough();
async function piModels(
  proc: SupervisedProcess,
  instance: ModelInstance,
  signal: AbortSignal,
): Promise<CatalogModel[]> {
  const payload = await piRequest(proc, "get_available_models", "ace-models");
  const state = z
    .object({ model: z.object({ provider: z.string(), id: z.string() }).nullish() })
    .passthrough()
    .parse(await piRequest(proc, "get_state", "ace-models-state"));
  signal.throwIfAborted();
  return PiReply.parse(payload).data.models.map((native) =>
    CatalogModel.parse({
      ...base(instance, `${native.provider}/${native.id}`, native.name, native),
      isDefault: state.model?.provider === native.provider && state.model.id === native.id,
      nativeProviderId: native.provider,
      nativeModelId: native.id,
      contextWindow: native.contextWindow,
      inputModalities: native.input ?? [],
    }),
  );
}
async function piRequest(
  proc: SupervisedProcess,
  command: "get_available_models" | "get_state",
  id: string,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const receive = (line: string) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const envelope = PiEnvelope.safeParse(data);
      if (
        !envelope.success ||
        envelope.data.type !== "response" ||
        envelope.data.id !== id ||
        envelope.data.command !== command
      )
        return;
      try {
        const reply = z
          .object({ success: z.literal(true), data: z.unknown() })
          .passthrough()
          .parse(data);
        proc.stdout.removeListener("line", receive);
        resolve(command === "get_available_models" ? PiReply.parse(data) : reply.data);
      } catch (error) {
        proc.stdout.removeListener("line", receive);
        reject(error);
      }
    };
    proc.stdout.on("line", receive);
    void proc.exited.then(() => {
      proc.stdout.removeListener("line", receive);
      reject(new Error("Pi metadata process exited before listing"));
    });
    proc.stdin.write(JSON.stringify({ type: command, id }) + "\n", (error) => {
      if (error) reject(error);
    });
  });
}
