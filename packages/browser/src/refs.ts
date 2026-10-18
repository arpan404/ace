import { frameOffset, type BrowserFrameSession } from "./frame-coordinates.ts";
import { staleRef, BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { AXTree, Bounds, CallResult, ResolvedNode } from "./cdp.ts";
import { z } from "zod";
import { withoutSubtree } from "./snapshot-exclusion.ts";
import {
  defaultSnapshotDepth,
  limitDepth,
  outlineDomNodes,
  outlineHint,
  outlineRoles,
} from "./snapshot-scope.ts";
import { SnapshotOutput, type SnapshotFrame, type SnapshotTarget } from "./snapshot-output.ts";

const DocumentRoot = z.object({ root: z.object({ backendNodeId: z.number().int() }) });
/** Frame process swaps can detach an AX target between discovery and this read. */
function staleFrame(error: unknown): never {
  if (
    error instanceof Error &&
    /Frame with the given frameId is not found|Browser target command failed|No node with given id/.test(
      error.message,
    )
  )
    throw staleRef();
  throw error;
}

/** One generation and one bounded snapshot; navigation cannot alias an old ref. */
export class SnapshotRefs {
  private epoch = 0;
  /** Reopened since the last full snapshot (`restarted`). */
  private reopened = false;
  private refs = new Map<string, SnapshotTarget>();
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
  }
  /**
   * The page was reopened after its renderer, its browser or the daemon restarted. Refs from
   * before fail with `browser_restarted` until the next full snapshot, so the agent learns why
   * its page state is gone.
   */
  restarted(): void {
    this.invalidate();
    this.reopened = true;
  }
  /** A ref that is not in the latest snapshot. */
  private unknownRef(): BrowserActionError {
    return this.reopened ? new BrowserActionError("browser_restarted") : staleRef();
  }
  /**
   * The accessibility tree of the tab's frames, or with `ref` of that element's subtree only.
   * A full snapshot replaces the actionable refs; a scoped one adds its subtree's refs to them.
   * Large pages degrade instead of failing: output is truncated with a hint, and a page over
   * `outlineDomNodes` lists only its landmarks and headings.
   */
  async snapshot(options: { ref?: string | undefined; depth?: number | undefined } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return options.ref === undefined
          ? await this.collect(options.depth)
          : await this.scoped(options.ref, options.depth);
      } catch (error) {
        if (!(error instanceof BrowserActionError && error.code === "stale_ref") || attempt >= 4)
          throw error;
        // A scoped snapshot's ref went stale: retrying cannot bring it back.
        if (options.ref !== undefined) throw error;
      }
    }
  }
  private async listFrames(): Promise<SnapshotFrame[]> {
    const listed = this.frames?.();
    const frames: SnapshotFrame[] = listed ? await listed : [{ cdp: this.cdp }];
    this.frameSessions = new Map(
      frames
        .filter((frame): frame is BrowserFrameSession => frame.frameId !== undefined)
        .map((frame) => [frame.frameId, frame]),
    );
    return frames;
  }
  private async collect(depth = defaultSnapshotDepth) {
    const epoch = this.epoch;
    const frames = await this.listFrames();
    let domNodes = 0;
    for (const cdp of new Set(frames.map((frame) => frame.cdp)))
      domNodes += z
        .object({ nodes: z.number() })
        .parse(await cdp.send("Memory.getDOMCounters")).nodes;
    if (domNodes > outlineDomNodes) return this.outline(frames, epoch, domNodes);
    const output = new SnapshotOutput(epoch);
    const excluded = await this.excluded();
    for (const frame of frames) {
      const raw = AXTree.parse(
        await frame.cdp
          .send("Accessibility.getFullAXTree", {
            depth,
            ...(frame.frameId ? { frameId: frame.frameId } : {}),
          })
          .catch(staleFrame),
      );
      const tree = frame.parentId ? raw : withoutSubtree(raw, excluded);
      if (!output.add(tree, frame)) break;
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = output.refs;
    this.reopened = false;
    return output.result(domNodes);
  }
  /** A page too large to read whole: its top document's landmarks and headings. */
  private async outline(frames: SnapshotFrame[], epoch: number, domNodes: number) {
    const top = frames.find((frame) => !frame.parentId) ?? { cdp: this.cdp };
    const document = DocumentRoot.parse(await top.cdp.send("DOM.getDocument", { depth: 0 }));
    const excluded = await this.excluded();
    const output = new SnapshotOutput(epoch);
    for (const role of outlineRoles) {
      const raw = AXTree.parse(
        await top.cdp.send("Accessibility.queryAXTree", {
          backendNodeId: document.root.backendNodeId,
          role,
        }),
      );
      // Parsed for this snapshot alone: an outline lists nodes without their children.
      const nodes = raw.nodes.filter((node) => node.backendDOMNodeId !== excluded);
      for (const node of nodes) node.childIds = [];
      if (!output.add({ nodes }, top)) break;
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = output.refs;
    this.reopened = false;
    return { ...output.result(domNodes), truncated: true, hint: outlineHint };
  }
  /** One element's subtree, `depth` levels deep; its refs join the latest snapshot's. */
  private async scoped(ref: string, depth = defaultSnapshotDepth) {
    const epoch = this.epoch;
    const target = this.refs.get(ref);
    if (target === undefined) throw this.unknownRef();
    const raw = AXTree.parse(
      await target.cdp
        .send("Accessibility.queryAXTree", { backendNodeId: target.backendNodeId })
        .catch(staleFrame),
    );
    // ace's overlay lives only in the top document.
    const child = target.frameId && this.frameSessions.get(target.frameId)?.parentId;
    const tree = limitDepth(child ? raw : withoutSubtree(raw, await this.excluded()), depth);
    const output = new SnapshotOutput(epoch);
    output.add(tree, target);
    if (epoch !== this.epoch) throw staleRef();
    for (const [key, value] of output.refs) this.refs.set(key, value);
    return output.result();
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
    if (node === undefined) throw this.unknownRef();
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
    if (target === undefined) throw this.unknownRef();
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
    if (!target) throw this.unknownRef();
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
