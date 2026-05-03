import { describe, expect, it } from "vitest";
import {
  buildMobileTerminalContextFromOutput,
  hasMobileTerminalContextOutput,
} from "./mobileTerminalContexts";

describe("buildMobileTerminalContextFromOutput", () => {
  it("returns null when terminal output has no text", () => {
    expect(
      buildMobileTerminalContextFromOutput({
        chunks: ["\n", "   \n"],
        createdAt: "2026-05-02T00:00:00.000Z",
        id: "ctx-1" as never,
        terminalId: "mobile",
        terminalLabel: "Mobile terminal",
      }),
    ).toBeNull();
  });

  it("ignores mobile terminal system marker lines", () => {
    const chunks = ["--- Terminal session opened ---\n"];

    expect(hasMobileTerminalContextOutput(chunks)).toBe(false);
    expect(
      buildMobileTerminalContextFromOutput({
        chunks,
        createdAt: "2026-05-02T00:00:00.000Z",
        id: "ctx-1" as never,
        terminalId: "mobile",
        terminalLabel: "Mobile terminal",
      }),
    ).toBeNull();
  });

  it("captures non-empty output with original line numbers", () => {
    expect(
      buildMobileTerminalContextFromOutput({
        chunks: ["first\n\n", "second\nthird"],
        createdAt: "2026-05-02T00:00:00.000Z",
        id: "ctx-1" as never,
        terminalId: "mobile",
        terminalLabel: "Mobile terminal",
      }),
    ).toMatchObject({
      id: "ctx-1",
      terminalId: "mobile",
      terminalLabel: "Mobile terminal",
      lineStart: 1,
      lineEnd: 4,
      text: "first\nsecond\nthird",
    });
  });

  it("keeps the most recent non-empty lines", () => {
    expect(
      buildMobileTerminalContextFromOutput({
        chunks: ["one\ntwo\nthree\nfour"],
        createdAt: "2026-05-02T00:00:00.000Z",
        id: "ctx-1" as never,
        maxLines: 2,
        terminalId: "mobile",
        terminalLabel: "Mobile terminal",
      }),
    ).toMatchObject({
      lineStart: 3,
      lineEnd: 4,
      text: "three\nfour",
    });
  });
});
