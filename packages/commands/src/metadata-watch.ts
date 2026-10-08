import { watch } from "node:fs";
import { join } from "node:path";
import type { ProviderInstance } from "./catalog.ts";
/** Watch metadata filenames, never read their contents. Definition watches remain with CommandFiles. */
export function watchCatalogMetadata(
  instance: ProviderInstance | undefined,
  workspace: string,
  changed: () => void,
): () => void {
  if (!instance) return () => {};
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const paths = [
    instance.home,
    join(instance.home, "plugins"),
    workspace,
    join(workspace, `.${instance.provider}`),
  ];
  const names = new Set([
    `.${instance.provider}`,
    "plugins",
    "installed_plugins.json",
    "settings.json",
    "settings.local.json",
    "config.toml",
  ]);
  let closed = false;
  const bind = () => {
    if (closed) return;
    for (const path of paths) {
      if (watchers.has(path)) continue;
      try {
        const watcher = watch(path, (_event, filename) => {
          if (filename === null || names.has(String(filename))) {
            bind();
            changed();
          }
        });
        watcher.unref();
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(path);
          changed();
        });
        watchers.set(path, watcher);
      } catch {
        /* The parent watch discovers a missing metadata directory when it is created. */
      }
    }
  };
  bind();
  return () => {
    closed = true;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
