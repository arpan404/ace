import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";

const redact = createRedactor({
  workspace: "/private/var/folders/x/ace-rec-codex-abc",
  home: "/Users/jane",
  username: "jane",
  host: "Janes-MacBook-Pro.local",
});

describe("createRedactor", () => {
  it("replaces workspace before home so nested paths stay meaningful", () => {
    expect(redact('{"cwd":"/private/var/folders/x/ace-rec-codex-abc/src"}')).toBe(
      '{"cwd":"<WORKSPACE>/src"}',
    );
    expect(redact('{"codexHome":"/Users/jane/.codex"}')).toBe('{"codexHome":"<HOME>/.codex"}');
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
});
