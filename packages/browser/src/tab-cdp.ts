import { EventEmitter } from "node:events";
import type { BrowserCdp } from "./backend.ts";

/**
 * A tab's CDP surface that survives a browser restart. Listeners stay registered here while the
 * underlying target session is replaced, so refs, capture and annotation keep one object.
 */
export class TabCdp implements BrowserCdp {
  private events = new EventEmitter();
  private target: BrowserCdp | undefined;
  private forward = new Map<string, (params: unknown) => void>();
  constructor() {
    this.events.setMaxListeners(0);
  }
  /** Points the tab at a new target session; commands to the old one fail. */
  bind(target: BrowserCdp | undefined): void {
    if (this.target) for (const [method, relay] of this.forward) this.target.off(method, relay);
    this.target = target;
    if (target) for (const [method, relay] of this.forward) target.on(method, relay);
  }
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const target = this.target;
    if (!target) return Promise.reject(new Error("Browser tab unavailable"));
    return target.send(method, params);
  }
  on(method: string, listener: (params: unknown) => void): this {
    if (!this.forward.has(method)) {
      const relay = (params: unknown) => this.events.emit(method, params);
      this.forward.set(method, relay);
      this.target?.on(method, relay);
    }
    this.events.on(method, listener);
    return this;
  }
  off(method: string, listener: (params: unknown) => void): this {
    this.events.off(method, listener);
    return this;
  }
  /** Local events (for example `ace.permissionDenied`) reach listeners like CDP events. */
  emit(method: string, params: unknown): void {
    this.events.emit(method, params);
  }
  clear(): void {
    this.bind(undefined);
    this.forward.clear();
    this.events.removeAllListeners();
  }
}
