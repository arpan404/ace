import { basename, join, relative } from "node:path";
import type { Plugin } from "vite";
import { initialChunk } from "./initial-preloads.ts";
import { pieceModule } from "./protocol-pieces.ts";

const entries = ["client-worker", "machine-worker"].map((name) =>
  join(import.meta.dirname, `src/boot/${name}.ts`),
);

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

/** Rendered bytes per source module, a split protocol module's pieces counted as one. */
function moduleBytes(modules: Record<string, { renderedLength: number }>) {
  const bytes = new Map<string, number>();
  for (const [id, module] of Object.entries(modules)) {
    if (!module.renderedLength) continue;
    const source = relative(import.meta.dirname, pieceModule(id));
    bytes.set(source, (bytes.get(source) ?? 0) + module.renderedLength);
  }
  return [...bytes].map(([id, size]) => ({ id, bytes: size }));
}

/** Guard the actual worker graph; optionally emit Rolldown's retained-module breakdown. */
export function workerBundle(): Plugin {
  let entry: string | undefined;
  return {
    name: "ace:worker-bundle",
    options(options) {
      const inputs =
        typeof options.input === "string"
          ? [options.input]
          : Array.isArray(options.input)
            ? options.input
            : Object.values(options.input ?? {});
      entry = entries.find((candidate) => inputs.includes(candidate));
    },
    outputOptions(options) {
      if (!entry) return;
      return {
        ...options,
        codeSplitting: {
          groups: [
            {
              ...initialChunk(entry),
              debugName: "client-core",
              priority: 10,
              // Workers have one entry each; keep it with its static dependencies so a
              // tiny bootstrap does not add another gzip stream and import wrapper.
              name: "client-core",
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
      if (!entry) return;
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
          if (forbiddenEagerWorkerModules.some((suffix) => pieceModule(id).endsWith(suffix)))
            this.error(
              `Forbidden eager client worker module: ${relative(import.meta.dirname, pieceModule(id))} (${file})`,
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
                modules: moduleBytes(chunk.modules),
              },
            ]
          : [],
      );
      this.emitFile({
        type: "asset",
        fileName: `${basename(entry, ".ts")}-bundle.json`,
        source: JSON.stringify(chunks),
      });
    },
  };
}
