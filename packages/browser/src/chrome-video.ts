import { z } from "zod";
import { BrowserVideoCodec } from "@ace/protocol";
import type { BrowserCdp, CaptureEvents, VideoCaptureHandle, VideoHost } from "./backend.ts";
import type { CdpConnection } from "./cdp-connection.ts";
import { videoExtensionId, writeVideoExtension } from "./video-extension.ts";
import { deliverVideoEvent, VideoEncoderEvent } from "./video-events.ts";

/*
 * ace's Chrome as a video encoder (ADR 0088): loads the video extension, keeps CDP sessions on
 * its service worker and offscreen document, and turns the document's binding calls into
 * encoded chunks (video, and the tab's sound while asked). One per Chrome process. The I/O
 * shell around the pure fanout and policy.
 */

const Targets = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
});
const Attached = z.object({ sessionId: z.string() });
const Window = z.object({ windowId: z.number().int() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional() }).optional(),
  exceptionDetails: z
    .object({
      text: z.string().optional(),
      exception: z.object({ description: z.string().optional() }).optional(),
    })
    .optional(),
});
const Binding = z.object({ name: z.string(), payload: z.string() });

const origin = `chrome-extension://${videoExtensionId}/`;

/** The CDP surface the encoder uses: commands, and the sessions of attached targets. */
type Connection = Pick<CdpConnection, "send" | "session">;

export class ChromeVideo implements VideoHost {
  private connection: Connection;
  private targets: { keep(targetId: string): void };
  private directory: string;
  private delay: (milliseconds: number) => Promise<void>;
  private ready: Promise<{ worker: BrowserCdp; document: BrowserCdp }> | undefined;
  private workerTarget: string | undefined;
  private documentTarget: string | undefined;
  private sessions = new Set<string>();
  private captures = new Map<string, CaptureEvents>();
  /** Captures told to stop whose stop hasn't finished: their tab is still held until then. */
  private stopping = new Set<Promise<unknown>>();
  private ids = 0;
  constructor(options: {
    connection: Connection;
    /** The browser's target router, told to leave the extension's targets attached. */
    targets: { keep(targetId: string): void };
    /** Where the unpacked extension is written. */
    directory: string;
    delay: (milliseconds: number) => Promise<void>;
  }) {
    this.connection = options.connection;
    this.targets = options.targets;
    this.directory = options.directory;
    this.delay = options.delay;
    this.connection.session("").on("Target.detachedFromTarget", (raw) => {
      const detached = Attached.safeParse(raw);
      if (!detached.success || !this.sessions.has(detached.data.sessionId)) return;
      // The extension's worker or document went away: the next capture loads it again.
      this.sessions.clear();
      this.ready = undefined;
      for (const events of this.captures.values()) events.ended();
      this.captures.clear();
    });
  }
  async supported(codecs: readonly string[], width: number, height: number): Promise<string[]> {
    const { document } = await this.extension();
    return z
      .array(BrowserVideoCodec)
      .parse(await evaluate(document, "aceVideo.supported", [codecs, width, height]));
  }
  async open(
    page: BrowserCdp,
    width: number,
    height: number,
    events: CaptureEvents,
  ): Promise<VideoCaptureHandle> {
    const { windowId } = Window.parse(await page.send("Browser.getWindowForTarget"));
    const id = `capture-${++this.ids}`;
    const document = await this.start(id, windowId, width, height);
    this.captures.set(id, events);
    const call = (name: string, args: unknown[]) =>
      void evaluate(document, name, args).catch(() => {});
    return {
      encodes: (specs) => call("aceVideo.encodes", [id, specs]),
      keyframe: (encode) => call("aceVideo.keyframe", [id, encode]),
      audio: (on) => call("aceVideo.audio", [id, on]),
      close: () => {
        if (!this.captures.delete(id)) return;
        const stopped = evaluate(document, "aceVideo.stop", [id]).catch(() => {});
        this.stopping.add(stopped);
        void stopped.finally(() => this.stopping.delete(stopped));
      },
    };
  }
  /**
   * Opens capture `id` of the tab shown in `windowId` and returns the document encoding it.
   * Each attempt takes a fresh stream id, since Chrome takes one only once. With the tab's sound
   * first; a capture that can't take it streams its picture alone. A failed attempt can leave
   * the tab held by a capture Chrome started but never handed over, which neither a new stream id
   * nor a new document frees: then the extension is installed again, which ends every capture
   * it asked for, and the tab is tried once more.
   */
  private async start(id: string, windowId: number, width: number, height: number) {
    // A capture still stopping holds its tab; asking for the tab before then is refused.
    await Promise.all(this.stopping);
    let { worker, document } = await this.extension();
    const attempt = async (audio: boolean) => {
      const { streamId } = z
        .object({ streamId: z.string().min(1).max(256) })
        .parse(await evaluate(worker, "aceVideo.open", [windowId]));
      await evaluate(document, "aceVideo.start", [
        id,
        streamId,
        width,
        height,
        ...(audio ? [] : [{ audio: false }]),
      ]);
    };
    try {
      await attempt(true);
      return document;
    } catch {}
    try {
      await attempt(false);
      return document;
    } catch (error) {
      if (!heldTab(error)) throw error;
    }
    ({ worker, document } = await this.restart());
    await attempt(true).catch(() => attempt(false));
    return document;
  }
  /** Installs the extension again and attaches to it; its captures end, so viewers reopen them. */
  private async restart(): Promise<{ worker: BrowserCdp; document: BrowserCdp }> {
    const old = { worker: this.workerTarget, document: this.documentTarget };
    // The old targets' sessions end with them; their detach must not end the new captures.
    this.sessions.clear();
    for (const events of this.captures.values()) events.ended();
    this.captures.clear();
    await this.connection.send("Extensions.uninstall", { id: videoExtensionId });
    const opened = this.install(old);
    this.ready = opened.catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return opened;
  }
  /**
   * Video of a tab the extension can't capture (a private browser context, ADR 0088 amended):
   * the live capture hands the tab's JPEG screencast frames to `pictures.push`, and the same
   * offscreen document decodes and encodes them. Viewers still get only video. One picture is
   * in flight to the document; a newer one replaces a waiting one.
   */
  async openPictures(
    _page: BrowserCdp | undefined,
    width: number,
    height: number,
    events: CaptureEvents,
  ): Promise<VideoCaptureHandle> {
    const { document } = await this.extension();
    const id = `capture-${++this.ids}`;
    this.captures.set(id, events);
    let open = true;
    let sending = false;
    let waiting: string | undefined;
    const send = (data: string) => {
      sending = true;
      void evaluate(document, "aceVideo.picture", [id, data])
        .catch(() => {})
        .finally(() => {
          sending = false;
          const next = waiting;
          waiting = undefined;
          if (open && next) send(next);
        });
    };
    try {
      await evaluate(document, "aceVideo.startPictures", [id]);
    } catch (error) {
      this.captures.delete(id);
      throw error;
    }
    const call = (name: string, args: unknown[]) =>
      void evaluate(document, name, args).catch(() => {});
    return {
      encodes: (specs) => call("aceVideo.encodes", [id, specs]),
      keyframe: (encode) => call("aceVideo.keyframe", [id, encode]),
      pictures: {
        width,
        height,
        push: (data) => {
          if (!open) return;
          if (sending) waiting = data;
          else send(data);
        },
      },
      close: () => {
        if (!open) return;
        open = false;
        this.captures.delete(id);
        call("aceVideo.stop", [id]);
      },
    };
  }
  /** `openPictures` as a video host of its own, for the tabs of a private context. */
  pictures(): VideoHost {
    return {
      supported: (codecs, width, height) => this.supported(codecs, width, height),
      open: (page, width, height, events) => this.openPictures(page, width, height, events),
    };
  }
  private extension(): Promise<{ worker: BrowserCdp; document: BrowserCdp }> {
    this.ready ??= this.load().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  private load(): Promise<{ worker: BrowserCdp; document: BrowserCdp }> {
    return this.install({});
  }
  /** Loads the unpacked extension and attaches to its worker and document, never to `not`. */
  private async install(not: {
    worker?: string | undefined;
    document?: string | undefined;
  }): Promise<{ worker: BrowserCdp; document: BrowserCdp }> {
    await writeVideoExtension(this.directory);
    const loaded = z
      .object({ id: z.string() })
      .parse(await this.connection.send("Extensions.loadUnpacked", { path: this.directory }));
    if (loaded.id !== videoExtensionId)
      throw new Error("The video extension loaded under another id");
    // An attached target may not have run its script yet: always so on Windows, and on any
    // platform for an extension installed again over a running one.
    const scriptsLag = process.platform === "win32" || not.worker !== undefined;
    const attached = await this.attach(`${origin}worker.js`, not.worker);
    this.workerTarget = attached.targetId;
    const worker = attached.session;
    if (scriptsLag) await this.untilExport(worker, "ready");
    await evaluate(worker, "aceVideo.ready", []);
    const opened = await this.attach(`${origin}offscreen.html`, not.document);
    this.documentTarget = opened.targetId;
    const document = opened.session;
    if (scriptsLag) await this.untilExport(document, "supported");
    document.on("Runtime.bindingCalled", (raw) => this.receive(raw));
    await document.send("Runtime.addBinding", { name: "aceVideoEvent" });
    return { worker, document };
  }
  /** Attaches to the extension target at `url` (never `not`), waiting a few seconds for it. */
  private async attach(
    url: string,
    not?: string,
  ): Promise<{ session: BrowserCdp; targetId: string; sessionId: string }> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { targetInfos } = Targets.parse(await this.connection.send("Target.getTargets"));
      const target = targetInfos.find((info) => info.url === url && info.targetId !== not);
      if (target) {
        this.targets.keep(target.targetId);
        const { sessionId } = Attached.parse(
          await this.connection.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          }),
        );
        this.sessions.add(sessionId);
        return {
          session: this.connection.session(sessionId),
          targetId: target.targetId,
          sessionId,
        };
      }
      await this.delay(100);
    }
    throw new Error("The video extension did not start");
  }
  /**
   * An attached extension target may not have run its script yet, so calling an `aceVideo`
   * export would throw `ReferenceError`. Waits a few seconds for `aceVideo[method]`.
   */
  private async untilExport(session: BrowserCdp, method: string): Promise<void> {
    await session.send("Runtime.runIfWaitingForDebugger", {});
    for (let attempt = 0; attempt < 50; attempt++) {
      const reply = Evaluated.parse(
        await session.send("Runtime.evaluate", {
          expression: `typeof globalThis.aceVideo?.${method} === "function"`,
          returnByValue: true,
        }),
      );
      if (!reply.exceptionDetails && reply.result?.value === true) return;
      await this.delay(100);
    }
    throw new Error("The video extension did not start");
  }
  private receive(raw: unknown): void {
    const binding = Binding.safeParse(raw);
    if (!binding.success || binding.data.name !== "aceVideoEvent") return;
    const { payload } = binding.data;
    const split = payload.indexOf("\n");
    let json: unknown;
    try {
      json = JSON.parse(split === -1 ? payload : payload.slice(0, split));
    } catch {
      return;
    }
    const event = VideoEncoderEvent.safeParse(json);
    if (!event.success) return;
    const bytes =
      split === -1 ? undefined : new Uint8Array(Buffer.from(payload.slice(split + 1), "base64"));
    deliverVideoEvent(this.captures, event.data, bytes);
  }
}

/** Chrome refused a capture because another one, maybe one it never handed over, holds the tab. */
function heldTab(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Cannot capture a tab with an active stream")
  );
}

/** Calls `name(...args)` in a target and returns its (awaited) value; throws what it threw. */
function evaluate(target: BrowserCdp, name: string, args: unknown[]): Promise<unknown> {
  return run(target, `${name}(...${JSON.stringify(args)})`);
}

/** An expression's (awaited) value in a target; throws what it threw. */
async function run(target: BrowserCdp, expression: string): Promise<unknown> {
  const reply = Evaluated.parse(
    await target.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
  );
  if (reply.exceptionDetails)
    throw new Error(
      reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text ??
        "Video extension call failed",
    );
  return reply.result?.value;
}
