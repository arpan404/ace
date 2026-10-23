import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { connectHost, HostCallError, installWebPlatform, requester } from "./index.ts";
import { createNodeHost } from "./node.ts";

describe("the native host contract", () => {
  it("refuses at start a host that lacks a required function, naming it", () => {
    const host = createNodeHost();
    expect(() => connectHost({ ...host, utf8Length: undefined })).toThrow(/utf8Length missing/);
    expect(() => connectHost({ ...host, version: 0 })).toThrow(/version 0/);
    expect(() => connectHost(undefined)).toThrow(/missing/);
    expect(connectHost(host)).toBe(host);
  });

  it("refuses a host that lists a capability it does not implement", () => {
    const host = createNodeHost({ without: ["inflate"] });
    expect(() => connectHost({ ...host, capabilities: ["inflate"] })).toThrow(/inflate listed/);
  });

  it("carries a large body to native unescaped and rejects failures with their code", async () => {
    const host = createNodeHost();
    const bodies: (string | undefined)[] = [];
    host.handle("snapshot.set", (input, body) => {
      expect(input).toEqual({ key: "inbox" });
      bodies.push(body);
      return "";
    });
    host.handle("secret.get", () => {
      throw new Error("pin");
    });
    host.handle("storage.load", () => {
      throw new Error("Something native and unexpected");
    });
    const request = requester(host);
    const value = JSON.stringify({ text: 'quotes " and \\ stay as they are' });
    await request("snapshot.set", { key: "inbox" }, value);
    expect(bodies).toEqual([value]);
    await expect(request("secret.get", "key")).rejects.toMatchObject({
      code: "pin",
      message: "pin",
    });
    const failure = await request("storage.load").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostCallError);
    expect(failure).toMatchObject({ code: "failed", operation: "storage.load" });
    await expect(request("credential")).rejects.toMatchObject({ code: "unsupported" });
  });
});

const platform = (without: ("inflate" | "trace")[] = []) => {
  const target: Record<string, unknown> = {};
  installWebPlatform(createNodeHost({ without }), target);
  return target as {
    TextEncoder: typeof TextEncoder;
    TextDecoder: typeof TextDecoder;
    URL: typeof URL;
    DecompressionStream?: typeof DecompressionStream;
    atob: typeof atob;
    btoa: typeof btoa;
  };
};

describe("Web APIs backed by the host", () => {
  it("encodes into a short buffer only the whole characters that fit", () => {
    const { TextEncoder } = platform();
    const destination = new Uint8Array(5);
    expect(new TextEncoder().encodeInto("a😀b", destination)).toEqual({ read: 3, written: 5 });
    expect([...destination]).toEqual([0x61, 0xf0, 0x9f, 0x98, 0x80]);
  });

  it("decodes leniently by default and throws on invalid bytes when fatal", () => {
    const { TextDecoder } = platform();
    const invalid = new Uint8Array([0x61, 0xff]);
    expect(new TextDecoder().decode(invalid)).toBe("a�");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(invalid)).toThrow();
  });

  it("expands gzip through the host and rejects corrupt input", async () => {
    const { DecompressionStream } = platform();
    if (!DecompressionStream) throw new Error("expected a DecompressionStream");
    const expand = async (bytes: Uint8Array<ArrayBuffer>) => {
      const stream = new DecompressionStream("gzip");
      const writer = stream.writable.getWriter();
      void writer.write(bytes).then(() => writer.close());
      const { value } = await stream.readable.getReader().read();
      return new TextDecoder().decode(value);
    };
    expect(await expand(new Uint8Array(gzipSync("hello, phone")))).toBe("hello, phone");
    const corrupt = new Uint8Array(gzipSync("hello, phone"));
    corrupt[corrupt.length - 5] = (corrupt[corrupt.length - 5] ?? 0) ^ 0xff;
    await expect(expand(corrupt)).rejects.toThrow(/Invalid compressed data/);
  });

  it("offers no DecompressionStream on a host without zlib, so nothing asks for compression", () => {
    expect(platform(["inflate"]).DecompressionStream).toBeUndefined();
  });

  it("parses absolute URLs and refuses relative ones", () => {
    const { URL } = platform();
    const url = new URL("wss://user@example.test:8443/v1/socket?x=1#y");
    expect([url.host, url.origin, url.pathname, url.search]).toEqual([
      "example.test:8443",
      "wss://example.test:8443",
      "/v1/socket",
      "?x=1",
    ]);
    expect(() => new URL("/v1/socket")).toThrow(TypeError);
  });

  it("round-trips binary strings through base64", () => {
    const { atob, btoa } = platform();
    const binary = String.fromCharCode(0, 127, 128, 255);
    expect(atob(btoa(binary))).toBe(binary);
    expect(atob("not base64!")).toBe("");
  });
});

describe("previews", () => {
  it("cut at grapheme boundaries and never split an emoji", () => {
    const host = createNodeHost();
    const text = "😀" + "x".repeat(10);
    expect(host.previewHead(text, 1)).toBe("…");
    expect(host.previewHead(text, 3)).toBe("😀x…");
    expect(host.previewTail("x👍🏽", 3)).toBe("");
    expect(host.previewTail("x👍🏽", 4)).toBe("👍🏽");
    expect(host.previewHead("\ud800abc", 10)).toBe("�abc");
  });
});
