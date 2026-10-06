import { frameOffset, type BrowserFrameSession } from "./frame-coordinates.ts";
import { staleRef, BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { AXTree, Bounds, CallResult, ResolvedNode, snapshotNodes } from "./cdp.ts";
import { z } from "zod";

/** One generation and one bounded snapshot; navigation cannot alias an old ref. */
export class SnapshotRefs {
  private epoch = 0;
  private refs = new Map<string, { backendNodeId: number; cdp: BrowserCdp; frameId?: string }>();
  private frames:
    | (() => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]>)
    | undefined;
  private cdp: BrowserCdp;
  private frameSessions = new Map<string, BrowserFrameSession>();
  constructor(
    cdp: BrowserCdp,
    frames?: () => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]>,
  ) {
    this.frames = frames;
    this.cdp = cdp;
  }
  replace(cdp: BrowserCdp): void {
    this.cdp = cdp;
    this.invalidate();
  }
  invalidate(): void {
    this.epoch++;
    this.refs.clear();
  }
  async snapshot() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.collect();
      } catch (error) {
        if (!(error instanceof BrowserActionError && error.code === "stale_ref") || attempt >= 4)
          throw error;
      }
    }
  }
  private async collect() {
    const epoch = this.epoch;
    const frames = this.frames ? await this.frames() : [{ frameId: undefined, cdp: this.cdp }];
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
    const nodes: (ReturnType<typeof snapshotNodes>[number] & { frameId?: string })[] = [];
    const refs = new Map<string, { backendNodeId: number; cdp: BrowserCdp; frameId?: string }>();
    let truncated = false,
      bytes = 0;
    for (const frame of frames) {
      const tree = AXTree.parse(
        await frame.cdp
          .send("Accessibility.getFullAXTree", {
            depth: 20,
            ...(frame.frameId ? { frameId: frame.frameId } : {}),
          })
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
      for (const node of snapshotNodes(tree, epoch)) {
        const backendNodeId = node.ref ? Number(node.ref.split("-")[1]) : undefined;
        const prefix = frame.frameId ? `${frame.frameId}:` : "";
        const output = {
          ...node,
          id: prefix + node.id,
          children: node.children.map((id) => prefix + id),
          ...(frame.frameId ? { frameId: frame.frameId } : {}),
          ...(node.ref ? { ref: prefix + node.ref } : {}),
        };
        bytes += Buffer.byteLength(JSON.stringify(output));
        if (nodes.length >= 10000 || bytes > 512 * 1024) {
          truncated = true;
          break;
        }
        nodes.push(output);
        if (output.ref && backendNodeId !== undefined)
          refs.set(output.ref, {
            backendNodeId,
            cdp: frame.cdp,
            ...(frame.frameId ? { frameId: frame.frameId } : {}),
          });
      }
      if (nodes.length < tree.nodes.length) truncated = true;
      if (truncated) break;
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = refs;
    return { nodes, truncated };
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
