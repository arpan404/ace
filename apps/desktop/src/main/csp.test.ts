import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp.ts";

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  if (!found) throw new Error(`Missing ${name}`);
  return found.split(/\s+/).slice(1);
}

describe("renderer content security policy", () => {
  it("lets the page fetch its own blob URLs for image copies", () => {
    // The lightbox copies through fetch(objectUrl); without blob: in connect-src
    // Chromium refuses the fetch and nothing reaches the clipboard.
    expect(directive(contentSecurityPolicy({}), "connect-src")).toContain("blob:");
  });

  it("still shows attachment previews where they belong", () => {
    const policy = contentSecurityPolicy({});
    for (const name of ["img-src", "media-src", "frame-src", "worker-src"]) {
      expect(directive(policy, name)).toContain("blob:");
    }
  });

  it("never lets the page reach the network beyond its daemons", () => {
    const sources = directive(contentSecurityPolicy({}), "connect-src");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
  });
});
