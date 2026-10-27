import type { ClientCore } from "@ace/client";
import {
  BrowserAnnotationCapture,
  BrowserAnnotationEvent,
  browserAnnotationLimit,
  type BrowserAnnotationCaptureTarget,
  type BrowserAnnotationPageCommand,
  type BrowserCommand,
  type BrowserState,
  type ServerMessage,
  type ThreadId,
} from "@ace/protocol";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { reason } from "./browser-tools.ts";
import type { Schedule } from "./browser-live.ts";
import type { ThreadAnnotations } from "./thread-annotations.ts";
import type { Picked } from "./thread-attachments.ts";

/*
 * Annotate mode on the thread's page from the phone (ADR 0082). The overlay lives in the page,
 * so a tap pins the element under it and a drag outlines an area, exactly as a click and a drag
 * do on the desktop; the comment editor is the page's own, typed into with the phone's keyboard.
 * Every pinned comment joins the thread's next message (`thread-annotations.ts`) with its crop,
 * and the page's screenshot follows once the page settles. Leaving the mode (Done, the page's
 * close button or Send, a navigation, another screen annotating) ends it; agents keep working.
 */

export const AnnotateAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("annotate"), on: z.boolean(), theme: z.enum(["light", "dark"]) }),
  /** Reopen an annotation's editor on the page (its chip in the composer). */
  z.object({ kind: z.literal("annotateEdit"), id: z.string().min(1).max(128) }),
]);
export type AnnotateAction = z.infer<typeof AnnotateAction>;

/** How long the page settles after a change before its screenshot is taken again. */
const pageSettleMs = 400;

/** Stages a captured image on the phone as a message file (`Sources/Bridge/AttachmentStaging`). */
export type ImageStager = (name: string, mimeType: string, data: string) => Promise<Picked>;

export interface AnnotateHost {
  owner: Pick<ClientCore, "request">;
  sink: PatchSink;
  schedule: Schedule;
  stage: ImageStager;
  /** The open thread's draft annotations, when the thread on screen is `threadId`. */
  draft(threadId: string): ThreadAnnotations | undefined;
  current(): { threadId: ThreadId; state: BrowserState | undefined } | undefined;
  now(): number;
  /** The mode changed: the view says so. */
  changed(): void;
}

type Mode = "off" | "starting" | "on";

export class BrowserAnnotate {
  #host: AnnotateHost;
  #mode: Mode = "off";
  #threadId: string | undefined;
  #url: string | undefined;
  #tabId: string | undefined;
  #edit: string | undefined;
  #timer: (() => void) | undefined;
  #theme: "light" | "dark" = "dark";
  constructor(host: AnnotateHost) {
    this.#host = host;
  }
  get mode(): Mode {
    return this.#mode;
  }
  handle(action: AnnotateAction): void {
    if (action.kind === "annotate") {
      this.#theme = action.theme;
      if (action.on) void this.#start();
      else this.stop();
      return;
    }
    if (this.#mode === "on") void this.#command({ op: "edit", id: action.id });
    else {
      this.#edit = action.id;
      void this.#start();
    }
  }
  /** The view closed or moved to another thread: the page's overlay goes too. */
  close(): void {
    this.stop();
  }
  stop(): void {
    if (this.#mode === "off") return;
    const threadId = this.#threadId;
    if (threadId)
      void this.#execute(threadId, { action: "annotate", operation: "stop" }).catch(() => {});
    this.#finish();
  }
  /** The daemon's annotate events for this phone's session. */
  receive(message: ServerMessage): void {
    if (message.type !== "browser.annotation" || message.threadId !== this.#threadId) return;
    const event = BrowserAnnotationEvent.safeParse(message.event);
    if (!event.success) return;
    const threadId = message.threadId;
    const draft = this.#host.draft(threadId);
    const value = event.data;
    switch (value.kind) {
      case "ready": {
        this.#mode = "on";
        this.#url = value.url;
        this.#tabId = this.#host.current()?.state?.activeTabId;
        this.#host.changed();
        const shown = draft?.annotations().filter((annotation) => annotation.url === value.url);
        if (shown?.length) void this.#command({ op: "restore", annotations: shown });
        const edit = this.#edit;
        this.#edit = undefined;
        if (edit) void this.#command({ op: "edit", id: edit });
        return;
      }
      case "saved": {
        if (!draft) return;
        const tabId = value.annotation.tabId ?? this.#tabId;
        const annotation = tabId ? { ...value.annotation, tabId } : value.annotation;
        const known = draft.annotations().some((each) => each.id === annotation.id);
        draft.save(
          annotation,
          known
            ? undefined
            : this.#capture(
                threadId,
                { kind: "annotation", id: annotation.id },
                `annotation-${annotation.number}`,
              ),
        );
        this.#schedulePage();
        return;
      }
      case "removed":
        draft?.removedOnPage(value.id);
        this.#schedulePage();
        return;
      case "discard":
        draft?.clearedOnPage();
        return;
      case "screenshot":
        void this.#screenshot(threadId);
        return;
      case "send":
        // The page's Send: annotating ends and the phone goes to the message.
        this.#flushPage();
        this.#host.sink.put("browser:annotate-send", () => ({
          type: "browser.annotateSend",
          at: this.#host.now(),
        }));
        this.stop();
        return;
      case "bar":
        return;
      case "close":
      case "ended":
        this.#finish();
        return;
    }
  }

  async #start(): Promise<void> {
    const current = this.#host.current();
    if (!current || this.#mode !== "off") return;
    const draft = this.#host.draft(current.threadId);
    this.#threadId = current.threadId;
    this.#mode = "starting";
    this.#host.changed();
    // The draft's annotations, so the page's markers wire up to them.
    if (draft) draft.overlay = this.#overlay(current.threadId);
    const numbers = draft?.annotations().map((annotation) => annotation.number) ?? [];
    try {
      await this.#execute(current.threadId, {
        action: "annotate",
        operation: "start",
        config: { theme: this.#theme, nextNumber: Math.min(99, Math.max(0, ...numbers) + 1) },
      });
    } catch (error) {
      if (this.#threadId !== current.threadId || this.#mode !== "starting") return;
      this.#finish();
      this.#problem(`Couldn't start annotating. ${reason(error)}`);
    }
  }
  #overlay(threadId: string) {
    return {
      removed: (rest: readonly { id: string; number: number }[], id: string) => {
        if (this.#mode !== "on" || this.#threadId !== threadId) return;
        void this.#command({ op: "remove", id });
        void this.#command({
          op: "renumber",
          numbers: rest
            .slice(0, browserAnnotationLimit)
            .map((each) => ({ id: each.id, number: each.number })),
        });
        void this.#command({
          op: "configure",
          theme: this.#theme,
          nextNumber: Math.min(99, rest.length + 1),
        });
        this.#schedulePage();
      },
      cleared: () => {
        if (this.#mode !== "on" || this.#threadId !== threadId) return;
        void this.#command({ op: "clear" });
      },
    };
  }
  #finish(): void {
    this.#timer?.();
    this.#timer = undefined;
    const changed = this.#mode !== "off";
    this.#mode = "off";
    this.#url = undefined;
    this.#edit = undefined;
    if (changed) this.#host.changed();
  }
  #schedulePage(): void {
    this.#timer?.();
    this.#timer = this.#host.schedule(pageSettleMs, () => {
      this.#timer = undefined;
      this.#capturePage();
    });
  }
  #flushPage(): void {
    if (!this.#timer) return;
    this.#timer();
    this.#timer = undefined;
    this.#capturePage();
  }
  #capturePage(): void {
    const threadId = this.#threadId;
    const url = this.#url;
    if (!threadId || !url || this.#mode !== "on") return;
    const draft = this.#host.draft(threadId);
    const numbers = draft
      ?.annotations()
      .filter((each) => each.url === url)
      .map((each) => each.number);
    if (!draft || !numbers?.length) return;
    draft.pageShot(
      url,
      this.#capture(threadId, { kind: "page" }, `annotated-page-${Math.min(...numbers)}`),
    );
  }
  /** An image from the page, staged on the phone; undefined when it can't be taken. */
  async #capture(
    threadId: string,
    target: BrowserAnnotationCaptureTarget,
    name: string,
  ): Promise<Picked | undefined> {
    try {
      const raw = await this.#execute(threadId, { action: "annotate_capture", target });
      const capture = BrowserAnnotationCapture.parse(raw);
      const extension = capture.mimeType === "image/png" ? "png" : "jpg";
      return await this.#host.stage(`${name}.${extension}`, capture.mimeType, capture.data);
    } catch {
      return undefined;
    }
  }
  /** The page with its markers, shown as a screenshot the person can share. */
  async #screenshot(threadId: string): Promise<void> {
    try {
      const raw = await this.#execute(threadId, {
        action: "annotate_capture",
        target: { kind: "page" },
      });
      const capture = BrowserAnnotationCapture.parse(raw);
      this.#host.sink.put("browser:shot", () => ({
        type: "browser.shot",
        at: this.#host.now(),
        data: capture.data,
        path: "",
      }));
    } catch (error) {
      this.#problem(`Couldn't take a screenshot. ${reason(error)}`);
    }
  }
  #command(command: BrowserAnnotationPageCommand): Promise<unknown> {
    const threadId = this.#threadId;
    if (!threadId) return Promise.resolve();
    return this.#execute(threadId, { action: "annotate", operation: "command", command }).catch(
      () => {},
    );
  }
  async #execute(threadId: string, command: BrowserCommand): Promise<unknown> {
    const current = this.#host.current();
    if (!current || current.threadId !== threadId) throw new Error("The browser isn't open.");
    const reply = await this.#host.owner.request({
      type: "browser.execute",
      threadId: current.threadId,
      command,
    });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  }
  #problem(message: string): void {
    this.#host.sink.put("browser:problem", () => ({
      type: "browser.problem",
      at: this.#host.now(),
      message,
    }));
  }
}
