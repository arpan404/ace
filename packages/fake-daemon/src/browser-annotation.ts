import {
  BrowserAnnotation,
  ThreadId,
  type BrowserAnnotationCapture,
  type BrowserAnnotationEndReason,
  type BrowserAnnotationEvent,
  type BrowserAnnotationMessage,
  type BrowserCommand,
} from "@ace/protocol";

/** A 160×100 PNG: a light page with one accent block, so thumbnails have something to show. */
const capturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAA1ElEQVR42u3cQQ0AIAwEwUqqKdxip+kXB30TmGQV3PwvqloPFyYALMACLMACLMACDFiABViABViABRiwAAuwAAuwAAuwAAMWYAEWYAEWYF0DnGt/FWDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGBHaAIMWIAFWIAFWIAFGLAAC7AAC7AAC7AAAxZgARZgARZgAQYswAIswAIswBo6oFI38LSff2gAAAAASUVORK5CYII=";

type AnnotationCommand = Extract<BrowserCommand, { action: "annotate" | "annotate_capture" }>;
interface Page {
  url: string;
  annotation?: { owner: string };
}

/**
 * Annotate mode (ADR 0082) as a client sees it from the daemon: `ready` on start, `ended` when
 * the page, lease or connection changes, events only to the starting connection. There is no
 * page, so what the overlay would report is scripted with `emit` and `pin`.
 */
export class FakeAnnotations {
  private sinks = new Map<string, (message: BrowserAnnotationMessage) => void>();
  private documents = new Map<string, { id: string; numbers: number }>();
  private sequence = 0;
  private page: (threadId: string) => Page | undefined;
  private changed: () => void;
  constructor(page: (threadId: string) => Page | undefined, changed: () => void) {
    this.page = page;
    this.changed = changed;
  }
  /** A client connection's channel for the annotation events it owns. */
  connect(connectionId: string, send: (message: BrowserAnnotationMessage) => void): () => void {
    this.sinks.set(connectionId, send);
    return () => {
      if (this.sinks.get(connectionId) === send) this.sinks.delete(connectionId);
    };
  }
  owner(threadId: string): string | undefined {
    return this.page(threadId)?.annotation?.owner;
  }
  /** As the daemon's browser service, after its lease check: only the holder gets here. */
  execute(threadId: string, connectionId: string, command: AnnotationCommand): unknown {
    const page = this.page(threadId);
    if (!page) throw new Error("Browser session not open");
    if (command.action === "annotate" && command.operation === "start") {
      const current = this.documents.get(threadId);
      if (current && page.annotation?.owner === connectionId) return { documentId: current.id };
      this.end(threadId, "stopped");
      const id = `fake-document-${++this.sequence}`;
      this.documents.set(threadId, { id, numbers: command.config.nextNumber - 1 });
      page.annotation = { owner: connectionId };
      this.changed();
      this.emit(threadId, { kind: "ready", documentId: id, url: page.url, title: "Fixture page" });
      return { documentId: id };
    }
    if (command.action === "annotate" && command.operation === "stop") {
      if (page.annotation?.owner === connectionId) this.end(threadId, "stopped");
      return { ok: true };
    }
    if (page.annotation?.owner !== connectionId)
      throw new Error("Annotate mode is not active on this page");
    if (command.action === "annotate") return { ok: true };
    const capture: BrowserAnnotationCapture = {
      mimeType: "image/png",
      data: capturePng,
      width: 160,
      height: 100,
    };
    return capture;
  }
  /** Scripting: what the page's overlay would report, sent to the annotating connection. */
  emit(threadId: string, event: BrowserAnnotationEvent): void {
    const owner = this.owner(threadId);
    if (!owner) return;
    this.sinks.get(owner)?.({
      type: "browser.annotation",
      threadId: ThreadId.parse(threadId),
      event,
    });
    if (event.kind === "close") this.end(threadId, "stopped");
  }
  /** Scripting: the person pins a comment on an element; returns the saved record. */
  pin(
    threadId: string,
    pinned: {
      comment: string;
      tag?: string;
      text?: string;
      selector?: string;
      styles?: { property: string; before: string; after: string }[];
      textChange?: { before: string; after: string };
    },
  ): BrowserAnnotation {
    const document = this.documents.get(threadId);
    const page = this.page(threadId);
    if (!document || !page?.annotation) throw new Error("Annotate mode is not active");
    const tag = pinned.tag ?? "p";
    const annotation = BrowserAnnotation.parse({
      id: `fake-annotation-${++this.sequence}`,
      number: ++document.numbers,
      documentId: document.id,
      url: page.url,
      title: "Fixture page",
      point: { x: 0.5, y: 0.5 },
      comment: pinned.comment,
      element: {
        tag,
        selector: pinned.selector ?? `main > ${tag}`,
        xpath: `/html/body/main/${tag}`,
        text: pinned.text ?? "Fixture text",
        box: { x: 40, y: 120, width: 320, height: 24 },
      },
      viewport: { width: 760, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
      styles: pinned.styles ?? [],
      ...(pinned.textChange ? { text: pinned.textChange } : {}),
    });
    this.emit(threadId, { kind: "saved", annotation });
    return annotation;
  }
  /** The page, lease, tab or connection changed: annotate mode ends for its owner. */
  end(threadId: string, reason: BrowserAnnotationEndReason): void {
    const page = this.page(threadId);
    const owner = page?.annotation?.owner;
    this.documents.delete(threadId);
    if (!page || !owner) return;
    delete page.annotation;
    this.sinks.get(owner)?.({
      type: "browser.annotation",
      threadId: ThreadId.parse(threadId),
      event: { kind: "ended", reason },
    });
    this.changed();
  }
  /** A connection went away: end whatever it was annotating. */
  disconnect(connectionId: string, threads: Iterable<string>): void {
    for (const threadId of threads)
      if (this.owner(threadId) === connectionId) this.end(threadId, "disconnect");
    this.sinks.delete(connectionId);
  }
}
