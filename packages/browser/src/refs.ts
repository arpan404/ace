import { staleRef } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { AXTree, Bounds, CallResult, ResolvedNode, snapshotNodes } from "./cdp.ts";
import { z } from "zod";

/** One generation and one bounded snapshot; navigation cannot alias an old ref. */
export class SnapshotRefs {
  private epoch = 0;
  private refs = new Map<string, number>();
  private cdp: BrowserCdp;
  constructor(cdp: BrowserCdp) {
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
    const epoch = this.epoch;
    const counters = z
      .object({ nodes: z.number() })
      .parse(await this.cdp.send("Memory.getDOMCounters"));
    if (counters.nodes > 20_000) throw new Error("Browser document exceeds snapshot node limit");
    const tree = AXTree.parse(await this.cdp.send("Accessibility.getFullAXTree", { depth: 20 }));
    const nodes = snapshotNodes(tree, epoch);
    if (epoch !== this.epoch) throw new Error("Document changed during snapshot");
    this.refs.clear();
    for (const node of nodes) if (node.ref) this.refs.set(node.ref, Number(node.ref.split("-")[1]));
    return { nodes, truncated: nodes.length < tree.nodes.length };
  }
  private async call(ref: string, functionDeclaration: string): Promise<unknown> {
    const backendNodeId = this.refs.get(ref);
    if (backendNodeId === undefined) throw staleRef();
    const epoch = this.epoch;
    const { object } = ResolvedNode.parse(
      await this.cdp.send("DOM.resolveNode", { backendNodeId }),
    );
    try {
      if (epoch !== this.epoch) throw staleRef();
      const response = CallResult.parse(
        await this.cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration,
          returnByValue: true,
        }),
      );
      if (epoch !== this.epoch) throw staleRef();
      if (response.exceptionDetails) throw new Error("Browser element is detached or unavailable");
      return response.result.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }
  async bounds(ref: string) {
    return Bounds.parse(
      await this.call(
        ref,
        `function() {
      if (!this.isConnected) throw new Error('detached');
      this.scrollIntoView({block:'center', inline:'center'});
      const r = this.getBoundingClientRect();
      return {x:r.x, y:r.y, width:r.width, height:r.height};
    }`,
      ),
    );
  }
  async focus(ref: string): Promise<void> {
    await this.call(
      ref,
      `function() {
      if (!this.isConnected) throw new Error('detached');
      this.focus();
    }`,
    );
  }
  async select(ref: string): Promise<void> {
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
