import { ThreadView } from "@ace/protocol";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build } from "vite";
import { z } from "zod";
import { zodWithoutJsonSchema, zodWithoutMetadata } from "../../zod-json-schema.ts";
import { droppedPerfWorkerZodMethods, zodWithoutUnusedMethods } from "../../zod-methods.ts";
import { zodPureSchemas } from "../../zod-pure-schemas.ts";
import { workerZod } from "../../worker-zod.ts";

test("the production perf worker can produce a transcript with the optimized browser schemas", async () => {
  const root = join(import.meta.dirname, "../..");
  const entry = join(root, "perf-worker-test-entry.js");
  const built = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "perf-worker-test-entry",
        resolveId: (id) => (id === entry ? "\0perf-worker-test-entry" : null),
        load: (id) =>
          id === "\0perf-worker-test-entry"
            ? `
          import { SoakDaemon } from "@ace/fake-daemon";
          const daemon = new SoakDaemon({ clock: () => 1000 });
          daemon.pump(100);
          export const transcript = JSON.stringify(daemon.snapshot({
            kind: "thread", threadId: daemon.threadId,
          }));
        `
            : null,
      },
      zodWithoutJsonSchema(),
      zodWithoutMetadata(),
      zodWithoutUnusedMethods(droppedPerfWorkerZodMethods),
      zodPureSchemas(),
      workerZod(),
    ],
    build: {
      write: false,
      target: "es2023",
      lib: { entry, formats: ["cjs"], fileName: "entry" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const output = (Array.isArray(built) ? built : "output" in built ? [built] : []).flatMap(
    (result) => result.output,
  );
  const chunk = output.find((result) => result.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Build produced no runnable worker");
  const module: { exports: unknown } = { exports: {} };
  const require = createRequire(join(root, "package.json"));
  new Function("module", "exports", "require", chunk.code)(module, module.exports, require);
  const exported = z.object({ transcript: z.string() }).parse(module.exports);
  const view = ThreadView.parse(JSON.parse(exported.transcript));
  expect(view.thread.title).toBe("Soak: relay replay under load");
  expect(
    Object.values(view.items).some(
      (item) =>
        item.type === "message" &&
        item.parts.some(
          (part) => part.type === "text" && part.text.includes("Run the relay suite again"),
        ),
    ),
  ).toBe(true);
});
