import { NavigationPolicies } from "./policy-waits.ts";
import { BrowserActionError } from "./action-error.ts";
import { waitForBrowser } from "./wait.ts";
import { BrowserOriginError, browserOrigin } from "./policy.ts";
import { z } from "zod";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { BrowserBackendSession, BrowserBackend } from "./backend.ts";
import type { BrowserOriginBlock, BrowserControllerLease } from "@ace/protocol";
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
import { NavigationTask, type NavigationClock } from "./navigation.ts";

export type Actor = { kind: "agent" } | { kind: "human"; connectionId: string };
export interface SessionOptions {
  threadId: ThreadId;
  backend: BrowserBackendSession;
  backendKind: BrowserBackend["kind"];
  dir: string;
  now: () => number;
  id: () => string;
  navigationClock: NavigationClock;
  ffmpeg?: string;
  spawn?: ProcessSpawner;
  cancelPolicy: () => void;
  navigatePolicy: (url: string, actor: Actor, signal?: AbortSignal) => Promise<boolean>;
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
  private paused = false;
  private blocked: BrowserOriginBlock | undefined;
  private policies = new NavigationPolicies();
  get navigationTask(): NavigationTask | undefined {
    return this.policies.task;
  }
  initiatingHuman(): boolean {
    return this.policies.task?.human ?? this.controller === "human";
  }
  blockedNavigation(blocked: BrowserOriginBlock, navigation?: NavigationTask): void {
    // A cancelled policy may settle after the next queued navigation starts.
    if (navigation && navigation !== this.policies.task) return;
    if (navigation) navigation.blocked = blocked;
    this.blocked = blocked;
    this.emit();
  }
  policyWait(url: string): () => void {
    return this.policies.wait(url);
  }
  private lastUrl: string | undefined;
  private reason: string | undefined;
  private pageStateLost = false;
  private generation = 0;
  private leaseReady: Promise<void> = Promise.resolve();
  private syncLease(): void {
    const lease: BrowserControllerLease = {
      generation: ++this.generation,
      controller: this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
    };
    const backend = this.options.backend;
    this.leaseReady = backend.controller(lease);
    void this.leaseReady.catch((error) => {
      if (lease.generation === this.generation)
        this.suspend(error instanceof Error ? error.message : "Controller lease failed");
    });
  }
  navigation(): void {
    this.blocked = undefined;
    this.refs.invalidate();
    this.emit();
  }
  log(entry: { kind: "console" | "network"; type: string; text: string }): void {
    this.logs.append(entry.kind, { at: this.options.now(), type: entry.type, text: entry.text });
  }
  suspend(reason: string): void {
    if (this.closed || this.paused) return;
    this.lastUrl = this.options.backend.url();
    this.paused = true;
    this.reason = reason.slice(0, 2048);
    this.pageStateLost = true;
    this.generation++;
    this.refs.invalidate();
    this.live.detach();
    this.emit();
  }
  recoveryFailed(reason: string): void {
    this.reason = `Headless recovery failed: ${reason}`.slice(0, 2048);
    this.paused = true;
    this.emit();
  }
  async replace(backend: BrowserBackendSession): Promise<void> {
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    await this.tail;
    if (this.closed) {
      await backend.close();
      throw new Error("Browser closed during recovery");
    }
    await this.options.backend.close().catch(() => {});
    this.options.backend = backend;
    this.options.backendKind = "headless";
    this.refs.replace(backend.cdp);
    this.leaseReady = Promise.resolve();
    this.syncLease();
    await this.leaseReady;
    await this.live.replace(backend.cdp);
    this.lastUrl = undefined;
    this.paused = false;
    this.reason = "Recovered in headless browser; page state was lost";
    this.emit();
  }
  constructor(options: SessionOptions) {
    this.options = options;
    this.refs = new SnapshotRefs(options.backend.cdp);
    this.logs = new SessionLogs(options.dir);
    this.live = new LiveCapture(options.backend.cdp, options.now, (frame) =>
      this.recording?.accept(frame),
    );
  }

  get state(): BrowserState {
    return {
      threadId: this.options.threadId,
      controller: this.paused ? "none" : this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
      url: (this.lastUrl ?? this.options.backend.url()).slice(0, 8192),
      backend: this.options.backendKind,
      status: this.paused ? "paused" : "ready",
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.pageStateLost ? { pageStateLost: true } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
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
    if (this.owner === connectionId) return this.state;
    this.controller = "human";
    this.owner = connectionId;
    if (!this.paused) this.syncLease();
    this.emit();
    return this.state;
  }
  handback(connectionId: string): BrowserState {
    if (this.owner !== connectionId) throw new Error("Browser controller mismatch");
    this.controller = "agent";
    this.owner = undefined;
    if (!this.paused) this.syncLease();
    this.emit();
    return this.state;
  }
  disconnect(connectionId: string): void {
    if (this.owner === connectionId) this.handback(connectionId);
  }
  private check(actor: Actor, signal?: AbortSignal, generation = this.generation): void {
    signal?.throwIfAborted();
    if (generation !== this.generation)
      throw new BrowserActionError(
        "controller_changed",
        "Browser control changed while the action was queued",
        "Take a fresh snapshot and retry after control is handed back.",
      );
    if (this.closed) throw new Error("Browser closed");
    if (this.paused) throw new Error(this.reason ?? "Browser backend paused");
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
    const submittedGeneration = this.generation;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Browser closed");
      if (inputActions.has(command.action)) {
        this.check(actor, signal, submittedGeneration);
      }
      if (this.paused) throw new Error(this.reason ?? "Browser backend paused");
      const generation = this.generation;
      if (inputActions.has(command.action)) {
        await this.leaseReady;
        this.check(actor, signal, submittedGeneration);
      }
      let result: unknown;
      try {
        result = await this.run(command, actor, signal, submittedGeneration);
      } catch (error) {
        if (error instanceof BrowserOriginError) this.blockedNavigation(error.blocked);
        throw error;
      }
      if (this.paused || (generation !== this.generation && this.pageStateLost))
        throw new Error("Browser backend changed during command");
      return result;
    });
  }
  screenshot(signal?: AbortSignal): Promise<Uint8Array> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Browser closed");
      if (this.paused) throw new Error(this.reason ?? "Browser backend paused");
      const generation = this.generation;
      const bytes = await this.options.backend.screenshot("jpeg");
      signal?.throwIfAborted();
      if (this.paused || (generation !== this.generation && this.pageStateLost))
        throw new Error("Browser backend changed during screenshot");
      return ScreenshotBytes.parse(bytes);
    });
  }
  private async run(
    command: BrowserCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<unknown> {
    const { backend: page, dir, id, evaluatePolicy, threadId } = this.options;
    const cdp = page.cdp;
    switch (command.action) {
      case "navigate": {
        if (!/^https?:\/\//i.test(command.url) || !browserOrigin(command.url))
          throw new BrowserOriginError(
            command.url,
            "invalid_origin",
            "Browser navigation requires an HTTP(S) URL without credentials",
          );
        const task = new NavigationTask(
          actor.kind === "human",
          command.timeout,
          this.options.navigationClock,
          signal,
        );
        this.policies.start(task);
        this.blocked = undefined;
        try {
          const resume = task.pause();
          let allowed: boolean;
          try {
            allowed = await task.run(() =>
              this.options.navigatePolicy(command.url, actor, task.signal),
            );
          } finally {
            resume();
          }
          if (!allowed)
            throw new BrowserOriginError(
              browserOrigin(command.url) ?? command.url,
              browserOrigin(command.url) ? "approval_required" : "invalid_origin",
              "Browser origin requires approval",
            );
          this.check(actor, task.signal, generation);
          await task.run(() => page.navigate(command.url, command.timeout + 65_000, task.signal));
          return this.state;
        } catch (error) {
          if (task.blocked)
            throw new BrowserOriginError(
              task.blocked.origin,
              task.blocked.reason,
              error instanceof Error ? error.message : "Browser navigation blocked",
            );
          if (task.deadlineExpired)
            throw new BrowserOriginError(
              task.expiredOrigin ?? browserOrigin(command.url) ?? command.url,
              "timeout",
              error instanceof Error ? error.message : "Browser navigation timed out",
            );
          throw error;
        } finally {
          // Only this page is stopped; sibling sessions share no cancellation.
          if (task.signal.aborted) void page.cdp.send("Page.stopLoading").catch(() => {});
          task.close();
          this.policies.finish(task);
        }
      }
      case "snapshot":
        return this.refs.snapshot();
      case "click": {
        const rect = await this.refs.bounds(command.ref);
        this.check(actor, signal, generation);
        if (rect.width <= 0 || rect.height <= 0) throw new Error("Browser element is not visible");
        await page.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { ok: true };
      }
      case "type":
        await this.refs.select(command.ref);
        this.check(actor, signal, generation);
        await page.insertText(command.text);
        return { ok: true };
      case "press":
        if (command.ref) await this.refs.focus(command.ref);
        this.check(actor, signal, generation);
        await page.press(command.key);
        return { ok: true };
      case "scroll":
        await page.wheel(command.x, command.y);
        return { ok: true };
      case "wait_for":
        return waitForBrowser({
          command,
          cdp,
          refs: this.refs,
          clock: this.options.navigationClock,
          policies: this.policies,
          human: actor.kind === "human",
          signal,
          currentUrl: () => page.url(),
          checkNavigation: () => {
            if (this.blocked)
              throw new BrowserOriginError(
                this.blocked.origin,
                this.blocked.reason,
                "Browser navigation blocked while waiting",
              );
          },
        });
      case "screenshot": {
        const path = join(dir, `${id()}.png`);
        await writeFile(path, await page.screenshot("png"), { mode: 0o600 });
        return { path, mimeType: "image/png" };
      }
      case "logs":
        await this.logs.flush();
        return this.logs.paths;
      case "resize":
        await page.resize(command.width, command.height);
        return { ok: true };
      case "emulate":
        await page.resize(command.width, command.height);
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor,
          mobile: command.mobile,
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: command.touch });
        await page.media(command.colorScheme);
        return { ok: true };
      case "evaluate": {
        if (!(await evaluatePolicy?.(threadId, page.url())))
          throw new Error("Browser evaluate requires approval");
        this.check(actor, signal, generation);
        return evaluatePage(cdp, command.expression);
      }
    }
  }
  input(raw: unknown, connectionId: string): Promise<void> {
    const input = BrowserInput.parse(raw);
    const generation = this.generation;
    return this.enqueue(async () => {
      this.check({ kind: "human", connectionId }, undefined, generation);
      await this.leaseReady;
      this.check({ kind: "human", connectionId }, undefined, generation);
      const cdp = this.options.backend.cdp;
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
      if (this.paused) throw new Error("Browser backend paused");
      if (this.recording) throw new Error("Recording already started");
      this.recording = await Recording.start(
        join(this.options.dir, this.options.id()),
        this.options.ffmpeg,
        undefined,
        this.options.spawn,
      );
      const data = await this.options.backend.screenshot("jpeg");
      const viewport = this.options.backend.viewport();
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
          await this.options.backend.close();
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
