import { z } from "zod";
import { BrowserVideoCodec } from "@ace/protocol";
import type { BrowserCdp, CaptureEvents, VideoCaptureHandle, VideoHost } from "./backend.ts";
import type { CdpConnection } from "./cdp-connection.ts";
import { videoExtensionId, writeVideoExtension } from "./video-extension.ts";
import { deliverVideoEvent, VideoEncoderEvent } from "./video-events.ts";

const SupportedCodecs = z.array(BrowserVideoCodec);
const OpenedStream = z.object({ streamId: z.string().min(1).max(256) });
const LoadedExtension = z.object({ id: z.string() });

/*
 * ace's Chrome as a video encoder (ADR 0088): loads the video extension and keeps CDP sessions
 * on its service worker and offscreen document. The document streams its chunks (video, and the
 * tab's sound while asked) straight into ace-media's ingest; over CDP come only its events
 * (`failed`, `ended`). One per Chrome process.
 */

const Targets = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
});
const Attached = z.object({ sessionId: z.string() });
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
const TargetInfo = z.object({ targetInfo: z.object({ targetId: z.string() }) });
const ChromeTabId = z.number().int();
const ExportNames = z.array(z.string());
/** The tab shown in a window: whether it plays sound and whether it is muted. */
const Audio = z.object({ audible: z.boolean(), muted: z.boolean() });
const TabAudio = Audio.extend({ tabId: ChromeTabId });
type TabAudioListener = (tabId: number, audio: z.infer<typeof Audio>) => void;

/** One open capture's sound: what its viewer asked, and how to set what the document encodes. */
interface CaptureSound {
  tabId: number;
  /** A viewer of this capture listens (ADR 0088, Audio): it asked for the tab's sound. */
  wanted: boolean;
  /** Applies `wanted`, less the tab's mute, which is for everyone. */
  apply(): void;
}

const origin = `chrome-extension://${videoExtensionId}/`;

/**
 * Every export the daemon calls. A profile can keep an older build of the same id and version
 * running (Chrome does not replace an unpacked extension whose version did not change), and
 * calling an export it lacks is how every capture would then fail.
 */
const workerExports = ["ready", "open", "tabFor", "tabAudio", "mute"] as const;
const documentExports = [
  "supported",
  "start",
  "encodes",
  "keyframe",
  "audio",
  "ingest",
  "epoch",
  "stop",
] as const;

/** The CDP surface the encoder uses: commands, and the sessions of attached targets. */
type Connection = Pick<CdpConnection, "send" | "session">;

export class ChromeVideo implements VideoHost {
  readonly mediaKind = "tab";
  private connection: Connection;
  private targets: { keep(targetId: string): void };
  private directory: string;
  private delay: (milliseconds: number) => Promise<void>;
  private ready: Promise<{ worker: BrowserCdp; document: BrowserCdp }> | undefined;
  private workerTarget: string | undefined;
  private documentTarget: string | undefined;
  private sessions = new Set<string>();
  private captures = new Map<string, CaptureEvents>();
  /** Told of each tab's sound as the extension's worker hears it (they outlive reinstalls). */
  private tabAudioListeners = new Set<TabAudioListener>();
  /** Tabs Chrome reports muted, by Chrome tab: their sound is off for every viewer (ADR 0088). */
  private mutedTabs = new Set<number>();
  /** Each open capture's sound, so a tab's mute applies to the captures of that tab. */
  private captureAudio = new Map<string, CaptureSound>();
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
      this.captureAudio.clear();
    });
  }
  async supported(codecs: readonly string[], width: number, height: number): Promise<string[]> {
    const { document } = await this.extension();
    return SupportedCodecs.parse(
      await evaluate(document, "aceVideo.supported", [codecs, width, height]),
    );
  }
  /**
   * Told each time the extension's worker hears a tab's sound change, with the Chrome tab it
   * belongs to. One per Chrome, so every thread's tabs listen here.
   */
  onTabAudio(listener: TabAudioListener): () => void {
    this.tabAudioListeners.add(listener);
    return () => {
      this.tabAudioListeners.delete(listener);
    };
  }
  /**
   * The Chrome tab id of the page on `page`'s CDP session: the extension keys sound by tab, not
   * by window, since a named popup shares its opener's window.
   */
  async chromeTabId(page: BrowserCdp): Promise<number> {
    const { targetInfo } = TargetInfo.parse(await page.send("Target.getTargetInfo"));
    const { worker } = await this.extension();
    return ChromeTabId.parse(await evaluate(worker, "aceVideo.tabFor", [targetInfo.targetId]));
  }
  /** Whether the Chrome tab plays sound, and whether it is muted. */
  async tabAudio(tabId: number): Promise<z.infer<typeof Audio>> {
    const { worker } = await this.extension();
    return Audio.parse(await evaluate(worker, "aceVideo.tabAudio", [tabId]));
  }
  /** Turns the sound of the Chrome tab off or on. */
  async mute(tabId: number, muted: boolean): Promise<void> {
    const { worker } = await this.extension();
    await evaluate(worker, "aceVideo.mute", [tabId, muted]);
  }
  async open(
    page: BrowserCdp,
    width: number,
    height: number,
    events: CaptureEvents,
  ): Promise<VideoCaptureHandle> {
    const tabId = await this.chromeTabId(page);
    const id = `capture-${++this.ids}`;
    const document = await this.start(id, tabId, width, height);
    // A page already playing sound when its capture starts sends no change once the worker
    // listens: seed the tab's state for every listener, best effort.
    void this.tabAudio(tabId).then(
      (audio) => this.announceTabAudio(tabId, audio),
      () => {},
    );
    this.captures.set(id, events);
    const muted = () => this.mutedTabs.has(tabId);
    const sound: CaptureSound = {
      tabId,
      wanted: false,
      apply: () => {
        void evaluate(document, "aceVideo.audio", [id, sound.wanted && !muted()]).catch(() => {});
      },
    };
    this.captureAudio.set(id, sound);
    const call = (name: string, args: unknown[]) =>
      void evaluate(document, name, args).catch(() => {});
    return {
      encodes: (specs) => call("aceVideo.encodes", [id, specs]),
      keyframe: (encode) => call("aceVideo.keyframe", [id, encode]),
      audio: (on) => {
        sound.wanted = on;
        sound.apply();
      },
      // Chunks go only to ace-media's ingest, binary.
      ingest: (target) => call("aceVideo.ingest", [id, target ?? null]),
      close: () => {
        this.captureAudio.delete(id);
        if (!this.captures.delete(id)) return;
        const stopped = evaluate(document, "aceVideo.stop", [id]).catch(() => {});
        this.stopping.add(stopped);
        // `stopped` already swallows its own failure; only clearing the set is left.
        void stopped.finally(() => this.stopping.delete(stopped)).catch(() => {});
      },
    };
  }
  /**
   * Opens capture `id` of Chrome tab `tabId` and returns the document encoding it. Each attempt
   * takes a fresh stream id, since Chrome takes one only once. With the tab's sound first; a
   * capture that can't take it streams its picture alone. A failed attempt can leave the tab
   * held by a capture Chrome started but never handed over, which neither a new stream id nor a
   * new document frees: then the extension is installed again, which ends every capture it asked
   * for, and the tab is tried once more.
   */
  private async start(id: string, tabId: number, width: number, height: number) {
    // A capture still stopping holds its tab; asking for the tab before then is refused.
    await Promise.all(this.stopping);
    let { worker, document } = await this.extension();
    const attempt = async (audio: boolean) => {
      const { streamId } = OpenedStream.parse(await evaluate(worker, "aceVideo.open", [tabId]));
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
  private async install(
    not: {
      worker?: string | undefined;
      document?: string | undefined;
    },
    /** This load follows installing a build that was already running. */
    reinstalled = false,
  ): Promise<{ worker: BrowserCdp; document: BrowserCdp }> {
    await writeVideoExtension(this.directory);
    const loaded = LoadedExtension.parse(
      await this.connection.send("Extensions.loadUnpacked", { path: this.directory }),
    );
    if (loaded.id !== videoExtensionId)
      throw new Error("The video extension loaded under another id");
    // An attached target may not have run its script yet, or may be paused before it: always
    // so on Windows, on any platform for an extension installed again over a running one (a
    // failed load retried is one), and under load anywhere. Calling an export then throws, or
    // never answers at all, so every load waits for the exports.
    const attached = await this.attach(`${origin}worker.js`, not.worker);
    this.workerTarget = attached.targetId;
    const worker = attached.session;
    await this.untilExport(worker, "ready");
    worker.on("Runtime.bindingCalled", (raw) => this.receiveTab(raw));
    await worker.send("Runtime.addBinding", { name: "aceVideoTab" });
    await evaluate(worker, "aceVideo.ready", []);
    const opened = await this.attach(`${origin}offscreen.html`, not.document);
    this.documentTarget = opened.targetId;
    const document = opened.session;
    await this.untilExport(document, "supported");
    document.on("Runtime.bindingCalled", (raw) => this.receive(raw));
    await document.send("Runtime.addBinding", { name: "aceVideoEvent" });
    const missing = await this.missingExports(worker, document);
    if (!missing.length) return { worker, document };
    if (reinstalled)
      throw new Error(`The video extension is out of date: ${missing.join(", ")} missing`);
    // Chrome kept the build it was already running, which lacks these exports: install it again
    // (which closes the old worker) and check the new one.
    this.sessions.clear();
    for (const events of this.captures.values()) events.ended();
    this.captures.clear();
    this.captureAudio.clear();
    await this.connection.send("Extensions.uninstall", { id: videoExtensionId });
    return this.install({ worker: attached.targetId, document: opened.targetId }, true);
  }
  /** The exports of `workerExports` and `documentExports` their `aceVideo` does not define. */
  private async missingExports(worker: BrowserCdp, document: BrowserCdp): Promise<string[]> {
    const missing = [
      ...(await absentExports(worker, workerExports)),
      ...(await absentExports(document, documentExports)),
    ];
    return [...new Set(missing)].map((name) => `aceVideo.${name}`);
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
        let attached: unknown;
        try {
          attached = await this.connection.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
        } catch (error) {
          // The target went away between the listing and the attach (an old worker a reinstall
          // just ended): look again for the one that replaces it.
          if (error instanceof Error && error.message.includes("No target with given id")) {
            await this.delay(100);
            continue;
          }
          throw error;
        }
        const { sessionId } = Attached.parse(attached);
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
    let json: unknown;
    try {
      json = JSON.parse(binding.data.payload);
    } catch {
      return;
    }
    const event = VideoEncoderEvent.safeParse(json);
    if (event.success) deliverVideoEvent(this.captures, event.data);
  }
  /** The worker's tab sound changes (`aceVideoTab`), as JSON. */
  private receiveTab(raw: unknown): void {
    const binding = Binding.safeParse(raw);
    if (!binding.success || binding.data.name !== "aceVideoTab") return;
    let json: unknown;
    try {
      json = JSON.parse(binding.data.payload);
    } catch {
      return;
    }
    const audio = TabAudio.safeParse(json);
    if (!audio.success) return;
    const { tabId, audible, muted } = audio.data;
    this.announceTabAudio(tabId, { audible, muted });
  }
  private announceTabAudio(tabId: number, audio: z.infer<typeof Audio>): void {
    if (audio.muted !== this.mutedTabs.has(tabId)) {
      if (audio.muted) this.mutedTabs.add(tabId);
      else this.mutedTabs.delete(tabId);
      // The tab's mute is for everyone: its captures stop or resume their sound with it.
      for (const sound of this.captureAudio.values()) if (sound.tabId === tabId) sound.apply();
    }
    for (const listener of this.tabAudioListeners) listener(tabId, audio);
  }
}

/** The exports of `exports` an `aceVideo` on `target` does not define (a stale build lacks some). */
async function absentExports(target: BrowserCdp, exports: readonly string[]): Promise<string[]> {
  try {
    const reply = Evaluated.parse(
      await target.send("Runtime.evaluate", {
        expression: `(${JSON.stringify(exports)}).filter((name) => typeof globalThis.aceVideo?.[name] !== "function")`,
        returnByValue: true,
      }),
    );
    return ExportNames.parse(reply.result?.value ?? [...exports]);
  } catch {
    // A target that cannot answer is no better than one that lacks the exports.
    return [...exports];
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
