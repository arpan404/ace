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
          ctx.onLoad(
            {
              filter: /(?:worker|runtime|storage|worker-sink|threads|sqlite|diagnostics-cli)\.ts$/,
            },
            async (args) => {
              let contents = await readFile(args.path, "utf8");
              if (args.path.endsWith("/notify/src/worker.ts"))
                contents = contents.replace('"./worker-entry.ts"', '"./notification-worker.mjs"');
              if (args.path.endsWith("/models/src/storage.ts"))
                contents = contents.replace(
                  '"./storage-worker.ts"',
                  '"./model-storage-worker.mjs"',
                );
              if (args.path.endsWith("/diagnostics/src/worker-sink.ts"))
                contents = contents.replace('"./log-worker.ts"', '"./diagnostics-log-worker.mjs"');
              if (args.path.endsWith("/diagnostics/src/threads.ts"))
                contents = contents.replace(
                  '"./thread-worker.ts"',
                  '"./diagnostics-thread-worker.mjs"',
                );
              if (args.path.endsWith("/diagnostics/src/sqlite.ts"))
                contents = contents.replace(
                  '"./sqlite-process.ts"',
                  '"./diagnostics-sqlite-process.mjs"',
                );
              if (args.path.endsWith("/daemon/src/diagnostics-cli.ts"))
                contents = contents.replace('"./index.ts"', '"./ace.mjs"');
              if (args.path.endsWith("/release/src/runtime.ts"))
                contents = contents.replace(
                  '"__ACE_RELEASE_PUBLIC_KEY__"',
                  JSON.stringify(publicKey),
                );
              return { contents, loader: "ts" };
            },
          );
        },
      },
    ],
  };
  const daemon = await build({
    ...options,
    entryPoints: [join(repo, "tools/release/src/entry.ts")],
    outfile: join(root, "ace.mjs"),
  });
  if (!daemon.metafile) throw new Error("Bundle metadata is required");
  const inputs = new Set(Object.keys(daemon.metafile.inputs));
  const helpers = [
    ["packages/notify/src/worker-entry.ts", "notification-worker.mjs"],
    ["packages/models/src/storage-worker.ts", "model-storage-worker.mjs"],
    ["packages/diagnostics/src/log-worker.ts", "diagnostics-log-worker.mjs"],
    ["packages/diagnostics/src/thread-worker.ts", "diagnostics-thread-worker.mjs"],
    ["packages/diagnostics/src/sqlite-process.ts", "diagnostics-sqlite-process.mjs"],
  ];
  for (const [entry, output] of helpers) {
    if (!entry || !output) throw new Error("Invalid helper entry");
    const helper = await build({
      ...options,
      entryPoints: [join(repo, entry)],
      outfile: join(root, output),
    });
    if (!helper.metafile) throw new Error("Bundle metadata is required");
    for (const input of Object.keys(helper.metafile.inputs)) inputs.add(input);
  }
  return [...inputs];
}
