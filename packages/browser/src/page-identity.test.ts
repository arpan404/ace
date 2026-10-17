import { describe, expect, it } from "vitest";
import { faviconLimit, identityBinding, readIdentity } from "./page-identity.ts";

const call = (payload: unknown, name = identityBinding) => ({
  name,
  payload: JSON.stringify(payload),
  executionContextId: 7,
});
const png = "data:image/png;base64,iVBORw0KGgo=";

describe("a tab's identity report", () => {
  it("gives the page's title and its PNG favicon", () => {
    expect(readIdentity(call({ title: "  Inbox   (3) ", icon: png }))).toEqual({
      title: "Inbox (3)",
      favicon: png,
    });
  });

  it("is ignored when another binding sends it", () => {
    expect(readIdentity(call({ title: "Spoofed", icon: png }, "__other"))).toBeUndefined();
  });

  it("keeps the title but no icon when the icon is not a bounded PNG data URL", () => {
    for (const icon of [
      "https://example.com/favicon.ico",
      "data:image/svg+xml;base64,PHN2Zz4=",
      `data:image/png;base64,${"A".repeat(faviconLimit)}`,
    ])
      expect(readIdentity(call({ title: "Docs", icon }))).toEqual({ title: "Docs" });
  });

  it("cuts a long title to the wire bound", () => {
    expect(readIdentity(call({ title: "x".repeat(5000), icon: "" }))?.title).toHaveLength(1024);
  });
});
