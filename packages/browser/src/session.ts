import { z } from "zod";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import {
  BrowserCommand,
  BrowserInput,
  type BrowserArtifact,
  type BrowserState,
  type ThreadId,
} from "@ace/protocol";
import { LiveCapture } from "./live.ts";
import { SessionLogs } from "./logs.ts";
import { SnapshotRefs } from "./refs.ts";
import { Recording } from "./recording.ts";
import { evaluatePage } from "./evaluation.ts";
import { keyEvent } from "./keyboard.ts";
import type { ProcessSpawner } from "./io.ts";

export type Actor = { kind: "agent" } | { kind: "human"; connectionId: string };
export interface SessionOptions {
  threadId: ThreadId;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  dir: string;
  now: () => number;
  id: () => string;
  ffmpeg?: string;
  spawn?: ProcessSpawner;
  cancelPolicy: () => void;
  navigatePolicy: (url: string) => Promise<boolean>;
  evaluatePolicy?: (threadId: string, url: string) => boolean | Promise<boolean>;
  artifact: (artifact: BrowserArtifact) => void | Promise<void>;
  state: (state: BrowserState) => void;
  cleanup: () => Promise<void>;
}
const ScreenshotBytes = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= 8 * 1024 * 1024, "Browser screenshot exceeds image limit");

const inputActions = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "emulate",
]);

export class BrowserSession {
  readonly live: LiveCapture;
  private refs: SnapshotRefs;
  private logs: SessionLogs;
  private options: SessionOptions;
  private controller: BrowserState["controller"] = "agent";
  private owner: string | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private recording: Recording | undefined;
  constructor(options: SessionOptions) {
    this.options = options;
    this.refs = new SnapshotRefs(options.cdp);
    this.logs = new SessionLogs(options.dir);
    this.live = new LiveCapture(options.cdp, options.now, (frame) => this.recording?.accept(frame));
    options.page.on("framenavigated", (frame) => {
      if (frame === options.page.mainFrame()) {
        this.refs.invalidate();
        this.emit();
      }
    });
    options.page.on("console", (message) =>
      this.logs.append("console", {
        at: options.now(),
        type: message.type(),
        text: message.text(),
      }),
    );
    options.page.on("pageerror", (error) =>
      this.logs.append("console", { at: options.now(), type: "pageerror", text: error.message }),
    );
    options.context.on("response", (response) =>
      this.logs.append("network", {
        at: options.now(),
        type: "response",
        text: `${response.status()} ${response.request().method()} ${response.url()}`,
      }),
    );
    options.context.on("requestfailed", (request) =>
      this.logs.append("network", {
        at: options.now(),
        type: "failed",
        text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
      }),
    );
  }
  get state(): BrowserState {
    return {
      threadId: this.options.threadId,
      controller: this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
      url: this.options.page.url().slice(0, 8192),
      closed: this.closed,
    };
  }
  private emit(): void {
    this.options.state(this.state);
  }
  takeover(connectionId: string): BrowserState {
    if (this.closed) throw new Error("Browser closed");
    if (this.owner && this.owner !== connectionId)
      throw new Error("Browser already controlled by another connection");
    this.controller = "human";
    this.owner = connectionId;
    this.emit();
    return this.state;
  }
  handback(connectionId: string): BrowserState {
    if (this.owner !== connectionId) throw new Error("Browser controller mismatch");
    this.controller = "agent";
    this.owner = undefined;
    this.emit();
    return this.state;
  }
  disconnect(connectionId: string): void {
    if (this.owner === connectionId) this.handback(connectionId);
  }
  private check(actor: Actor, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Browser closed");
    if (actor.kind === "agent" && this.controller !== "agent")
      throw new Error("Browser controlled by human");
    if (
      actor.kind === "human" &&
      (this.controller !== "human" || this.owner !== actor.connectionId)
    )
      throw new Error("Browser controller mismatch");
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser closed"));
    if (this.pending >= 32) return Promise.reject(new Error("Browser command queue full"));
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  execute(raw: unknown, actor: Actor = { kind: "agent" }, signal?: AbortSignal): Promise<unknown> {
    const command = BrowserCommand.parse(raw);
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Browser closed");
      if (inputActions.has(command.action)) this.check(actor, signal);
      return this.run(command, actor, signal);
    });
  }
  screenshot(signal?: AbortSignal): Promise<Uint8Array> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Browser closed");
      const bytes = await this.options.page.screenshot({
        type: "jpeg",
        quality: 70,
        timeout: 10_000,
      });
      signal?.throwIfAborted();
      return ScreenshotBytes.parse(bytes);
    });
  }
  private async run(command: BrowserCommand, actor: Actor, signal?: AbortSignal): Promise<unknown> {
    const { page, cdp, dir, id, evaluatePolicy, threadId } = this.options;
    switch (command.action) {
      case "navigate":
        if (!(await this.options.navigatePolicy(command.url)))
          throw new Error("Browser origin requires approval");
        this.check(actor, signal);
        await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: command.timeout });
        return this.state;
      case "snapshot":
        return this.refs.snapshot();
      case "click": {
        const rect = await this.refs.bounds(command.ref);
        this.check(actor, signal);
        if (rect.width <= 0 || rect.height <= 0) throw new Error("Browser element is not visible");
        await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { ok: true };
      }
      case "type":
        await this.refs.select(command.ref);
        this.check(actor, signal);
        await page.keyboard.insertText(command.text);
        return { ok: true };
      case "press":
        if (command.ref) await this.refs.focus(command.ref);
        this.check(actor, signal);
        await page.keyboard.press(command.key);
        return { ok: true };
      case "scroll":
        await page.mouse.wheel(command.x, command.y);
        return { ok: true };
      case "wait_for":
        await this.refs.wait(command.ref, command.state, command.timeout);
        return { ok: true };
      case "screenshot": {
        const path = join(dir, `${id()}.png`);
        await page.screenshot({ path, timeout: 10_000 });
        return { path, mimeType: "image/png" };
      }
      case "logs":
        await this.logs.flush();
        return this.logs.paths;
      case "resize":
        await page.setViewportSize({ width: command.width, height: command.height });
        return { ok: true };
      case "emulate":
        await page.setViewportSize({ width: command.width, height: command.height });
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor,
          mobile: command.mobile,
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: command.touch });
        await page.emulateMedia({ colorScheme: command.colorScheme });
        return { ok: true };
      case "evaluate": {
        if (!(await evaluatePolicy?.(threadId, page.url())))
          throw new Error("Browser evaluate requires approval");
        this.check(actor, signal);
        return evaluatePage(cdp, command.expression);
      }
    }
  }
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    return this.enqueue(async () => {
      this.check({ kind: "human", connectionId });
      const cdp = this.options.cdp;
      switch (input.kind) {
        case "mouse":
          await cdp.send("Input.dispatchMouseEvent", {
            type: input.event,
            x: input.x,
            y: input.y,
            button: input.button,
            clickCount: input.clickCount,
          });
          break;
        case "scroll":
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          });
          break;
        case "key":
          if (input.event === "char")
            await cdp.send("Input.insertText", { text: input.text ?? input.key });
          else await cdp.send("Input.dispatchKeyEvent", keyEvent(input));
          break;
        case "touch":
          await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
          await cdp.send("Input.dispatchTouchEvent", {
            type: input.event,
            touchPoints: input.points,
          });
          break;
      }
    });
  }
  startRecording(): Promise<void> {
    return this.enqueue(async () => {
      if (this.recording) throw new Error("Recording already started");
      this.recording = await Recording.start(
        join(this.options.dir, this.options.id()),
        this.options.ffmpeg,
        undefined,
        this.options.spawn,
      );
      const data = await this.options.page.screenshot({
        type: "jpeg",
        quality: 70,
        timeout: 10_000,
      });
      const viewport = this.options.page.viewportSize() ?? { width: 1280, height: 720 };
      this.recording.accept({
        sequence: 0,
        timestamp: this.options.now(),
        data: data.toString("base64"),
        ...viewport,
      });
    });
  }
  stopRecording(): Promise<BrowserArtifact> {
    return this.enqueue(() => this.finishRecording());
  }
  private async finishRecording(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new Error("No browser recording");
    this.recording = undefined;
    const artifact = await recording.stop();
    await this.options.artifact(artifact);
    return artifact;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.options.cancelPolicy();
      this.controller = "none";
      this.owner = undefined;
      this.emit();
      // Detach capture synchronously, but do not wait for a CDP stop reply
      // before closing the transport that can abort that pending request.
      try {
        const stopped = this.live.close();
        try {
          await this.options.context.close();
        } finally {
          await stopped;
          await this.tail;
        }
      } finally {
        try {
          try {
            if (this.recording) await this.finishRecording();
          } finally {
            await this.logs.close();
          }
        } finally {
          await this.options.cleanup();
        }
      }
    })();
    return this.closing;
  }
}
