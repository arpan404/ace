import type {
  BrowserAnnotationCapture,
  BrowserAnnotationCaptureTarget,
  BrowserAnnotationConfig,
  BrowserAnnotationEvent,
  BrowserAnnotationPageCommand,
} from "@ace/protocol";

/**
 * Annotate mode on a thread's page (ADR 0082), as the daemon's browser relay offers it. Every
 * call needs this connection to hold the page's control lease; events reach only the
 * connection that started the mode, and only while it follows the thread's browser.
 */
export interface AnnotationDriver {
  start(
    threadId: string,
    config: Partial<BrowserAnnotationConfig>,
  ): Promise<{ documentId: string }>;
  stop(threadId: string): Promise<void>;
  command(threadId: string, command: BrowserAnnotationPageCommand): Promise<void>;
  capture(
    threadId: string,
    target: BrowserAnnotationCaptureTarget,
  ): Promise<BrowserAnnotationCapture>;
  /** Decoded overlay and daemon events for the thread; unknown kinds are skipped. */
  events(threadId: string, listener: (event: BrowserAnnotationEvent) => void): () => void;
}
