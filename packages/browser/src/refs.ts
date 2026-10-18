import { frameOffset, type BrowserFrameSession } from "./frame-coordinates.ts";
import { staleRef, BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { AXTree, Bounds, CallResult, ResolvedNode } from "./cdp.ts";
import { compactTree, type CompactNode } from "./snapshot-compact.ts";
import { snapshotLine } from "./snapshot-text.ts";
import { z } from "zod";
import { withoutSubtree } from "./snapshot-exclusion.ts";

/** About 1.5k tokens: a default snapshot stays cheaper than a 1536 px screenshot. */
export const defaultSnapshotNodes = 120;
/** About 12k tokens: the most one snapshot returns, whatever maxNodes says. */
const maxSnapshotBytes = 48 * 1024;
interface RefTarget {
  backendNodeId: number;
  cdp: BrowserCdp;
  frameId?: string;
}
export interface SnapshotOptions {
  /** A ref from the latest snapshot: return only that element's subtree. */
  scope?: string;
  interactiveOnly?: boolean;
  maxNodes?: number;
  /** Keep only matching nodes (find); the budget counts matches only. */
  match?: (node: CompactNode) => boolean;
}
export interface SnapshotResult {
  nodes: CompactNode[];
  /** Matching nodes on the page, including those the budget left out. */
  total: number;
  truncated: boolean;
}

/** One generation and one bounded snapshot; navigation cannot alias an old ref. */
export class SnapshotRefs {
  private epoch = 0;
  private refs = new Map<string, RefTarget>();
  /** Short, document-stable names for child frames, so refs stay a few characters long. */
  private frameAliases = new Map<string, string>();
  /** Every frame's session; returns undefined when the page has no frame list (one session). */
  private frames:
    | (() => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> | undefined)
    | undefined;
  private cdp: BrowserCdp;
  private frameSessions = new Map<string, BrowserFrameSession>();
  /** DOM node whose subtree snapshots omit: ace's annotate overlay in the top document. */
  private excluded: () => Promise<number | undefined>;
  constructor(
    cdp: BrowserCdp,
    frames?: () => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> | undefined,
    excluded: () => Promise<number | undefined> = async () => undefined,
  ) {
    this.frames = frames;
    this.cdp = cdp;
    this.excluded = excluded;
  }
  replace(cdp: BrowserCdp): void {
    this.cdp = cdp;
    this.invalidate();
  }
  invalidate(): void {
    this.epoch++;
    this.refs.clear();
    this.frameAliases.clear();
  }
  /** Bounded, compact snapshot of every frame; it replaces the actionable ref set. */
  async snapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.collect(options);
      } catch (error) {
        if (!(error instanceof BrowserActionError && error.code === "stale_ref") || attempt >= 4)
          throw error;
      }
    }
  }
  private alias(frame: { frameId?: string | undefined; parentId?: string | undefined }): string {
    if (!frame.frameId || !frame.parentId) return "";
    let alias = this.frameAliases.get(frame.frameId);
    if (!alias) {
      alias = `f${this.frameAliases.size + 1}:`;
      this.frameAliases.set(frame.frameId, alias);
    }
    return alias;
  }
  private async collect(options: SnapshotOptions): Promise<SnapshotResult> {
    const epoch = this.epoch;
    const scope = options.scope === undefined ? undefined : this.refs.get(options.scope);
    if (options.scope !== undefined && !scope) throw staleRef();
    const listed = this.frames?.();
    const frames: { frameId?: string; cdp: BrowserCdp; parentId?: string }[] = listed
      ? await listed
      : [{ cdp: this.cdp }];
    this.frameSessions = new Map(
      frames
        .filter((frame): frame is BrowserFrameSession => frame.frameId !== undefined)
        .map((frame) => [frame.frameId, frame]),
    );
    let domNodes = 0;
    for (const cdp of new Set(frames.map((frame) => frame.cdp))) {
      domNodes += z
        .object({ nodes: z.number() })
        .parse(await cdp.send("Memory.getDOMCounters")).nodes;
      if (domNodes > 20000) throw new Error("Browser document exceeds snapshot node limit");
    }
    const limit = options.maxNodes ?? defaultSnapshotNodes;
    const nodes: CompactNode[] = [];
    const refs = new Map<string, RefTarget>();
    let total = 0,
      bytes = 0;
    const excluded = await this.excluded();
    for (const frame of frames) {
      const raw = AXTree.parse(
        await frame.cdp
          .send("Accessibility.getFullAXTree", frame.frameId ? { frameId: frame.frameId } : {})
          .catch((error: unknown) => {
            // Frame process swaps can detach an AX target between discovery and this read.
            if (
              error instanceof Error &&
              /Frame with the given frameId is not found|Browser target command failed/.test(
                error.message,
              )
            )
              throw staleRef();
            throw error;
          }),
      );
      // ace's annotate overlay lives in the top document only.
      const tree = frame.parentId ? raw : withoutSubtree(raw, excluded);
      const prefix = this.alias(frame);
      const refOf = (backendNodeId: number) => `${prefix}e${epoch}-${backendNodeId}`;
      const target = (backendNodeId: number): RefTarget => ({
        backendNodeId,
        cdp: frame.cdp,
        ...(frame.frameId ? { frameId: frame.frameId } : {}),
      });
      // Every DOM-backed node stays actionable, including ones the budget leaves out.
      for (const node of tree.nodes)
        if (node.backendDOMNodeId)
          refs.set(refOf(node.backendDOMNodeId), target(node.backendDOMNodeId));
      if (scope && (scope.cdp !== frame.cdp || scope.frameId !== frame.frameId)) continue;
      const compact = compactTree(tree.nodes, {
        refOf,
        ...(scope ? { scope: scope.backendNodeId } : {}),
        ...(options.interactiveOnly ? { interactiveOnly: true } : {}),
        ...(prefix && frame.frameId ? { frameId: frame.frameId } : {}),
      });
      if (!compact) throw staleRef();
      for (const node of compact) {
        if (options.match && !options.match(node)) continue;
        total++;
        if (nodes.length >= limit) continue;
        bytes += snapshotLine(node).length + 1;
        if (bytes > maxSnapshotBytes) {
          bytes = Number.POSITIVE_INFINITY;
          continue;
        }
        nodes.push(node);
      }
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = refs;
    return { nodes, total, truncated: nodes.length < total };
  }

  documentGuard(): () => void {
    const epoch = this.epoch;
    return () => {
      if (this.epoch !== epoch) throw staleRef();
    };
  }
  guard(ref: string): () => void {
    const epoch = this.epoch;
    const node = this.refs.get(ref);
    if (node === undefined) throw staleRef();
    return () => {
      if (epoch !== this.epoch || this.refs.get(ref) !== node) throw staleRef();
    };
  }
  dispatch(ref: string, prepare: () => void) {
    const document = this.guard(ref);
    return {
      prepare,
      send: () => {
        prepare();
        document();
      },
    };
  }
  private async call(
    ref: string,
    functionDeclaration: string,
    beforeDispatch: () => void = () => {},
    args: unknown[] = [],
  ): Promise<unknown> {
    const target = this.refs.get(ref);
    if (target === undefined) throw staleRef();
    const { backendNodeId, cdp } = target;
    const epoch = this.epoch;
    const { object } = ResolvedNode.parse(await cdp.send("DOM.resolveNode", { backendNodeId }));
    let result: unknown;
    try {
      if (epoch !== this.epoch) throw staleRef();
      beforeDispatch();
      const response = CallResult.parse(
        await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration,
          returnByValue: true,
          arguments: args.map((value) => ({ value })),
        }),
      );
      if (epoch !== this.epoch) throw staleRef();
      if (response.exceptionDetails) throw new BrowserActionError("element_unavailable");
      result = response.result.value;
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
    if (epoch !== this.epoch) throw staleRef();
    beforeDispatch();
    return result;
  }
  async bounds(ref: string, beforeDispatch: () => void) {
    const rect = Bounds.parse(
      await this.call(
        ref,
        `function() {
      if (!this.isConnected) throw new Error('detached');
      this.scrollIntoView({block:'center', inline:'center'});
      const r = this.getBoundingClientRect();
      return {x:r.x, y:r.y, width:r.width, height:r.height};
    }`,
        beforeDispatch,
      ),
    );
    const target = this.refs.get(ref);
    if (!target?.frameId) return rect;
    const guard = this.guard(ref);
    const offset = await frameOffset(target.frameId, this.frameSessions, () => {
      beforeDispatch();
      guard();
    });
    return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
  }
  async upload(ref: string, files: string[], beforeDispatch: () => void): Promise<void> {
    const target = this.refs.get(ref);
    if (!target) throw staleRef();
    const guard = this.guard(ref);
    await this.call(
      ref,
      `function(){if (!this.isConnected || this.tagName !== 'INPUT' || this.type !== 'file') throw new Error('file input required');}`,
      beforeDispatch,
    );
    beforeDispatch();
    guard();
    await target.cdp.send("DOM.setFileInputFiles", { backendNodeId: target.backendNodeId, files });
    beforeDispatch();
    guard();
  }
  async choose(ref: string, values: string[], beforeDispatch: () => void): Promise<void> {
    await this.call(
      ref,
      `function(values){
      if (!this.isConnected || this.tagName !== 'SELECT' || this.disabled) throw new Error('select required');
      if (!this.multiple && values.length !== 1) throw new Error('single select');
      for (const value of values) if (![...this.options].some(o => o.value === value && !o.disabled)) throw new Error('option missing');
      for (const option of this.options) option.selected = values.includes(option.value);
      this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
    }`,
      beforeDispatch,
      [values],
    );
  }
  async checked(ref: string, beforeDispatch: () => void): Promise<boolean> {
    return z.boolean().parse(
      await this.call(
        ref,
        `function(){
      if (!this.isConnected || this.disabled || this.tagName !== 'INPUT' || !['checkbox','radio'].includes(this.type)) throw new Error('checkbox required');
      return this.checked;
    }`,
        beforeDispatch,
      ),
    );
  }
  async focus(ref: string, beforeDispatch: () => void): Promise<void> {
    await this.call(
      ref,
      `function() {
      if (!this.isConnected) throw new Error('detached');
      this.focus();
    }`,
      beforeDispatch,
    );
  }
  async select(ref: string, beforeDispatch: () => void): Promise<void> {
    await this.call(
      ref,
      `function() {
      if (!this.isConnected) throw new Error('detached');
      if (this.disabled || this.readOnly) throw new Error('not editable');
      this.focus();
      if (typeof this.select === 'function') this.select();
      else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      else throw new Error('not editable');
    }`,
      beforeDispatch,
    );
  }
  async visible(ref: string): Promise<boolean> {
    return z.boolean().parse(
      await this.call(
        ref,
        `function() {
          const rect = this.getBoundingClientRect();
          return this.isConnected && rect.width > 0 && rect.height > 0 && getComputedStyle(this).visibility !== 'hidden';
        }`,
      ),
    );
  }
}
