import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsService,
  fileIO,
  type FileIO,
  type Scheduler,
  type SettingsOptions,
} from "./index.ts";

export class ManualEdges {
  watchers = new Map<string, () => void>();
  tasks = new Set<() => void>();
  io: FileIO = {
    ...fileIO,
    watch: async (path, changed) => {
      this.watchers.set(path, changed);
      return () => {
        this.watchers.delete(path);
      };
    },
  };
  scheduler: Scheduler = {
    schedule: (callback) => {
      this.tasks.add(callback);
      return () => {
        this.tasks.delete(callback);
      };
    },
  };
  changed(path: string): void {
    this.watchers.get(path)?.();
  }
  flush(): void {
    const tasks = [...this.tasks];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}
export async function fixture(options: Partial<SettingsOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-settings-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "repo");
  await mkdir(dataDir);
  await mkdir(workspace);
  const edges = new ManualEdges();
  const service = new SettingsService({
    dataDir,
    io: edges.io,
    scheduler: edges.scheduler,
    ...options,
  });
  return {
    root,
    dataDir,
    workspace,
    service,
    edges,
    globalPath: join(dataDir, "settings.json"),
    async write(path: string, settings: Record<string, unknown>) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 2, settings }));
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
