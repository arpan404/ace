import { z } from "zod";
import type { KeyValueStorage } from "@ace/ui-core";
import { TabletPanelOp, TabletWorkspaces } from "@ace/ui-core/tablet-workspace";
import type { PatchSink } from "./agents.ts";

/*
 * The iPad's side panel beside a thread (`@ace/ui-core/tablet-workspace`): native sends what the
 * person did, this applies it with the shared rules and sends back the thread's panel to draw.
 * Each machine's runtime keeps its own threads' panels, saved in its own database.
 */

export const WorkspaceAction = z.object({
  type: z.literal("workspace"),
  /** The thread whose panel this is. */
  scope: z.string().min(1).max(512),
  /** Absent: only send the panel as it is (a thread opening). */
  op: z.unknown().optional(),
  /** The tools this build of the app can draw in the panel. */
  tools: z.array(z.string().min(1).max(64)).max(32),
});
export type WorkspaceAction = z.infer<typeof WorkspaceAction>;

const storageKey = "ace.tablet-workspace";

export class NativeWorkspace {
  readonly #pump: PatchSink;
  readonly #ready: Promise<TabletWorkspaces>;
  #tools = "";

  constructor(
    pump: PatchSink,
    native: { load(): Promise<string>; save(value: string): Promise<void> },
  ) {
    this.#pump = pump;
    this.#ready = native.load().then(
      (value) => new TabletWorkspaces({ storage: storage(value, native.save) }),
      () => new TabletWorkspaces({ storage: storage("", native.save) }),
    );
  }

  /** Apply one action in the order sent, then send the thread's panel. */
  handle(action: WorkspaceAction): Promise<void> {
    return this.#ready.then((panels) => {
      const tools = action.tools.join(",");
      if (tools !== this.#tools) {
        this.#tools = tools;
        panels.setAvailable(action.tools);
      }
      const op = action.op === undefined ? undefined : TabletPanelOp.safeParse(action.op);
      if (op?.success) panels.apply(action.scope, op.data);
      const view = panels.view(action.scope);
      this.#pump.put(`workspace:${action.scope}`, () => ({ type: "workspace", view }));
    });
  }
}

/** The saved value read once at start; each change saved whole, as the browser's devices are. */
function storage(initial: string, save: (value: string) => Promise<void>): KeyValueStorage {
  let value: string | null = initial || null;
  return {
    getItem: (name) => (name === storageKey ? value : null),
    setItem: (name, next) => {
      if (name !== storageKey) return;
      value = next;
      void save(next).catch(() => {});
    },
  };
}
