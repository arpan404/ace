import { join, relative } from "node:path";
import type { Plugin } from "vite";
import { initialChunk } from "./initial-preloads.ts";

const entry = join(import.meta.dirname, "src/boot/client-worker.ts");

/** Keep cold services and page-only implementations off the worker's startup path. */
export const forbiddenEagerWorkerModules = [
  "/packages/protocol/src/accounts.ts",
  "/packages/protocol/src/history.ts",
  "/packages/protocol/src/settings.ts",
  "/packages/protocol/src/long-thread.ts",
  "/packages/client/src/service-wire.ts",
  "/packages/client-worker/src/remote.ts",
  "/packages/client-worker/src/mirror.ts",
  "/zod/v4/mini/schemas.js",
];

/** Guard the actual worker graph; optionally emit Rolldown's retained-module breakdown. */
export function workerBundle(): Plugin {
  let clientWorker = false;
  return {
    name: "ace:worker-bundle",
    options(options) {
      const inputs =
        typeof options.input === "string"
          ? [options.input]
          : Array.isArray(options.input)
            ? options.input
            : Object.values(options.input ?? {});
      clientWorker = inputs.includes(entry);
    },
    outputOptions(options) {
      if (!clientWorker) return;
      return {
        ...options,
        codeSplitting: {
          groups: [
            {
              ...initialChunk(entry),
              debugName: "client-core",
              priority: 10,
              name: (id) => (id === entry ? null : "client-core"),
            },
            {
              debugName: "client-services",
              name: (id) => (id === entry ? null : "client-services"),
              test: () => true,
            },
          ],
        },
      };
    },
    generateBundle(_options, bundle) {
      const start = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.facadeModuleId === entry,
      );
      if (!start || start.type !== "chunk") return;
      const eager = new Set<string>();
      const visit = (file: string) => {
        const chunk = bundle[file];
        if (!chunk || chunk.type !== "chunk" || eager.has(file)) return;
        eager.add(file);
        for (const imported of chunk.imports) visit(imported);
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (!module.renderedLength) continue;
          if (forbiddenEagerWorkerModules.some((suffix) => id.endsWith(suffix)))
            this.error(
              `Forbidden eager client worker module: ${relative(import.meta.dirname, id)} (${file})`,
            );
        }
      };
      visit(start.fileName);
      if (process.env["ACE_WORKER_ANALYZE"] !== "1") return;
      const chunks = Object.values(bundle).flatMap((chunk) =>
        chunk.type === "chunk"
          ? [
              {
                file: chunk.fileName,
                eager: eager.has(chunk.fileName),
                imports: chunk.imports,
                dynamicImports: chunk.dynamicImports,
                modules: Object.entries(chunk.modules).flatMap(([id, module]) =>
                  module.renderedLength
                    ? [
                        {
                          id: relative(import.meta.dirname, id),
                          bytes: module.renderedLength,
                        },
                      ]
                    : [],
                ),
              },
            ]
          : [],
      );
      this.emitFile({
        type: "asset",
        fileName: "worker-bundle.json",
        source: JSON.stringify(chunks),
      });
    },
  };
}
