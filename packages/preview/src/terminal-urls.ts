import { z } from "zod";

const UrlText = z.string().max(4096);
const delimiter = /[\s<>"'`]/;

export function loopbackUrl(value: unknown): URL {
  const url = new URL(UrlText.parse(value));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Preview URL must use loopback HTTP(S)");
  }
  return url;
}
/** Feed terminal chunks directly. No retained transcript or growing deduplication set. */
export class TerminalUrlScanner {
  #tail = "";
  feed(chunk: string): string[] {
    if (chunk.length > 65_536) throw new Error("Terminal chunk exceeds limit");
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequences
    const text = (this.#tail + chunk).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const found: string[] = [];
    const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s<>"'`]*[\s<>"'`]/g;
    for (const match of text.matchAll(pattern)) {
      const candidate = match[0].slice(0, -1).replace(/[),.;]+$/, "");
      try {
        found.push(loopbackUrl(candidate).href);
      } catch {
        /* Not a URL suggestion. */
      }
    }
    // Keep only the unfinished last token, including a partially printed scheme.
    let start = text.length;
    const floor = Math.max(0, start - 8192);
    while (start > floor && !delimiter.test(text.charAt(start - 1))) start--;
    this.#tail = text.slice(start);
    return found;
  }
  flush(): string[] {
    return this.feed("\n");
  }
}
