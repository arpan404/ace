import { build, type PluginBuild } from "esbuild";
import { runtimePackages, stageRuntimePackages } from "./runtime-assets.ts";
import { stagePtyRuntime } from "./pty-assets.ts";
import {
  guardianBundlePath,
  guardianSourcePath,
  stageTerminalGuardian,
} from "./terminal-assets.ts";
import { readFile, cp } from "node:fs/promises";
import { join } from "node:path";
export { stageNativeFiles } from "./native-assets.ts";
export async function bundleDaemon(
  repo: string,
  root: string,
  publicKey: string,
  target = `${process.platform}-${process.arch}`,
  daemonEntry = join(repo, "tools/release/src/entry.ts"),
) {
  const options = {
    bundle: true,
    minify: true,
    metafile: true,
    platform: "node" as const,
    target: "node24",
    mainFields: ["module", "main"],
    format: "esm" as const,
    external: ["node-pty", ...runtimePackages.map((pkg) => pkg.name)],
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
              filter:
                /(?:blob-export|exclusive-rename|host|worker-runtime|worker|worker-client|index|recording|runtime|storage|worker-sink|threads|sqlite|diagnostics-cli|descriptor|node-search|injection|history-publisher|fork|pty)\.ts$/,
            },
            async (args) => {
              let contents = await readFile(args.path, "utf8");
              for (const [source, worker, output] of [
                ["/files/src/blob-export.ts", "./blob-worker.ts", "./files-blob-worker.mjs"],
                [
                  "/files/src/exclusive-rename.ts",
                  "./rename-worker.ts",
                  "./files-rename-worker.mjs",
                ],
                ["/search/src/worker-runtime.ts", "./query-worker.ts", "./search-query-worker.mjs"],
              ]) {
                if (source && worker && output && args.path.endsWith(source))
                  contents = contents.replace(JSON.stringify(worker), JSON.stringify(output));
              }
              if (args.path.endsWith("/mcp-server/src/injection.ts"))
                contents = contents.replace('"./stdio-entry.ts"', '"./acp-mcp-bridge.mjs"');
              if (args.path.endsWith("/daemon/src/history-publisher.ts"))
                contents = contents.replace(
                  '"./history-publish-worker.ts"',
                  '"./history-publish-worker.mjs"',
                );
              if (args.path.endsWith("/adapter-claude/src/fork.ts"))
                contents = contents.replace('"./fork-worker.ts"', '"./claude-fork-worker.mjs"');
              if (args.path.endsWith("/adapter-cursor/src/host.ts"))
                contents = contents.replace('"./host-entry.ts"', '"./cursor-sdk-host.mjs"');
              if (args.path.endsWith("/workspace/src/descriptor.ts"))
                contents = contents.replace('"../dist/descriptor.node"', '"./descriptor.node"');
              if (args.path.endsWith("/terminal/src/pty.ts"))
                contents = contents.replace(guardianSourcePath, guardianBundlePath);
              if (args.path.endsWith("/workspace/src/node-search.ts"))
                contents = contents.replace(
                  '"./node-search-worker.ts"',
                  '"./workspace-search-worker.mjs"',
                );
              if (args.path.endsWith("/notify/src/worker.ts"))
                contents = contents.replace('"./worker-entry.ts"', '"./notification-worker.mjs"');
              if (args.path.endsWith("/usage/src/worker.ts"))
                contents = contents.replace('"./worker-entry.ts"', '"./usage-worker.mjs"');
              if (args.path.endsWith("/review/src/worker-client.ts"))
                contents = contents.replace('"./worker.ts"', '"./review-worker.mjs"');
              if (args.path.endsWith("/history-import/src/index.ts"))
                contents = contents.replace('"./worker.ts"', '"./history-import-worker.mjs"');
              if (args.path.endsWith("/browser/src/recording.ts"))
                contents = contents.replace(
                  '"./encoder-process.ts"',
                  '"./browser-encoder-process.mjs"',
                );
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
    entryPoints: [daemonEntry],
    outfile: join(root, "ace.mjs"),
  });
  if (!daemon.metafile) throw new Error("Bundle metadata is required");
  const inputs = new Set(Object.keys(daemon.metafile.inputs));
  const runtimeManifests = await stageRuntimePackages(repo, root, target);
  for (const manifest of runtimeManifests) inputs.add(manifest);
  inputs.add(await stagePtyRuntime(repo, root, target));
  const workspaceIncluded = [...inputs].some((input) =>
    input.endsWith("packages/workspace/src/descriptor.ts"),
  );
  if (workspaceIncluded)
    await cp(join(repo, "packages/workspace/dist/descriptor.node"), join(root, "descriptor.node"));
  if ([...inputs].some((input) => input.endsWith("packages/terminal/src/pty.ts")))
    stageTerminalGuardian(repo, root, target);
  const helpers = [
    ["packages/adapter-claude/src/fork-worker.ts", "claude-fork-worker.mjs"],
    ["apps/daemon/src/history-publish-worker.ts", "history-publish-worker.mjs"],
    ["packages/adapter-cursor/src/host-entry.ts", "cursor-sdk-host.mjs"],
    ["packages/mcp-server/src/stdio-entry.ts", "acp-mcp-bridge.mjs"],
    ["packages/files/src/blob-worker.ts", "files-blob-worker.mjs"],
    ["packages/files/src/rename-worker.ts", "files-rename-worker.mjs"],
    ["packages/search/src/query-worker.ts", "search-query-worker.mjs"],
    ["packages/usage/src/worker-entry.ts", "usage-worker.mjs"],
    ["packages/review/src/worker.ts", "review-worker.mjs"],
    ["packages/history-import/src/worker.ts", "history-import-worker.mjs"],
    ["packages/browser/src/encoder-process.ts", "browser-encoder-process.mjs"],
    ["packages/notify/src/worker-entry.ts", "notification-worker.mjs"],
    ["packages/models/src/storage-worker.ts", "model-storage-worker.mjs"],
    ["packages/diagnostics/src/log-worker.ts", "diagnostics-log-worker.mjs"],
    ["packages/diagnostics/src/thread-worker.ts", "diagnostics-thread-worker.mjs"],
    ["packages/diagnostics/src/sqlite-process.ts", "diagnostics-sqlite-process.mjs"],
  ];
  if (workspaceIncluded)
    helpers.push(["packages/workspace/src/node-search-worker.ts", "workspace-search-worker.mjs"]);
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
