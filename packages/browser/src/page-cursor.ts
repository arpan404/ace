import { z } from "zod";
import {
  cursorApplyExpression,
  cursorHostExpression,
  cursorInstallExpression,
  cursorSettledExpression,
  cursorTeardownExpression,
  cursorWorldName,
  type CursorOp,
  type CursorPoint,
  type CursorRect,
  type CursorStyle,
} from "@ace/browser-annotate";
import type { BrowserCdp } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";

const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number().int() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }),
  exceptionDetails: z.unknown().optional(),
});
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });
const Described = z.object({ node: z.object({ backendNodeId: z.number().int() }) });

export interface PageCursorOptions {
  /** Draw agents' cursors. Captures mask secret fields either way. */
  visible: boolean;
  /** How long the cursor glides to a point; agent input waits as long so the glide lands. */
  glideMs: number;
  /** An agent's cursor leaves this long after it last acted. */
  inUseMs: number;
  /** The person counts as acting for this long after their last input; cursors stay hidden. */
  quietMs: number;
  clock: NavigationClock;
  style(): CursorStyle;
  /** The agent's name for its label; omitted, "Agent" (numbered when several are unnamed). */
  name(agentId: string | undefined): string | undefined;
}

interface Installed {
  cdp: BrowserCdp;
  contextId: number;
  host?: number | undefined;
  detach(): void;
}

interface Agent {
  name: string;
  at: CursorPoint;
  cancel(): void;
}

async function evaluate(
  cdp: BrowserCdp,
  contextId: number,
  expression: string,
  options: { awaitPromise?: boolean; byValue?: boolean } = {},
) {
  const evaluated = Evaluated.parse(
    await cdp.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: options.byValue ?? true,
      awaitPromise: options.awaitPromise ?? false,
      silent: true,
    }),
  );
  if (evaluated.exceptionDetails) throw new Error("The page's agent cursor failed");
  return evaluated.result;
}

/**
 * One tab's agent cursor layer, drawn in the page (ADR 0082, agent cursor), so every engine shows
 * it: the desktop's native view, ace's Chrome and Use my Chrome. The daemon keeps the state and
 * replays it whenever the page's layer is new (a navigation, a renderer restart, a replaced
 * page). The same layer hides itself and masks secret fields while the page is captured for an
 * agent or recorded. Every call is best effort: a cursor never fails the work it illustrates.
 */
export class PageCursor {
  private installed: Installed | undefined;
  private installing: Promise<Installed> | undefined;
  private agents = new Map<string, Agent>();
  private captures = 0;
  private recording = false;
  private person = false;
  private stopPerson: (() => void) | undefined;
  /** A private tab: agents are kept out, so nothing of theirs is drawn. */
  private kept = false;
  private closed = false;
  private readonly cdp: () => BrowserCdp;
  private readonly options: PageCursorOptions;
  constructor(cdp: () => BrowserCdp, options: PageCursorOptions) {
    this.cdp = cdp;
    this.options = options;
  }

  /** Whether agents' cursors are drawn at all (captures are masked either way). */
  get visible(): boolean {
    return this.options.visible;
  }

  private get hidden(): boolean {
    return this.person || this.captures > 0 || this.recording;
  }

  private label(agentId: string | undefined): string {
    const named = this.options.name(agentId);
    if (named) return named.slice(0, 64);
    const key = agentId ?? "";
    const unnamed = [...this.agents.keys()].filter(
      (other) => other !== key && !this.options.name(other || undefined),
    ).length;
    return unnamed ? `Agent ${unnamed + 1}` : "Agent";
  }

  /** Everything a fresh layer needs to show what the old one showed. */
  private replay(): CursorOp[] {
    return [
      { op: "style", style: this.options.style() },
      { op: "person", active: this.person },
      { op: "capture", hidden: this.captures > 0 || this.recording, mask: this.hiddenForAgents },
      ...[...this.agents].map(([id, agent]): CursorOp => ({
        op: "agent",
        id,
        name: agent.name,
        at: agent.at,
        glide: false,
      })),
    ];
  }

  private get hiddenForAgents(): boolean {
    return this.captures > 0 || this.recording;
  }

  private drop(): void {
    this.installed?.detach();
    this.installed = undefined;
    this.installing = undefined;
  }

  private install(): Promise<Installed> {
    if (this.installed) return Promise.resolve(this.installed);
    this.installing ??= (async () => {
      const cdp = this.cdp();
      const navigated = (raw: unknown) => {
        const frame = Navigated.safeParse(raw);
        if (frame.success && !frame.data.frame.parentId) this.navigated();
      };
      const frameId = FrameTree.parse(await cdp.send("Page.getFrameTree")).frameTree.frame.id;
      const contextId = World.parse(
        await cdp.send("Page.createIsolatedWorld", {
          frameId,
          worldName: cursorWorldName,
          grantUniveralAccess: false,
        }),
      ).executionContextId;
      await evaluate(
        cdp,
        contextId,
        cursorInstallExpression(this.options.style(), this.options.glideMs),
      );
      cdp.on("Page.frameNavigated", navigated);
      const installed: Installed = {
        cdp,
        contextId,
        detach: () => cdp.off("Page.frameNavigated", navigated),
      };
      await evaluate(cdp, contextId, cursorApplyExpression(this.replay()));
      this.installed = installed;
      return installed;
    })();
    const pending = this.installing;
    pending.catch(() => {
      if (this.installing === pending) this.installing = undefined;
    });
    return pending;
  }

  /** Applies ops to the page's layer, installing it first; true when they landed. */
  private async send(ops: CursorOp[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed || this.kept) return false;
      try {
        const layer = await this.install();
        if (!ops.length) return true;
        await evaluate(layer.cdp, layer.contextId, cursorApplyExpression(ops));
        return true;
      } catch {
        // The document went away under the layer (a navigation that has not reported yet).
        this.drop();
      }
    }
    return false;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.options.clock.set(ms, resolve));
  }

  private remember(agentId: string | undefined, at: CursorPoint): string {
    const id = agentId ?? "";
    this.agents.get(id)?.cancel();
    const name = this.agents.get(id)?.name ?? this.label(agentId);
    const cancel = this.options.clock.set(this.options.inUseMs, () => {
      if (this.agents.get(id)?.cancel !== cancel) return;
      this.agents.delete(id);
      void this.send([{ op: "leave", id }]);
    });
    this.agents.set(id, { name, at, cancel });
    return id;
  }

  /**
   * The agent's cursor glides to `at`; resolves once it has landed, so the click that follows
   * happens under it. A hidden layer (the person acting, a capture) does not delay the agent.
   */
  async point(agentId: string | undefined, at: CursorPoint, click = false): Promise<void> {
    if (!this.options.visible || this.kept || this.closed) return;
    const id = this.remember(agentId, at);
    const agent = this.agents.get(id);
    if (!agent) return;
    const shown = await this.send([{ op: "agent", id, name: agent.name, at, glide: true }]);
    if (shown && !this.hidden && this.options.glideMs > 0) await this.wait(this.options.glideMs);
    if (click && shown) void this.send([{ op: "click", id }]);
  }

  /** A drag: the cursor lands on the start, then glides to the end along a dashed trail. */
  async drag(agentId: string | undefined, from: CursorPoint, to: CursorPoint): Promise<void> {
    if (!this.options.visible || this.kept || this.closed) return;
    await this.point(agentId, from);
    const id = this.remember(agentId, to);
    const name = this.agents.get(id)?.name ?? "Agent";
    void this.send([
      { op: "drag", id, from, to },
      { op: "agent", id, name, at: to, glide: true },
    ]);
  }

  /** Typing: the cursor moves to the field, which glows while text goes in. */
  async typing(agentId: string | undefined, field: CursorRect): Promise<void> {
    if (!this.options.visible || this.kept || this.closed) return;
    await this.point(agentId, {
      x: field.x + Math.min(field.width / 2, 24),
      y: field.y + field.height / 2,
    });
    void this.send([{ op: "type", id: agentId ?? "", field }]);
  }

  scroll(agentId: string | undefined, dx: number, dy: number): void {
    if (!this.options.visible || this.kept || this.closed) return;
    const id = agentId ?? "";
    if (!this.agents.has(id)) return;
    void this.send([{ op: "scroll", id, dx, dy }]);
  }

  /** The person used the page: cursors fade until they have paused for `quietMs`. */
  personActed(): void {
    if (!this.options.visible || this.closed) return;
    this.stopPerson?.();
    this.stopPerson = this.options.clock.set(this.options.quietMs, () => {
      this.stopPerson = undefined;
      this.person = false;
      if (this.installed) void this.send([{ op: "person", active: false }]);
    });
    if (this.person) return;
    this.person = true;
    if (this.installed) void this.send([{ op: "person", active: true }]);
  }

  /** The viewer's accent changed. */
  restyle(): void {
    if (this.installed) void this.send([{ op: "style", style: this.options.style() }]);
  }

  /**
   * Run a capture whose image goes to an agent (or into an artifact): cursors are hidden and
   * secret fields masked until it finishes. If the page cannot take the layer, the capture runs
   * anyway: a cursor or mask must never block a read.
   */
  async capture<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.kept) return work();
    this.captures++;
    try {
      if (await this.send([{ op: "capture", hidden: true, mask: true }])) await this.settle();
      return await work();
    } finally {
      this.captures--;
      if (!this.hiddenForAgents && this.installed)
        void this.send([{ op: "capture", hidden: false, mask: false }]);
    }
  }

  private async settle(): Promise<void> {
    const layer = this.installed;
    if (!layer) return;
    await evaluate(layer.cdp, layer.contextId, cursorSettledExpression, {
      awaitPromise: true,
    }).catch(() => {});
  }

  /** A recording runs: its frames show no cursor and no secret field. */
  async setRecording(on: boolean): Promise<void> {
    if (this.recording === on) return;
    this.recording = on;
    if (this.closed || this.kept) return;
    if (!on && !this.installed) return;
    if (
      await this.send([{ op: "capture", hidden: this.hiddenForAgents, mask: this.hiddenForAgents }])
    )
      if (on) await this.settle();
  }

  /** A private tab draws nothing of agents; letting agents back starts clean. */
  setPrivate(value: boolean): void {
    this.kept = value;
    if (!value) return;
    this.forgetAgents();
    void this.teardown();
  }

  private forgetAgents(): void {
    for (const agent of this.agents.values()) agent.cancel();
    this.agents.clear();
  }

  private async teardown(): Promise<void> {
    const layer = this.installed ?? (await this.installing?.catch(() => undefined));
    this.drop();
    if (layer) await evaluate(layer.cdp, layer.contextId, cursorTeardownExpression).catch(() => {});
  }

  /** A new document in the top frame: its layer is gone; bring it back if anything shows. */
  navigated(): void {
    this.drop();
    if (this.agents.size || this.recording) void this.send([]);
  }

  /** The renderer came back or the page was replaced: same as a new document. */
  rebind(): void {
    this.navigated();
  }

  /** Backend node of the layer's host in the top document, so agent snapshots can omit it. */
  async hostNode(): Promise<number | undefined> {
    const layer = this.installed;
    if (!layer) return undefined;
    if (layer.host !== undefined) return layer.host;
    const { objectId } = await evaluate(layer.cdp, layer.contextId, cursorHostExpression, {
      byValue: false,
    }).catch(() => ({ objectId: undefined }));
    if (!objectId) return undefined;
    try {
      const described = Described.safeParse(await layer.cdp.send("DOM.describeNode", { objectId }));
      if (!described.success) return undefined;
      layer.host = described.data.node.backendNodeId;
      return layer.host;
    } finally {
      await layer.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  close(): void {
    if (this.closed) return;
    this.forgetAgents();
    this.stopPerson?.();
    void this.teardown();
    this.closed = true;
  }
}
