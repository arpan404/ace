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
  const payload = await new Promise<unknown>((resolve, reject) => {
    proc.stdout.on("line", (line: string) => {
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
        envelope.data.id !== "ace-models" ||
        envelope.data.command !== "get_available_models"
      )
        return;
      try {
        resolve(PiReply.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    void proc.exited.then(() => reject(new Error("Pi metadata process exited before listing")));
    proc.stdin.write(
      JSON.stringify({ type: "get_available_models", id: "ace-models" }) + "\n",
      (error) => {
        if (error) reject(error);
      },
    );
  });
  signal.throwIfAborted();
  return PiReply.parse(payload).data.models.map((native) =>
    CatalogModel.parse({
      ...base(instance, `${native.provider}/${native.id}`, native.name, native),
      nativeProviderId: native.provider,
      nativeModelId: native.id,
      contextWindow: native.contextWindow,
      inputModalities: native.input ?? [],
    }),
  );
}
