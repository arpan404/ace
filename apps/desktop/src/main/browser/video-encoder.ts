import { session as sessions, WebContentsView, type WebContents } from "electron";
import { z } from "zod";
import { videoEncoderScript } from "@ace/browser/video-encoder";
import { encoderOrigin, type EncodeSpec, type PageVideoHost } from "./page-video.ts";

/*
 * The desktop's video encoder (ADR 0088, embedded backend): one hidden page, made while anyone
 * watches a view as video, that runs the encoder ace's Chrome runs in its extension
 * (`@ace/browser/video-encoder`). A view is captured with Electron's
 * `webContents.getMediaSourceId(encoderPage)` and `getUserMedia({ chromeMediaSource: "tab" })`:
 * Chromium's own tab capture, which needs no user gesture and no screen-recording permission,
 * and keeps the view producing frames while it is captured. The page's events (encoded chunks
 * with their bytes) arrive over IPC from its preload and go to `onEvent`.
 *
 * The page is a WebContentsView in no window, so it never counts as an app window, in its own
 * in-memory partition that grants it the media permission and nothing else (Electron asks the
 * captured view's session too: `encoderCapture` in `page-video.ts`). Its address is
 * `app://video-encoder/`: the app scheme is a secure context, which `getUserMedia` needs.
 */

const partition = "ace-video-encoder";
const channel = "ace:video.event";
const page = `<!doctype html>\n<meta charset="utf-8">\n<title>ace video encoder</title>\n<script src="encoder.js"></script>\n`;
const policy = "default-src 'none'; script-src 'self'";
/** An unused encoder page stays this long, for the next capture to start quickly. */
const defaultIdleMs = 30_000;

/** What the encoder reports; the daemon parses the full event, this reads what routing needs. */
export const EncoderEvent = z.looseObject({
  t: z.enum(["chunk", "audio", "failed", "ended"]),
  capture: z.string().min(1).max(256),
  encode: z.string().max(256).optional(),
  key: z.boolean().optional(),
});
export type EncoderEvent = z.infer<typeof EncoderEvent>;

export interface VideoEncoderOptions {
  /** The encoder page's preload (`video-encoder-preload.cjs`). */
  preload: string;
  log(message: string): void;
  idleMs?: number;
  timers?: { set(delayMs: number, callback: () => void): () => void };
}

const defaultTimers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export class VideoEncoderHost implements PageVideoHost<WebContents> {
  private options: VideoEncoderOptions;
  private view: WebContentsView | undefined;
  private ready: Promise<WebContents> | undefined;
  private configured = false;
  private captures = new Set<string>();
  private listeners = new Set<(event: EncoderEvent, bytes: Uint8Array | undefined) => void>();
  private stopped = new Set<(capture: string) => void>();
  private cancelIdle: (() => void) | undefined;

  constructor(options: VideoEncoderOptions) {
    this.options = options;
  }

  /** Every event of every capture, as the encoder reports it. */
  onEvent(listener: (event: EncoderEvent, bytes: Uint8Array | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStopped(listener: (capture: string) => void): () => void {
    this.stopped.add(listener);
    return () => this.stopped.delete(listener);
  }

  async supported(codecs: readonly string[], width: number, height: number): Promise<string[]> {
    try {
      const contents = await this.page();
      return z
        .array(z.string())
        .parse(await call(contents, "aceVideo.supported", [codecs, width, height]));
    } finally {
      this.idle();
    }
  }

  async start(capture: string, source: WebContents, width: number, height: number): Promise<void> {
    this.captures.add(capture);
    this.cancelIdle?.();
    try {
      const contents = await this.page();
      if (!this.captures.has(capture)) throw new Error("The video capture was stopped");
      // Valid for a few seconds, and only for the encoder page that asked for it.
      const streamId = source.getMediaSourceId(contents);
      // Picture only: capturing a view's sound takes it off this computer's speakers, where the
      // person hears the page (measured: the speaker's audio assertion ends with the capture).
      await call(contents, "aceVideo.start", [capture, streamId, width, height, { audio: false }]);
    } catch (error) {
      this.options.log(`Video capture did not start: ${String(error)}`);
      this.end(capture);
      throw error;
    }
  }

  encodes(capture: string, encodes: readonly EncodeSpec[]): void {
    this.post(capture, "aceVideo.encodes", [capture, encodes]);
  }

  keyframe(capture: string, encode: string): void {
    this.post(capture, "aceVideo.keyframe", [capture, encode]);
  }

  audio(capture: string, on: boolean): void {
    this.post(capture, "aceVideo.audio", [capture, on]);
  }

  /** Stops a capture; its listeners hear it ended (the daemon ignores an end it asked for). */
  stop(capture: string): void {
    if (!this.captures.has(capture)) return;
    this.post(capture, "aceVideo.stop", [capture]);
    this.end(capture);
  }

  /** The daemon link dropped: it forgot every capture. */
  stopAll(): void {
    for (const capture of this.captures) this.stop(capture);
  }

  /** Quit: the encoder page goes, with any capture. */
  close(): void {
    this.stopAll();
    this.destroy();
  }

  private end(capture: string): void {
    if (!this.captures.delete(capture)) return;
    this.emit({ t: "ended", capture }, undefined);
    for (const listener of this.stopped) listener(capture);
    this.idle();
  }

  private post(capture: string, name: string, args: unknown[]): void {
    if (!this.captures.has(capture)) return;
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    void call(contents, name, args).catch((error: unknown) =>
      this.options.log(`Video encoder: ${String(error)}`),
    );
  }

  private emit(event: EncoderEvent, bytes: Uint8Array | undefined): void {
    for (const listener of this.listeners) listener(event, bytes);
  }

  /** The encoder page goes once nothing has used it for a while. */
  private idle(): void {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    if (this.captures.size || !this.view) return;
    this.cancelIdle = (this.options.timers ?? defaultTimers).set(
      this.options.idleMs ?? defaultIdleMs,
      () => {
        this.cancelIdle = undefined;
        if (!this.captures.size) this.destroy();
      },
    );
  }

  private page(): Promise<WebContents> {
    this.ready ??= this.create().catch((error: unknown) => {
      this.destroy();
      throw error;
    });
    return this.ready;
  }

  private async create(): Promise<WebContents> {
    this.configure();
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // It is never shown; its timers (the encoder's keyframe and watchdog checks) must run.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.view = view;
    const contents = view.webContents;
    contents.ipc.on(channel, (_event, raw: unknown, bytes: unknown) => {
      const event = EncoderEvent.safeParse(raw);
      if (!event.success || !this.captures.has(event.data.capture)) return;
      if (event.data.t === "ended") return this.end(event.data.capture);
      this.emit(event.data, bytes instanceof Uint8Array ? bytes : undefined);
    });
    contents.on("render-process-gone", (_event, details) => {
      this.options.log(`Video encoder page gone: ${details.reason}`);
      if (this.view === view) this.destroy();
    });
    // Nothing navigates the encoder page and it opens nothing.
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    await contents.loadURL(`${encoderOrigin}/`);
    return contents;
  }

  /** The encoder's partition: serves its page, loads nothing else, grants it only `media`. */
  private configure(): void {
    if (this.configured) return;
    this.configured = true;
    const encoder = sessions.fromPartition(partition);
    const own = (contents: WebContents | null) =>
      contents !== null && contents === this.view?.webContents;
    encoder.setPermissionRequestHandler((contents, permission, callback) =>
      callback(permission === "media" && own(contents)),
    );
    encoder.setPermissionCheckHandler(
      (contents, permission) => permission === "media" && own(contents),
    );
    encoder.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(`${encoderOrigin}/`) }),
    );
    encoder.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      const headers = { "content-security-policy": policy, "x-content-type-options": "nosniff" };
      if (`${url.protocol}//${url.host}` !== encoderOrigin)
        return new Response("Not found", { status: 404, headers });
      if (url.pathname === "/")
        return new Response(page, {
          headers: { ...headers, "content-type": "text/html; charset=utf-8" },
        });
      if (url.pathname === "/encoder.js")
        return new Response(videoEncoderScript(), {
          headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
        });
      return new Response("Not found", { status: 404, headers });
    });
  }

  private destroy(): void {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const view = this.view;
    this.view = undefined;
    this.ready = undefined;
    // Its captures died with it.
    for (const capture of this.captures) this.end(capture);
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }
}

const Called = z.union([
  z.object({ value: z.unknown() }),
  z.object({ error: z.string().max(2048) }),
]);

/**
 * Calls `name(...args)` in the encoder page; resolves with its (awaited) value, or throws what
 * it threw. A page's own errors (a `DOMException` from `getUserMedia`) don't survive
 * `executeJavaScript`, so the page reports them as text.
 */
async function call(contents: WebContents, name: string, args: unknown[]): Promise<unknown> {
  const called = Called.parse(
    await contents.executeJavaScript(
      `Promise.resolve().then(() => ${name}(...${JSON.stringify(args)})).then((value) => ({ value }), (error) => ({ error: String(error?.name ?? "Error") + ": " + String(error?.message ?? error).slice(0, 1024) }))`,
    ),
  );
  if ("error" in called) throw new Error(called.error);
  return called.value;
}
