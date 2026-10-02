import { build, type PluginBuild } from "esbuild";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export { stageNativeFiles } from "./native-assets.ts";
export async function bundleDaemon(repo: string, root: string, publicKey: string) {
  const options = {
    bundle: true,
    metafile: true,
    platform: "node" as const,
    target: "node24",
    mainFields: ["module", "main"],
    format: "esm" as const,
    external: ["node-pty"],
    legalComments: "eof" as const,
    banner: {
      js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "release-paths",
        setup(ctx: PluginBuild) {
          ctx.onLoad({ filter: /(?:worker|runtime|storage)\.ts$/ }, async (args) => {
            let contents = await readFile(args.path, "utf8");
            if (args.path.endsWith("/notify/src/worker.ts"))
              contents = contents.replace('"./worker-entry.ts"', '"./notification-worker.mjs"');
            if (args.path.endsWith("/models/src/storage.ts"))
              contents = contents.replace('"./storage-worker.ts"', '"./model-storage-worker.mjs"');
            if (args.path.endsWith("/release/src/runtime.ts"))
              contents = contents.replace(
                '"__ACE_RELEASE_PUBLIC_KEY__"',
                JSON.stringify(publicKey),
              );
            return { contents, loader: "ts" };
          });
        },
      },
    ],
  };
  const daemon = await build({
    ...options,
    entryPoints: [join(repo, "tools/release/src/entry.ts")],
    outfile: join(root, "ace.mjs"),
  });
  const worker = await build({
    ...options,
    entryPoints: [join(repo, "packages/notify/src/worker-entry.ts")],
    outfile: join(root, "notification-worker.mjs"),
  });
  const models = await build({
    ...options,
    entryPoints: [join(repo, "packages/models/src/storage-worker.ts")],
    outfile: join(root, "model-storage-worker.mjs"),
  });
  if (!daemon.metafile || !worker.metafile || !models.metafile)
    throw new Error("Bundle metadata is required");
  return [
    ...new Set([
      ...Object.keys(daemon.metafile.inputs),
      ...Object.keys(worker.metafile.inputs),
      ...Object.keys(models.metafile.inputs),
    ]),
  ];
}
