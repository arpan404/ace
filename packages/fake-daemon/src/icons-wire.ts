import type { ClientMessage, ServerMessage, ToolIcon } from "@ace/protocol";
import { fixtureIcons } from "./icon-fixtures.ts";

/** A stable 64-hex stand-in for the PNG's SHA-256 (fake mode only needs it unique and stable). */
function fakeRef(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index++) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

/** `icons.resolve` and `icons.read` over a few fixture favicons and app icons. */
export class FakeIcons {
  private readonly byRef = new Map<string, string>();
  private readonly byKey = new Map<string, string>();
  constructor(icons: Record<string, string> = fixtureIcons) {
    for (const [key, data] of Object.entries(icons)) {
      const ref = fakeRef(data);
      this.byRef.set(ref, data);
      this.byKey.set(key, ref);
    }
  }

  ref(icon: ToolIcon): string | undefined {
    if (icon.kind === "app") return this.byKey.get(`app:${icon.identity}`);
    const host = icon.origin.replace(/^https?:\/\/(www\.)?/, "https://");
    return this.byKey.get(`site:${icon.origin}`) ?? this.byKey.get(`site:${host}`);
  }

  handle(message: ClientMessage, send: (message: ServerMessage) => void): boolean {
    if (message.type === "icons.resolve") {
      send({
        type: "icons.resolve",
        requestId: message.requestId,
        refs: message.icons.map((icon) => this.ref(icon) ?? null),
      });
      return true;
    }
    if (message.type !== "icons.read") return false;
    const data = this.byRef.get(message.ref);
    send(
      data
        ? {
            type: "icons.read",
            requestId: message.requestId,
            ref: message.ref,
            mimeType: "image/png",
            data,
          }
        : { type: "error", requestId: message.requestId, code: "not_found", message: "not_found" },
    );
    return true;
  }
}
