import type { FakeSpadeAnswer } from "./spade.ts";

export interface FakeMediaBody {
  body: string;
  contentType: string;
  encoding?: "text" | "base64";
  /** Extracted text returned by `GET /v1/documents/{id}/text`. */
  text?: string;
}

/** Optional richer fake bodies for images, documents, and workspace timestamps. */
export class FakeSpadeMedia {
  readonly imageBodies = new Map<string, { body: string; encoding?: "text" | "base64" }>();
  readonly documentBodies = new Map<string, FakeMediaBody>();
  /** Modified timestamps (ms) for workspace files, by agent id -> path -> ms. */
  readonly fileTimes = new Map<string, Record<string, number>>();

  imageAnswer(id: string | undefined, contentType: string | undefined): FakeSpadeAnswer {
    if (!id || !contentType) return { status: 404, body: "" };
    const stored = this.imageBodies.get(id);
    if (!stored) return { status: 200, body: `bytes of ${id}`, contentType };
    return {
      status: 200,
      body: stored.body,
      ...(stored.encoding ? { encoding: stored.encoding } : {}),
      contentType,
    };
  }

  documentAnswer(id: string, sub: string | undefined): FakeSpadeAnswer {
    const stored = this.documentBodies.get(id);
    if (sub === "text") {
      const text = stored?.text ?? `Extracted text of ${id}`;
      return {
        status: 200,
        body: JSON.stringify({ text, total_chars: text.length, next_offset: null }),
        contentType: "application/json",
      };
    }
    if (!stored) {
      return { status: 200, body: `bytes of ${id}`, contentType: "application/octet-stream" };
    }
    return {
      status: 200,
      body: stored.body,
      ...(stored.encoding ? { encoding: stored.encoding } : {}),
      contentType: stored.contentType,
    };
  }

  downloadWorkspaceFile(path: string, content: string): FakeSpadeAnswer {
    const lower = path.toLowerCase();
    const contentType = lower.endsWith(".svg")
      ? "image/svg+xml"
      : lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
          ? "image/jpeg"
          : lower.endsWith(".webp")
            ? "image/webp"
            : lower.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream";
    return { status: 200, body: content, contentType };
  }

  modifiedAt(agent: string, path: string): number | null {
    const times = this.fileTimes.get(agent);
    if (!times) return null;
    if (times[path] !== undefined) return times[path];
    // For folders, use the newest file timestamp under that folder.
    const prefix = `${path}/`;
    let newest: number | null = null;
    for (const [name, time] of Object.entries(times)) {
      if (name.startsWith(prefix) && (newest === null || time > newest)) newest = time;
    }
    return newest;
  }
}
