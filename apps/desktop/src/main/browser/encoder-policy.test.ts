import { describe, expect, it } from "vitest";
import {
  encoderPolicy,
  encoderRequestAllowed,
  ingestEndpoint,
  needsNewPage,
} from "./encoder-policy.ts";

describe("the encoder page's network policy", () => {
  it("knows ace-media's ingest only in its loopback form", () => {
    expect(ingestEndpoint("ws://127.0.0.1:51234/ingest")).toBe("ws://127.0.0.1:51234");
    for (const url of [
      "ws://127.0.0.1:51234/other",
      "ws://localhost:51234/ingest",
      "wss://127.0.0.1:51234/ingest",
      "ws://127.0.0.1:99999/ingest",
      "ws://127.0.0.1:0/ingest",
      "ws://127.0.0.1:51234/ingest?x=1",
    ])
      expect(ingestEndpoint(url)).toBeUndefined();
  });

  it("lets the page connect to ace-media's current port and nothing else", () => {
    const policy = encoderPolicy("ws://127.0.0.1:51234");
    expect(policy).toContain("connect-src ws://127.0.0.1:51234");
    expect(policy).not.toContain("*");
    expect(encoderPolicy(undefined)).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
  });

  it("lets requests through to the page itself and the current ingest only", () => {
    const endpoint = "ws://127.0.0.1:51234";
    expect(encoderRequestAllowed("app://video-encoder/encoder.js", endpoint)).toBe(true);
    expect(encoderRequestAllowed("ws://127.0.0.1:51234/ingest", endpoint)).toBe(true);
    expect(encoderRequestAllowed("ws://127.0.0.1:51235/ingest", endpoint)).toBe(false);
    expect(encoderRequestAllowed("ws://127.0.0.1:51234/ingest", undefined)).toBe(false);
    expect(encoderRequestAllowed("https://example.com/", endpoint)).toBe(false);
  });

  it("a page loaded for another endpoint must be made again", () => {
    expect(needsNewPage(undefined, "ws://127.0.0.1:1")).toBe(false);
    expect(needsNewPage({ endpoint: undefined }, "ws://127.0.0.1:1")).toBe(true);
    expect(needsNewPage({ endpoint: "ws://127.0.0.1:1" }, "ws://127.0.0.1:1")).toBe(false);
    expect(needsNewPage({ endpoint: "ws://127.0.0.1:1" }, "ws://127.0.0.1:2")).toBe(true);
  });
});
