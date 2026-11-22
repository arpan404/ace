import type { SettingsService } from "@ace/settings";
import { ThreadId, type WorkspaceId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { parseSilenceMs } from "../engine/silence.ts";

const key = "threads.unresponsiveAfter";

export interface SilenceEngine {
  setSilenceMs(silenceMs: number, threadId?: ThreadId): void;
  clearWorkspaceSilenceMs(workspaceId?: WorkspaceId): void;
  liveThreadIds(): ThreadId[];
}

export async function readSilenceMs(
  store: Pick<Store, "getThread" | "getWorkspacePath">,
  settings: Pick<SettingsService, "get">,
  scope: { threadId?: ThreadId; workspaceId?: WorkspaceId },
): Promise<number> {
  const workspaceId =
    scope.workspaceId ??
    (scope.threadId ? store.getThread(scope.threadId)?.workspaceId : undefined);
  const workspace = workspaceId ? store.getWorkspacePath(workspaceId) : undefined;
  const query = {
    ...(scope.threadId ? { thread: scope.threadId } : {}),
    ...(workspace ? { workspace } : {}),
  };
  try {
    return parseSilenceMs((await settings.get(key, query)).value);
  } catch (error) {
    // Deleted worktree: fall back to the remaining settings layers.
    if (!(workspace && error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return parseSilenceMs(
      (await settings.get(key, scope.threadId ? { thread: scope.threadId } : {})).value,
    );
  }
}

/**
 * Keeps the engine's silence thresholds in sync with `threads.unresponsiveAfter` across global,
 * workspace and thread settings layers and external settings-file edits.
 */
export async function watchSilenceSetting(deps: {
  store: Pick<Store, "getThread" | "getWorkspacePath">;
  settings: Pick<SettingsService, "get" | "onChange" | "subscribe">;
  engine: SilenceEngine;
  report?: (error: unknown) => void;
}): Promise<() => void> {
  const { store, settings, engine, report } = deps;
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (run: () => Promise<void>) => {
    pending = pending.then(
      async () => {
        if (stopped) return;
        try {
          await run();
        } catch (error) {
          report?.(error);
        }
      },
      () => {},
    );
  };
  const refreshGlobal = async () => {
    const globalMs = await readSilenceMs(store, settings, {});
    if (stopped) return;
    engine.setSilenceMs(globalMs);
    for (const id of engine.liveThreadIds()) {
      const ms = await readSilenceMs(store, settings, { threadId: id });
      if (stopped) return;
      engine.setSilenceMs(ms, id);
    }
  };
  const stopChange = settings.onChange((layer, keys) => {
    if (!keys.includes(key)) return;
    if (layer.kind === "global") {
      enqueue(refreshGlobal);
    } else if (layer.kind === "workspace") {
      enqueue(async () => {
        engine.clearWorkspaceSilenceMs();
        for (const id of engine.liveThreadIds()) {
          const thread = store.getThread(id);
          if (!thread || store.getWorkspacePath(thread.workspaceId) !== layer.workspace) continue;
          const ms = await readSilenceMs(store, settings, { threadId: id });
          if (stopped) return;
          engine.setSilenceMs(ms, id);
        }
      });
    } else {
      const parsed = ThreadId.safeParse(layer.thread);
      if (!parsed.success) return;
      enqueue(async () => {
        const ms = await readSilenceMs(store, settings, { threadId: parsed.data });
        if (stopped) return;
        engine.setSilenceMs(ms, parsed.data);
      });
    }
  });
  const stopSubscribe = await settings.subscribe({ keys: [key], scope: {} }, (event) => {
    if (event.type === "changed") enqueue(refreshGlobal);
  });
  return () => {
    stopped = true;
    stopChange();
    stopSubscribe();
  };
}
