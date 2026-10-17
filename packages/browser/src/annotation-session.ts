import { annotationCommandExpression, annotationHostExpression } from "@ace/browser-annotate";
import {
  BrowserAnnotationEvent,
  type BrowserAnnotationCapture,
  type BrowserAnnotationCaptureTarget,
  type BrowserAnnotationConfig,
  type BrowserAnnotationEndReason,
  type BrowserAnnotationPageCommand,
} from "@ace/protocol";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { captureAnnotation } from "./annotation-capture.ts";
import { evaluateInWorld, installOverlay, removeOverlay } from "./annotation-install.ts";

interface Active {
  cdp: BrowserCdp;
  owner: string;
  config: BrowserAnnotationConfig;
  contextId: number | undefined;
  documentId?: string;
  detach(): void;
  host?: number | undefined;
}

/**
 * One page's annotate mode (ADR 0082). The daemon keeps no annotation records: it installs the
 * overlay, relays its events to the one connection that started it, captures images on request
 * and ends the mode when the page, lease, tab or connection changes. Records live in the
 * client's composer draft.
 */
export class AnnotationSession {
  private active: Active | undefined;
  /** The last overlay's removal, still unbinding. */
  private removing: Promise<void> = Promise.resolve();
  private deliver: (connectionId: string, event: BrowserAnnotationEvent) => void;
  private changed: () => void;
  constructor(
    deliver: (connectionId: string, event: BrowserAnnotationEvent) => void,
    changed: () => void,
  ) {
    this.deliver = deliver;
    this.changed = changed;
  }
  get owner(): string | undefined {
    return this.active?.owner;
  }

  async start(
    cdp: BrowserCdp,
    owner: string,
    config: BrowserAnnotationConfig,
  ): Promise<{ documentId: string }> {
    if (this.active && this.active.owner !== owner) this.end("lease");
    const current = this.active;
    if (current?.documentId && current.contextId !== undefined) {
      // Starting again is idempotent: apply the new settings to the running overlay.
      await this.command(owner, { op: "configure", ...config });
      return { documentId: current.documentId };
    }
    if (current) this.end("stopped");
    const active: Active = { cdp, owner, config, contextId: undefined, detach() {} };
    this.active = active;
    this.changed();
    try {
      return await this.install(active);
    } catch (error) {
      if (this.active === active) this.end("stopped");
      throw error;
    }
  }
  private async install(active: Active): Promise<{ documentId: string }> {
    // A previous overlay's removal unbinds by name: let it finish before binding again.
    await this.removing;
    const installed = await installOverlay(active.cdp, active.config, {
      event: (payload) => {
        if (this.active === active) this.receive(active, payload);
      },
      navigated: () => {
        if (this.active === active) this.end("navigated");
      },
    });
    if (this.active !== active) {
      // Ended while installing: nothing may stay behind in the page.
      installed.detach();
      await removeOverlay(active.cdp, installed.contextId);
      throw new Error("Annotate mode ended before the overlay was ready");
    }
    active.contextId = installed.contextId;
    active.documentId = installed.documentId;
    active.detach = installed.detach;
    return { documentId: installed.documentId };
  }
  private receive(active: Active, payload: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const event = BrowserAnnotationEvent.safeParse(raw);
    // Only the daemon reports `ended`; a page-made one is not the overlay's to send.
    if (!event.success || event.data.kind === "ended") return;
    this.deliver(active.owner, event.data);
    if (event.data.kind === "close") this.end("stopped");
  }
  private require(owner: string): Active & { contextId: number } {
    const active = this.active;
    if (!active || active.owner !== owner || active.contextId === undefined)
      throw new Error("Annotate mode is not active on this page");
    return { ...active, contextId: active.contextId };
  }
  async command(owner: string, command: BrowserAnnotationPageCommand): Promise<{ ok: boolean }> {
    const active = this.require(owner);
    const result = await evaluateInWorld(
      active.cdp,
      active.contextId,
      annotationCommandExpression(command),
    );
    return { ok: result.value === true };
  }
  capture(
    owner: string,
    target: BrowserAnnotationCaptureTarget,
  ): Promise<BrowserAnnotationCapture> {
    const active = this.require(owner);
    return captureAnnotation(active.cdp, active.contextId, target);
  }
  /** Explicit stop by its owner; stopping when nothing is active is not an error. */
  stop(owner: string): void {
    if (this.active?.owner === owner) this.end("stopped");
  }
  end(reason: BrowserAnnotationEndReason): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.detach();
    if (active.contextId !== undefined)
      this.removing = removeOverlay(active.cdp, active.contextId).catch(() => {});
    this.deliver(active.owner, { kind: "ended", reason });
    this.changed();
  }
  /**
   * The renderer crashed and the desktop reloaded the page: the old world and binding are
   * gone with it. Reinstall on the same page; the overlay reports `ready` again and the client
   * restores its markers.
   */
  restarted(cdp: BrowserCdp): void {
    const previous = this.active;
    if (!previous) return;
    previous.detach();
    const active: Active = {
      cdp,
      owner: previous.owner,
      config: previous.config,
      contextId: undefined,
      detach() {},
    };
    this.active = active;
    void this.install(active).catch(() => {
      if (this.active === active) this.end("restart");
    });
  }
  /** Backend node of the overlay host in the top document, so agent snapshots can omit it. */
  async hostNode(): Promise<number | undefined> {
    const active = this.active;
    if (!active || active.contextId === undefined) return undefined;
    if (active.host !== undefined) return active.host;
    const { objectId } = await evaluateInWorld(
      active.cdp,
      active.contextId,
      annotationHostExpression,
      {
        byValue: false,
      },
    ).catch(() => ({ objectId: undefined }));
    if (!objectId) return undefined;
    try {
      const described = z
        .object({ node: z.object({ backendNodeId: z.number().int() }) })
        .safeParse(await active.cdp.send("DOM.describeNode", { objectId }));
      if (!described.success) return undefined;
      if (this.active === active) active.host = described.data.node.backendNodeId;
      return described.data.node.backendNodeId;
    } finally {
      await active.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}
