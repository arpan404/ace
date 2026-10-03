import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";

const redact = createRedactor({
  workspace: "/private/var/folders/x/ace-rec-codex-abc",
  home: "/Users/jane",
  username: "jane",
  host: "Janes-MacBook-Pro.local",
});

describe("createRedactor", () => {
  it.each([
    { workspace: "/private/var/folders/x/ace-rec-codex-abc", home: "/Users/jane" },
    { workspace: "/tmp/ace-rec-codex-abc", home: "/home/jane" },
    { workspace: "/home/jane/ace-rec-codex-abc", home: "/home/jane" },
  ])("redacts workspace and home paths while keeping suffixes: $workspace", (paths) => {
    const scrub = createRedactor({ ...paths, username: "jane", host: "test-host.local" });
    expect(scrub(JSON.stringify({ cwd: `${paths.workspace}/src` }))).toBe(
      '{"cwd":"<WORKSPACE>/src"}',
    );
    expect(scrub(JSON.stringify({ codexHome: `${paths.home}/.codex` }))).toBe(
      '{"codexHome":"<HOME>/.codex"}',
    );
  });

  it("redacts provider directory names with slash-encoded workspace paths", () => {
    expect(redact('"-private-var-folders-x-ace-rec-codex-abc/session.jsonl"')).toBe(
      '"-<WORKSPACE>/session.jsonl"',
    );
  });

  it("redacts both full and short host names", () => {
    expect(redact('"Janes-MacBook-Pro.local Janes-MacBook-Pro"')).toBe('"<HOST> <HOST>"');
  });

  it("removes host names, emails, identifiers and tokens", () => {
    const line = JSON.stringify({
      serverName: "Janes-MacBook-Pro.local",
      email: "jane@example.com",
      installationId: "fe4c8eec-cd6e",
      auth: "Bearer abcdefghijklmnopqrstuvwxyz",
      key: "sk-ant-abcdefghijklmnopqrstu",
    });
    const out = redact(line);
    expect(out).not.toMatch(/Janes|jane@|fe4c8eec|abcdefghijklmnop/);
    expect(out).toContain('"installationId":"<ID>"');
  });

  it("keeps the recorder's own synthetic identity", () => {
    expect(redact('"recorder@ace.invalid"')).toBe('"recorder@ace.invalid"');
  });

  it("redacts personal emails while preserving provider system emails", () => {
    expect(redact('"jane@example.com noreply@anthropic.com"')).toBe(
      '"<EMAIL> noreply@anthropic.com"',
    );
  });

  it("redacts usernames as whole words without changing unrelated text", () => {
    expect(redact('"jane jane-doe janeway"')).toBe('"<USER> <USER>-doe janeway"');
  });
});

it("preserves literal OpenCode text fragments while removing personal data", () => {
  const out = redact(JSON.stringify({ text: "{\n", delta: "[ /Users/jane jane@example.com" }));
  expect(JSON.parse(out)).toEqual({ text: "{\n", delta: "[ <HOME> <EMAIL>" });
});

it("retains native usage counts while rejecting secret-bearing token objects", () => {
  const tokens = { input: 41, output: 7, reasoning: 2, cache: { read: 11, write: 0 } };
  expect(JSON.parse(redact(JSON.stringify({ tokens })))).toEqual({ tokens });
  expect(
    JSON.parse(redact(JSON.stringify({ tokens: { ...tokens, access: "private-token" } }))),
  ).toEqual({ tokens: "<SECRET>" });
  expect(JSON.parse(redact(JSON.stringify({ tokens: "private-token" })))).toEqual({
    tokens: "<SECRET>",
  });
});

it("removes other absolute home paths in provider output", () => {
  expect(
    JSON.parse(redact(JSON.stringify({ text: "/Users/another/.local /home/elsewhere/src" }))),
  ).toEqual({ text: "<HOME>/.local <HOME>/src" });
});

it("omits opaque encrypted provider reasoning state from captures", () => {
  expect(
    JSON.parse(
      redact(JSON.stringify({ state: { reasoningEncryptedContent: "opaque-provider-state" } })),
    ),
  ).toEqual({ state: { reasoningEncryptedContent: "<SECRET>" } });
});
