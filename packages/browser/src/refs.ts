import { frameOffset, type BrowserFrameSession } from "./frame-coordinates.ts";
import { staleRef, BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { AXTree, Bounds, CallResult, ResolvedNode } from "./cdp.ts";
import { compactTree, type CompactNode } from "./snapshot-compact.ts";
import { snapshotLine } from "./snapshot-text.ts";
import { z } from "zod";
import { withoutSubtree } from "./snapshot-exclusion.ts";
import { hitPoint, hitTargetFunction } from "./hit-target.ts";
import { TypedKeeping, typeKeepingPerson } from "./typing.ts";
import { limitDepth, outlineDomNodes, outlineHint, outlineRoles } from "./snapshot-scope.ts";

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
import { maskSecretFields, secretFieldNodes } from "./secret-values.ts";

/** About 1.5k tokens: a default snapshot stays cheaper than a 1536 px screenshot. */
export const defaultSnapshotNodes = 120;
/** About 12k tokens: the most one snapshot returns, whatever maxNodes says. */
const maxSnapshotBytes = 48 * 1024;
interface RefTarget {
  backendNodeId: number;
  cdp: BrowserCdp;
  frameId?: string;
}
type Tree = z.infer<typeof AXTree>;
interface SnapshotFrame {
  frameId?: string;
  cdp: BrowserCdp;
  parentId?: string;
}
export interface SnapshotOptions {
  /** A ref from the latest snapshot: return only that element's subtree. */
  scope?: string;
  /** How many accessibility levels below the page (or `scope`) to read; omitted: all. */
  depth?: number | undefined;
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
  /** How to read more, when the page was too large to read whole. */
  hint?: string | undefined;
}

/** One generation and one bounded snapshot; navigation cannot alias an old ref. */
export class SnapshotRefs {
  private epoch = 0;
  /** Reopened since the last snapshot (`restarted`). */
  private reopened = false;
  private refs = new Map<string, RefTarget>();
  /** Short, document-stable names for child frames, so refs stay a few characters long. */
  private frameAliases = new Map<string, string>();
  /** Every frame's session; returns undefined when the page has no frame list (one session). */
  private frames:
    | (() => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> | undefined)
    | undefined;
  private cdp: BrowserCdp;
  private frameSessions = new Map<string, BrowserFrameSession>();
  /** DOM nodes whose subtrees snapshots omit: ace's own layers (annotate, agent cursor). */
  private excluded: () => Promise<readonly (number | undefined)[]>;
  constructor(
    cdp: BrowserCdp,
    frames?: () => Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> | undefined,
    excluded: () => Promise<readonly (number | undefined)[]> = async () => [],
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
  /**
   * The page was reopened after its renderer, its browser or the daemon restarted. Refs from
   * before fail with `browser_restarted` until the next snapshot, so the agent learns why its
   * page state is gone.
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
   * Bounded, compact snapshot of every frame; it replaces the actionable ref set. Large pages
   * degrade instead of failing: output is cut at the budget, and a page over `outlineDomNodes`
   * lists only its landmarks and headings, each with a ref to scope a snapshot to.
   */
  async snapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.collect(options);
      } catch (error) {
        if (!(error instanceof BrowserActionError && error.code === "stale_ref") || attempt >= 4)
          throw error;
        // A scoped snapshot's ref went stale: retrying cannot bring it back.
        if (options.scope !== undefined) throw error;
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
  private async collect(options: SnapshotOptions): Promise<SnapshotResult> {
    const epoch = this.epoch;
    const scope = options.scope === undefined ? undefined : this.refs.get(options.scope);
    if (options.scope !== undefined && !scope) throw this.unknownRef();
    const frames = await this.listFrames();
    let domNodes = 0;
    for (const cdp of new Set(frames.map((frame) => frame.cdp)))
      domNodes += z
        .object({ nodes: z.number() })
        .parse(await cdp.send("Memory.getDOMCounters")).nodes;
    // Reading a huge page's whole tree takes seconds and tens of megabytes: outline it.
    if (!scope && domNodes > outlineDomNodes) return this.outline(frames, epoch, options);
    const excluded = await this.excluded();
    // Agents never read secret fields' values (ADR 0067, privacy): one lookup per session.
    const secrets = new Map<BrowserCdp, Promise<Set<number>>>();
    const secretsOf = (cdp: BrowserCdp) => {
      let found = secrets.get(cdp);
      if (!found) {
        found = secretFieldNodes(cdp);
        secrets.set(cdp, found);
      }
      return found;
    };
    const page = new CompactPage(options);
    for (const frame of frames) {
      const raw = AXTree.parse(
        await frame.cdp
          .send(
            "Accessibility.getFullAXTree",
            // A scoped read needs its subtree whole; depth then counts from the scope.
            scope || options.depth === undefined
              ? frame.frameId
                ? { frameId: frame.frameId }
                : {}
              : { depth: options.depth, ...(frame.frameId ? { frameId: frame.frameId } : {}) },
          )
          .catch(staleFrame),
      );
      // ace's own layers live in the top document only.
      const tree = maskSecretFields(
        frame.parentId ? raw : withoutSubtree(raw, excluded),
        await secretsOf(frame.cdp),
      );
      const prefix = this.alias(frame);
      const refOf = (backendNodeId: number) => `${prefix}e${epoch}-${backendNodeId}`;
      // Every DOM-backed node stays actionable, including ones the budget leaves out.
      for (const node of tree.nodes)
        if (node.backendDOMNodeId)
          page.refs.set(refOf(node.backendDOMNodeId), {
            backendNodeId: node.backendDOMNodeId,
            cdp: frame.cdp,
            ...(frame.frameId ? { frameId: frame.frameId } : {}),
          });
      if (scope && (scope.cdp !== frame.cdp || scope.frameId !== frame.frameId)) continue;
      const scoped =
        scope && options.depth !== undefined
          ? subtree(tree, scope.backendNodeId, options.depth)
          : tree;
      const compact = compactTree(scoped.nodes, {
        refOf,
        ...(scope ? { scope: scope.backendNodeId } : {}),
        ...(options.interactiveOnly ? { interactiveOnly: true } : {}),
        ...(prefix && frame.frameId ? { frameId: frame.frameId } : {}),
      });
      if (!compact) throw staleRef();
      page.add(compact);
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = page.refs;
    this.reopened = false;
    return page.result();
  }
  /** A page too large to read whole: its top document's landmarks and headings. */
  private async outline(
    frames: SnapshotFrame[],
    epoch: number,
    options: SnapshotOptions,
  ): Promise<SnapshotResult> {
    const top = frames.find((frame) => !frame.parentId) ?? { cdp: this.cdp };
    const document = DocumentRoot.parse(await top.cdp.send("DOM.getDocument", { depth: 0 }));
    const excluded = await this.excluded();
    const secrets = await secretFieldNodes(top.cdp);
    const page = new CompactPage(options);
    const refOf = (backendNodeId: number) => `e${epoch}-${backendNodeId}`;
    for (const role of outlineRoles) {
      const raw = AXTree.parse(
        await top.cdp
          .send("Accessibility.queryAXTree", { backendNodeId: document.root.backendNodeId, role })
          .catch(staleFrame),
      );
      // An outline lists nodes without their children: each is a line of its own.
      const nodes = maskSecretFields(raw, secrets).nodes.filter(
        (node) => node.backendDOMNodeId === undefined || !excluded.includes(node.backendDOMNodeId),
      );
      for (const node of nodes) node.childIds = [];
      for (const node of nodes)
        if (node.backendDOMNodeId)
          page.refs.set(refOf(node.backendDOMNodeId), {
            backendNodeId: node.backendDOMNodeId,
            cdp: top.cdp,
          });
      page.add(compactTree(nodes, { refOf }) ?? []);
    }
    if (epoch !== this.epoch) throw staleRef();
    this.refs = page.refs;
    this.reopened = false;
    return { ...page.result(), truncated: true, hint: outlineHint };
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
          awaitPromise: true,
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
  /**
   * Where an agent's pointer lands on `ref`: scrolled into view, its box steady across two
   * frames, at a point where the element itself would take the click (`hit-target.ts`).
   * Fails with `not_visible`, `not_hittable` or `covered`. Top-level CSS pixels.
   */
  async target(ref: string, beforeDispatch: () => void) {
    const { rect, point } = hitPoint(await this.call(ref, hitTargetFunction, beforeDispatch));
    const target = this.refs.get(ref);
    if (!target?.frameId) return { rect, point };
    const guard = this.guard(ref);
    const offset = await frameOffset(target.frameId, this.frameSessions, () => {
      beforeDispatch();
      guard();
    });
    return {
      rect: { ...rect, x: rect.x + offset.x, y: rect.y + offset.y },
      point: { x: point.x + offset.x, y: point.y + offset.y },
    };
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
  /**
   * Adds `text` after the field's own text and gives the person back their focus and caret, in
   * one page task. Returns whether the field already held text.
   */
  async typeKeeping(ref: string, text: string, beforeDispatch: () => void): Promise<boolean> {
    return TypedKeeping.parse(await this.call(ref, typeKeepingPerson, beforeDispatch, [text])).kept;
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

/** One snapshot's lines and refs, kept within the node and byte budgets as frames are added. */
class CompactPage {
  readonly refs = new Map<string, RefTarget>();
  private nodes: CompactNode[] = [];
  private total = 0;
  private bytes = 0;
  private limit: number;
  private match: ((node: CompactNode) => boolean) | undefined;
  constructor(options: SnapshotOptions) {
    this.limit = options.maxNodes ?? defaultSnapshotNodes;
    this.match = options.match;
  }
  add(compact: readonly CompactNode[]): void {
    for (const node of compact) {
      if (this.match && !this.match(node)) continue;
      this.total++;
      if (this.nodes.length >= this.limit) continue;
      this.bytes += snapshotLine(node).length + 1;
      if (this.bytes > maxSnapshotBytes) {
        this.bytes = Number.POSITIVE_INFINITY;
        continue;
      }
      this.nodes.push(node);
    }
  }
  result(): SnapshotResult {
    return { nodes: this.nodes, total: this.total, truncated: this.nodes.length < this.total };
  }
}

/** The subtree under `backendNodeId`, at most `depth` levels below it. */
function subtree(tree: Tree, backendNodeId: number, depth: number): Tree {
  const index = tree.nodes.findIndex((node) => node.backendDOMNodeId === backendNodeId);
  if (index < 0) return tree;
  const root = tree.nodes[index];
  if (!root) return tree;
  return limitDepth({ nodes: [root, ...tree.nodes.filter((_, at) => at !== index)] }, depth);
}
