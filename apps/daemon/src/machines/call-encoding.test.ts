import { expect, test } from "vitest";
import { compressibleAnswer, decodeBody, encodeBody, pickEncoding } from "./call-encoding.ts";

test("zstd is chosen when the other side offers it, deflate when only that, identity otherwise", () => {
  expect(pickEncoding("zstd, deflate")).toBe("zstd");
  expect(pickEncoding("gzip, deflate")).toBe("deflate");
  expect(pickEncoding("gzip, br")).toBeUndefined();
  expect(pickEncoding(undefined)).toBeUndefined();
});

test("a coding the other side refuses with q=0 is never used", () => {
  expect(pickEncoding("zstd;q=0, deflate")).toBe("deflate");
  expect(pickEncoding("*;q=0")).toBeUndefined();
});

test("a body compressed either way reads back as sent", () => {
  const body = Buffer.from(
    JSON.stringify({ threads: Array.from({ length: 200 }, () => ({ state: "working" })) }),
  );
  for (const coding of ["zstd", "deflate"] as const) {
    const sent = encodeBody(body, coding);
    expect(sent.length).toBeLessThan(body.length / 4);
    expect(decodeBody(sent, coding, 1024 * 1024).equals(body)).toBe(true);
  }
});

test("a compressed body that would expand past the limit is refused, not read", () => {
  const bomb = Buffer.alloc(4 * 1024 * 1024, 0x20);
  for (const coding of ["zstd", "deflate"] as const)
    expect(() => decodeBody(encodeBody(bomb, coding), coding, 1024 * 1024)).toThrow();
  expect(() => decodeBody(Buffer.from("{}"), "br", 1024)).toThrow();
});

const view = {
  threadId: "child-1",
  state: "working",
  title: "Review the open pull requests",
  elapsedSeconds: 12,
  step: "Reading the diff",
  status: { state: "working", agents: 1 },
  requests: [],
};
const describe = {
  hostId: "host-studio",
  name: "Studio",
  access: "operate",
  grants: { agents: "operate", browser: "read", devices: "off", screen: "off", commands: "off" },
  projects: [{ workspaceId: "workspace-1", name: "ace" }],
  tools: ["devices"],
  providers: ["claude"],
  accounts: [{ provider: "claude", id: "work", label: "Work" }],
};
const link = "https://example.test/callback?token=secret";

test("answers whose every field, at every depth, is known to be safe may be compressed", () => {
  expect(compressibleAnswer("status", { threads: [view] })).toBe(true);
  expect(
    compressibleAnswer("status", {
      threads: [
        {
          ...view,
          state: "failed",
          status: { state: "limited", until: 5 },
          failure: { code: "usage_limited", message: "Usage limit reached.", resetsAt: 5 },
          notice: { text: "Your message was kept back.", commandId: "c-1", code: "held" },
        },
      ],
    }),
  ).toBe(true);
  expect(compressibleAnswer("describe", describe)).toBe(true);
});

test("a field this build doesn't know, anywhere in the answer, keeps it uncompressed", () => {
  const nested = [
    ["status", { threads: [{ ...view, status: { state: "working", agents: 1, link } }] }],
    ["status", { threads: [{ ...view, failure: { code: "x", message: "y", link } }] }],
    ["status", { threads: [{ ...view, notice: { text: "t", commandId: "c", code: "k", link } }] }],
    ["status", { threads: [{ ...view, link }] }],
    ["describe", { ...describe, projects: [{ workspaceId: "w", name: "ace", remote: link }] }],
    ["describe", { ...describe, accounts: [{ provider: "claude", id: "work", link }] }],
    ["describe", { ...describe, grants: { ...describe.grants, link } }],
    ["describe", { ...describe, homepage: link }],
  ] as const;
  for (const [op, body] of nested) expect(compressibleAnswer(op, body), JSON.stringify(body)).toBe(false);
});

test("a status answer holding a request for the person is never compressed", () => {
  const asking = {
    ...view,
    requests: [{ threadId: "child-1", interactionId: "i-1", request: { kind: "browser_help", url: link } }],
  };
  expect(compressibleAnswer("status", { threads: [asking] })).toBe(false);
  expect(
    compressibleAnswer("status", {
      threads: [{ ...view, needs: [{ interactionId: "i-1", kind: "question", prompt: "Which?" }] }],
    }),
  ).toBe(false);
});

test("a field of the wrong type is not taken as safe", () => {
  expect(compressibleAnswer("status", { threads: [{ ...view, title: { url: link } }] })).toBe(false);
  expect(compressibleAnswer("describe", { ...describe, tools: [{ url: link }] })).toBe(false);
});
