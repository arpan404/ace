import {
  suitAssetReplyBytes,
  type SuitActive,
  type SuitClientMessage,
  type SuitDetail,
  type SuitResponse,
  type SuitServerMessage,
} from "@ace/protocol/suits";
import { contentHash, inspectSuit, plan, type InspectedSuit } from "@ace/suits/folder";

/*
 * The daemon's Suit library (ADR 0150) for fixtures: folders held in memory and checked by the
 * real `@ace/suits/folder`, listed, read and served asset by asset over the socket. Tests change
 * the library or send an agent's `suitActive` by hand. Served URLs aren't reachable here.
 */

/** One Suit folder: path inside the folder → bytes. */
export interface FakeSuitFolder {
  id: string;
  files: Readonly<Record<string, Uint8Array | string>>;
}

interface Held {
  inspected: InspectedSuit;
  files: Map<string, Uint8Array>;
}

const encoder = new TextEncoder();

function hold(folder: FakeSuitFolder): Held {
  const files = new Map(
    Object.entries(folder.files).map(([path, data]) => [
      path,
      typeof data === "string" ? encoder.encode(data) : data,
    ]),
  );
  const walk = plan([...files].map(([path, data]) => ({ path, kind: "file", size: data.length })));
  const read = new Map([...files].filter(([path]) => walk.read.includes(path)));
  return { inspected: inspectSuit(folder.id, read, walk), files: read };
}

const types: Record<string, string> = {
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

export class FakeSuits {
  #held = new Map<string, Held>();
  #sessions = new Set<(message: SuitServerMessage) => void>();

  /** Replaces the library and tells every session, as the daemon's watcher does. */
  set(folders: readonly FakeSuitFolder[]): void {
    this.#held = new Map(folders.map((folder) => [folder.id, hold(folder)]));
    const suits = this.#summaries();
    for (const send of this.#sessions) send({ type: "suitsChanged", suits });
  }

  /** What an agent's `suit_apply` sends this device. */
  active(active: SuitActive): void {
    for (const send of this.#sessions) send({ type: "suitActive", active });
  }

  session(send: (message: SuitServerMessage) => void): {
    handle(message: SuitClientMessage): void;
    close(): void;
  } {
    this.#sessions.add(send);
    return {
      handle: (message) =>
        send({
          type: "suitResult",
          requestId: message.requestId,
          response: this.#answer(message.request),
        }),
      close: () => this.#sessions.delete(send),
    };
  }

  #summaries() {
    return [...this.#held.values()]
      .map((held) => held.inspected.summary)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  #answer(request: SuitClientMessage["request"]): SuitResponse {
    if (request.op === "list") return { op: "list", suits: this.#summaries() };
    const held = this.#held.get(request.id);
    if (!held) return { op: "error", code: "not_found", message: `There is no Suit ${request.id}` };
    const { summary, manifest } = held.inspected;
    switch (request.op) {
      case "validate":
        return { op: "validate", summary };
      case "remove":
        this.set(
          [...this.#held.keys()].filter((id) => id !== request.id).map((id) => this.#folder(id)),
        );
        return { op: "remove", removed: true };
      case "read": {
        if (!manifest) return { op: "error", code: "invalid", message: "suit.json", summary };
        const assets: SuitDetail["assets"] = {};
        for (const path of held.files.keys())
          if (path.startsWith("assets/")) assets[path] = `/v1/suits/${request.id}/${path}`;
        return {
          op: "read",
          suit: {
            summary,
            manifest,
            sceneUrl: null,
            sceneUrls: {},
            assets,
            css: null,
            ornaments: {},
          },
        };
      }
      case "asset": {
        const bytes = held.files.get(request.path);
        if (
          !bytes ||
          summary.contentHash !== request.contentHash ||
          !request.path.startsWith("assets/")
        )
          return { op: "error", code: "not_found", message: `There is no ${request.path}` };
        if (bytes.length > suitAssetReplyBytes)
          return { op: "error", code: "failed", message: `${request.path} is too large` };
        return {
          op: "asset",
          path: request.path,
          mimeType: types[request.path.split(".").pop() ?? ""] ?? "application/octet-stream",
          data: Buffer.from(bytes).toString("base64"),
        };
      }
    }
  }

  #folder(id: string): FakeSuitFolder {
    return { id, files: Object.fromEntries(this.#held.get(id)?.files ?? []) };
  }
}

/** The hash a folder's files get, for tests naming one version. */
export const fakeSuitHash = (files: FakeSuitFolder["files"]) =>
  contentHash(
    new Map(
      Object.entries(files).map(([path, data]) => [
        path,
        typeof data === "string" ? encoder.encode(data) : data,
      ]),
    ),
  );
