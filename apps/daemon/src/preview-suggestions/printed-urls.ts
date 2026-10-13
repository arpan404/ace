import { TerminalUrlScanner } from "@ace/preview/detection";

/*
 * Loopback addresses a thread's terminals and agent shells printed ("Local:
 * http://localhost:5173/"). A printed address is only a hint: it names the URL to open and
 * says to look for a listener now, but a server is suggested only once its port listens and
 * belongs to the thread. A hint lasts while its port listens; one whose port never listened is
 * forgotten after `ttlMs`, and one whose port stopped listening is forgotten at once.
 */

interface Hint {
  url: string;
  at: number;
  listened: boolean;
}

/** Scanners kept per thread (one per terminal or shell item); the oldest is dropped past it. */
const maxStreams = 32;
/** Printed ports remembered per thread. */
const maxHints = 32;

export class PrintedUrls {
  private readonly hints = new Map<string, Map<number, Hint>>();
  private readonly streams = new Map<string, Map<string, TerminalUrlScanner>>();
  private readonly ttlMs: number;
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  /** Scan output from one stream; returns the ports it newly printed. */
  feed(threadId: string, stream: string, chunk: string, now: number): number[] {
    const scanners = this.streams.get(threadId) ?? new Map<string, TerminalUrlScanner>();
    this.streams.set(threadId, scanners);
    let scanner = scanners.get(stream);
    if (!scanner) {
      scanner = new TerminalUrlScanner();
      scanners.set(stream, scanner);
      for (const oldest of scanners.keys()) {
        if (scanners.size <= maxStreams) break;
        scanners.delete(oldest);
      }
    }
    const found: number[] = [];
    for (let start = 0; start < chunk.length; start += 65_536)
      for (const href of scanner.feed(chunk.slice(start, start + 65_536))) {
        const url = new URL(href);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        const hints = this.hints.get(threadId) ?? new Map<number, Hint>();
        this.hints.set(threadId, hints);
        const known = hints.get(port);
        hints.delete(port);
        hints.set(port, { url: url.href, at: now, listened: known?.listened ?? false });
        for (const oldest of hints.keys()) {
          if (hints.size <= maxHints) break;
          hints.delete(oldest);
        }
        if (!known) found.push(port);
      }
    return found;
  }

  /** The printed address for a port, if the thread printed one. */
  url(threadId: string, port: number): string | undefined {
    return this.hints.get(threadId)?.get(port)?.url;
  }

  /** True while some printed port has not been seen listening yet. */
  waiting(): boolean {
    for (const hints of this.hints.values())
      for (const hint of hints.values()) if (!hint.listened) return true;
    return false;
  }

  /** Mark which ports listen now; forget hints whose server stopped or never came. */
  observe(listening: ReadonlySet<number>, now: number): void {
    for (const [threadId, hints] of this.hints) {
      for (const [port, hint] of hints) {
        if (listening.has(port)) hint.listened = true;
        else if (hint.listened || now - hint.at > this.ttlMs) hints.delete(port);
      }
      if (!hints.size) this.hints.delete(threadId);
    }
  }

  forget(threadId: string): void {
    this.hints.delete(threadId);
    this.streams.delete(threadId);
  }

  /** Stop scanning one stream (a terminal closed, a shell item finished). */
  close(threadId: string, stream: string): void {
    this.streams.get(threadId)?.delete(stream);
  }
}
