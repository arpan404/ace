import { z } from "zod";
import { ChromeHost, type ChromeHostOptions } from "./chrome-host.ts";
import type { ChromeInstance } from "./chrome-instance.ts";
import type { AttachedTarget } from "./chrome-targets.ts";

/** One page to lay out and capture at each width, in its own throwaway browser context. */
export interface PagePreviewRequest {
  /** A self-contained `data:` document; every network request is failed. */
  url: string;
  widths: readonly number[];
  scheme: "light" | "dark";
  /** A CSS colour behind the page, as the app's background is behind its frame. */
  background: string;
  /** The tallest capture, in CSS pixels; a longer page is cut there. */
  maxHeight: number;
  /**
   * Evaluated in the page's content frame (its first child frame, else the page) once fonts are
   * in, finite animations are finished and two frames have painted. Its JSON value is returned.
   */
  measure: string;
  signal: AbortSignal;
}
export interface PagePreviewShot {
  width: number;
  /** The page's full content height, in CSS pixels; the image stops at `maxHeight`. */
  contentHeight: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  data: Buffer;
  measured: unknown;
}

/** Above this a PNG is swapped for a JPEG, so two images stay small in an agent's context. */
const maxPngBytes = 900 * 1024;
const readyWithinMs = 8_000;

const Data = z.object({ data: z.string().max(64 * 1024 * 1024) });
const Frame = z.object({ id: z.string(), url: z.string() });
const FrameTree = z.object({
  frameTree: z.object({
    frame: Frame,
    childFrames: z.array(z.object({ frame: Frame })).optional(),
  }),
});
const World = z.object({ executionContextId: z.number() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.object({ text: z.string().optional() }).optional(),
});
const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.string() }),
});
const Detached = z.object({ sessionId: z.string() });
const Paused = z.object({ requestId: z.string() });

/** Fonts in, finite animations at their end state, then two painted frames. */
const settled = `new Promise((done) => {
  const settle = () => document.fonts.ready.then(() => {
    for (const animation of document.getAnimations()) {
      try {
        const timing = animation.effect && animation.effect.getComputedTiming();
        if (timing && Number.isFinite(timing.endTime)) animation.finish();
      } catch {}
    }
    requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
  });
  if (document.readyState === 'complete') settle();
  else addEventListener('load', settle, { once: true });
})`;
const twoFrames =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Headless captures of a self-contained page for an agent to check its own work (html_preview).
 * A Chrome of ace's on its own profile, never shown: started by the first preview and stopped
 * `launch.idleMs` after the last one. Each preview gets a throwaway context and one tab, laid out
 * at 1 CSS pixel per device pixel with reduced motion, and disposes both when it ends.
 */
export class PagePreviewer {
  private host: ChromeHost;
  private lifetime = new AbortController();
  constructor(options: ChromeHostOptions) {
    this.host = new ChromeHost(options);
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    await this.host.close();
  }
  async capture(request: PagePreviewRequest): Promise<PagePreviewShot[]> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal]);
    const lease = await this.host.acquire(signal);
    const instance = lease.instance;
    let context: string | undefined;
    let target: AttachedTarget | undefined;
    try {
      context = await instance.targets.createContext(instance.stagingDir);
      const first = request.widths[0] ?? 760;
      target = await instance.targets.create({
        width: first,
        height: 800,
        browserContextId: context,
      });
      const page = new PreviewPage(instance, target.sessionId, signal);
      await page.prepare(request.scheme);
      await instance.targets.resume(target);
      const shots: PagePreviewShot[] = [];
      for (const width of request.widths)
        shots.push(await page.shoot(request, width));
      return shots;
    } finally {
      // A page still running a script must not hold the tab: the browser closes it regardless.
      if (target) void instance.targets.close(target.targetId);
      if (context) void instance.targets.disposeContext(context).catch(() => {});
      lease.release();
    }
  }
}

/** One preview tab: its session, the frames it auto-attaches, and the steps of a capture. */
class PreviewPage {
  /** Out-of-process child frames, by frame id (a frame's target id is its frame id). */
  private frames = new Map<string, string>();
  private instance: ChromeInstance;
  private sessionId: string;
  private signal: AbortSignal;
  constructor(instance: ChromeInstance, sessionId: string, signal: AbortSignal) {
    this.instance = instance;
    this.sessionId = sessionId;
    this.signal = signal;
  }
  private send(method: string, params?: Record<string, unknown>, sessionId = this.sessionId) {
    return this.instance.connection.send(method, params, {
      sessionId,
      signal: this.signal,
      timeoutMs: readyWithinMs,
    });
  }
  async prepare(scheme: "light" | "dark"): Promise<void> {
    const session = this.instance.connection.session(this.sessionId);
    session.on("Target.attachedToTarget", (raw) => {
      const attached = Attached.safeParse(raw);
      if (attached.success && attached.data.targetInfo.type === "iframe")
        this.frames.set(attached.data.targetInfo.targetId, attached.data.sessionId);
    });
    session.on("Target.detachedFromTarget", (raw) => {
      const detached = Detached.safeParse(raw);
      if (!detached.success) return;
      for (const [frame, sessionId] of this.frames)
        if (sessionId === detached.data.sessionId) this.frames.delete(frame);
    });
    // The page is a data: document under a CSP with no sources; this fails anything else.
    session.on("Fetch.requestPaused", (raw) => {
      const paused = Paused.safeParse(raw);
      if (paused.success)
        void this.send("Fetch.failRequest", {
          requestId: paused.data.requestId,
          errorReason: "BlockedByClient",
        }).catch(() => {});
    });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await this.send("Page.enable");
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await this.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: scheme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
  }
  async shoot(request: PagePreviewRequest, width: number): Promise<PagePreviewShot> {
    await this.viewport(width, 800);
    const loaded = new Promise<void>((resolve) => {
      const session = this.instance.connection.session(this.sessionId);
      const done = () => {
        session.off("Page.loadEventFired", done);
        resolve();
      };
      session.on("Page.loadEventFired", done);
    });
    // The last document's frame goes with it; its detach may come after the next one attaches.
    this.frames.clear();
    await this.send("Page.navigate", { url: request.url });
    await Promise.race([loaded, pause(readyWithinMs)]);
    // The outer document only holds the page's frame; in the app it is see-through.
    await this.evaluate(
      `document.documentElement.style.background = ${JSON.stringify(request.background)}`,
    );
    const content = await this.contentWorld();
    const measured = await this.evaluate(request.measure, content);
    // As the page bridge reports it to the frame that holds it.
    const reported = await this.evaluate(
      "Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height))",
      content,
    );
    const contentHeight = Math.max(1, z.number().catch(1).parse(reported));
    const height = Math.min(contentHeight, request.maxHeight);
    await this.viewport(width, height);
    await this.evaluate(twoFrames);
    const png = await this.screenshot("png");
    const data = png.byteLength > maxPngBytes ? await this.screenshot("jpeg") : png;
    return {
      width,
      contentHeight,
      height,
      mimeType: data === png ? "image/png" : "image/jpeg",
      data,
      measured,
    };
  }
  private async viewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  private async screenshot(format: "png" | "jpeg"): Promise<Buffer> {
    const shot = Data.parse(
      await this.send("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: 80 } : {}),
      }),
    );
    return Buffer.from(shot.data, "base64");
  }
  /**
   * An isolated world in the content frame once its document has settled. The frame commits its
   * document after the page's, so until it has one other than about:blank the lookup repeats. A
   * sandboxed frame usually runs out of process: it is then its own attached target.
   */
  private async contentWorld(): Promise<{ sessionId: string; contextId: number }> {
    const deadline = performance.now() + readyWithinMs;
    for (;;) {
      this.signal.throwIfAborted();
      try {
        const frame = await this.contentFrame();
        if (frame) {
          const world = World.parse(
            await this.send(
              "Page.createIsolatedWorld",
              { frameId: frame.id, worldName: "ace-preview" },
              frame.sessionId,
            ),
          );
          const located = { sessionId: frame.sessionId, contextId: world.executionContextId };
          await this.evaluate(settled, located);
          return located;
        }
      } catch (error) {
        if (this.signal.aborted || performance.now() >= deadline) throw error;
      }
      if (performance.now() >= deadline) throw new Error("The page did not finish loading");
      await pause(25);
    }
  }
  /** The page's first child frame with its document committed, and the session that runs it. */
  private async contentFrame(): Promise<{ id: string; sessionId: string } | undefined> {
    const tree = FrameTree.parse(await this.send("Page.getFrameTree")).frameTree;
    const local = tree.childFrames?.[0]?.frame;
    if (local) return local.url === "about:blank" ? undefined : { ...local, sessionId: this.sessionId };
    const [remote] = this.frames.values();
    if (remote === undefined) return undefined;
    const own = FrameTree.parse(await this.send("Page.getFrameTree", undefined, remote)).frameTree;
    return own.frame.url === "about:blank" ? undefined : { id: own.frame.id, sessionId: remote };
  }
  private async evaluate(
    expression: string,
    where?: { sessionId: string; contextId: number },
  ): Promise<unknown> {
    const result = Evaluated.parse(
      await this.send(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          ...(where ? { contextId: where.contextId } : {}),
        },
        where?.sessionId,
      ),
    );
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.text ?? "Preview script failed");
    return result.result.value;
  }
}
