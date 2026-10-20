import { z } from "zod";
import type { CdpConnection, Schedule } from "./cdp-connection.ts";

const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    openerId: z.string().optional(),
    browserContextId: z.string().optional(),
  }),
});
const Created = z.object({ targetId: z.string() });
const Context = z.object({ browserContextId: z.string() });
export interface AttachedTarget {
  targetId: string;
  sessionId: string;
  openerId?: string | undefined;
  browserContextId?: string | undefined;
}

/**
 * Routes the browser's auto-attached page targets. Every page starts paused, so its owner
 * installs guards and listeners before the first request; nothing ace did not ask for runs.
 *
 * A created tab's attach event arrives before `Target.createTarget` replies, so an unclaimed
 * page waits briefly for its creator. Popups go to the tab that opened them. Anything else
 * (for example a page restored from the profile) is closed.
 */
export class ChromeTargets {
  private claims = new Map<
    string,
    { resolve(target: AttachedTarget): void; reject(error: Error): void }
  >();
  private orphans = new Map<string, { target: AttachedTarget; cancel(): void }>();
  private openers = new Map<string, (target: AttachedTarget) => void>();
  /** Targets another part of ace attaches to itself (the video extension's), left alone. */
  private kept = new Set<string>();
  private connection: CdpConnection;
  private schedule: Schedule;
  private reason: string | undefined;
  constructor(connection: CdpConnection, schedule: Schedule) {
    this.connection = connection;
    this.schedule = schedule;
    connection.session("").on("Target.attachedToTarget", (raw) => this.attached(raw));
  }
  async start(downloadPath: string): Promise<void> {
    await this.connection.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }],
    });
    await this.downloads(downloadPath);
  }
  /** Downloads land under ace's staging directory, named by GUID, until quarantined. */
  private async downloads(downloadPath: string, browserContextId?: string): Promise<void> {
    await this.connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath,
      eventsEnabled: true,
      ...(browserContextId ? { browserContextId } : {}),
    });
  }
  /** A throwaway cookie jar inside the shared browser, removed when disposed. */
  async createContext(downloadPath: string): Promise<string> {
    const { browserContextId } = Context.parse(
      await this.connection.send("Target.createBrowserContext", { disposeOnDetach: true }),
    );
    await this.downloads(downloadPath, browserContextId);
    return browserContextId;
  }
  async disposeContext(browserContextId: string): Promise<void> {
    await this.connection.send("Target.disposeBrowserContext", { browserContextId });
  }
  /** Each tab gets its own window: a background tab in a shared window renders no frames. */
  async create(options: {
    width: number;
    height: number;
    browserContextId?: string | undefined;
  }): Promise<AttachedTarget> {
    const { targetId } = Created.parse(
      await this.connection.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
        width: options.width,
        height: options.height,
        ...(options.browserContextId ? { browserContextId: options.browserContextId } : {}),
      }),
    );
    const orphan = this.orphans.get(targetId);
    if (orphan) {
      orphan.cancel();
      this.orphans.delete(targetId);
      return orphan.target;
    }
    if (this.reason) throw new Error(this.reason);
    return new Promise<AttachedTarget>((resolve, reject) => {
      const cancel = this.schedule(() => {
        this.claims.delete(targetId);
        reject(new Error("Browser tab did not start"));
        void this.close(targetId);
      }, 10_000);
      this.claims.set(targetId, {
        resolve: (target) => {
          cancel();
          resolve(target);
        },
        reject: (error) => {
          cancel();
          reject(error);
        },
      });
    });
  }
  /** Popups of `openerId` go to `handler` while it is registered. */
  popups(openerId: string, handler: (target: AttachedTarget) => void): () => void {
    this.openers.set(openerId, handler);
    return () => {
      if (this.openers.get(openerId) === handler) this.openers.delete(openerId);
    };
  }
  /** Lets a paused target run; its owner has installed what it needs. */
  async resume(target: AttachedTarget): Promise<void> {
    await this.connection.send("Runtime.runIfWaitingForDebugger", undefined, {
      sessionId: target.sessionId,
    });
  }
  async close(targetId: string): Promise<void> {
    await this.connection.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  /** Leaves `targetId` attached when ace attaches to it outside this router. */
  keep(targetId: string): void {
    this.kept.add(targetId);
  }
  stop(reason: string): void {
    this.reason = reason;
    for (const claim of this.claims.values()) claim.reject(new Error(reason));
    this.claims.clear();
    for (const orphan of this.orphans.values()) orphan.cancel();
    this.orphans.clear();
    this.openers.clear();
  }
  private attached(raw: unknown): void {
    const parsed = Attached.safeParse(raw);
    if (!parsed.success || this.reason) return;
    const { sessionId, targetInfo } = parsed.data;
    if (this.kept.has(targetInfo.targetId)) return;
    const target: AttachedTarget = {
      targetId: targetInfo.targetId,
      sessionId,
      openerId: targetInfo.openerId,
      browserContextId: targetInfo.browserContextId,
    };
    if (targetInfo.type !== "page") {
      void this.resume(target)
        .then(() => this.connection.send("Target.detachFromTarget", { sessionId }))
        .catch(() => {});
      return;
    }
    const claim = this.claims.get(target.targetId);
    if (claim) {
      this.claims.delete(target.targetId);
      claim.resolve(target);
      return;
    }
    const opener = target.openerId ? this.openers.get(target.openerId) : undefined;
    if (opener) {
      opener(target);
      return;
    }
    if (this.orphans.size >= 64) {
      void this.close(target.targetId);
      return;
    }
    const cancel = this.schedule(() => {
      this.orphans.delete(target.targetId);
      void this.close(target.targetId);
    }, 5_000);
    this.orphans.set(target.targetId, { target, cancel });
  }
}
