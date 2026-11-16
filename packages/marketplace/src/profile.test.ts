import { describe, expect, it } from "vitest";
import { displayNameProblem, handleProblem, linkProblem, skeleton } from "./profile.ts";
import type { MarketLink } from "@ace/protocol/marketplace";

/*
 * The profile rules (ADR 0173 §3, §14): handles (shape, reserved words, lookalikes, the official
 * `ace`), display names (hidden characters, mixed scripts, reading as ace, a verified name) and
 * links. Behaviour: given a handle, name or link, a reason is returned or not.
 */

const ok = (problem: { message: string } | undefined) => problem === undefined;

describe("handleProblem", () => {
  it.each(["triage-mail", "mail-tools", "deep-sea", "abc", "a1-b2-c3"])(
    "accepts the ordinary handle %s",
    (handle) => {
      expect(ok(handleProblem(handle, { official: false }))).toBe(true);
    },
  );

  it.each([
    ["too short", "ab"],
    ["a double dash", "mail--tools"],
    ["a leading dash", "-mail"],
    ["a trailing dash", "mail-"],
    ["upper case", "Mail"],
    ["a space", "mail tools"],
  ])("refuses %s", (_name, handle) => {
    expect(ok(handleProblem(handle, { official: false }))).toBe(false);
  });

  it.each(["ace", "admin", "support", "security", "spade", "root", "api", "marketplace", "mod"])(
    "refuses the reserved handle %s",
    (handle) => {
      expect(ok(handleProblem(handle, { official: false }))).toBe(false);
    },
  );

  it.each(["ace-team", "ace-official", "official-ace", "acehq", "a-c-e", "4ce", "ace-hq", "ac3"])(
    "refuses the ace lookalike %s for a non-official account",
    (handle) => {
      expect(ok(handleProblem(handle, { official: false }))).toBe(false);
    },
  );

  it.each(["ace", "ace-official", "acehq"])("lets the official account take %s", (handle) => {
    expect(ok(handleProblem(handle, { official: true }))).toBe(true);
  });

  it("refuses a handle whose dash part is a reserved word", () => {
    expect(ok(handleProblem("my-admin-tools", { official: false }))).toBe(false);
  });
});

describe("displayNameProblem", () => {
  const plain = { official: false, verified: [] as string[] };
  it.each(["Mail Tools", "Deep Sea", "Harbour Dusk", "三毛猫 Studio"])(
    "accepts the ordinary name %s",
    (name) => {
      expect(ok(displayNameProblem(name, plain))).toBe(true);
    },
  );

  it("refuses a name with a zero-width character", () => {
    expect(ok(displayNameProblem("Mail​Tools", plain))).toBe(false);
  });

  it("refuses a name with a bidirectional control", () => {
    expect(ok(displayNameProblem("Mail‮Tools", plain))).toBe(false);
  });

  it("refuses a mixed-script name (Latin with Cyrillic)", () => {
    expect(ok(displayNameProblem("Pа ypal", plain))).toBe(false);
  });

  it.each(["ace", "By ace", "a c e", "By  Ace"])(
    "refuses the name %s that reads as ace for a non-official account",
    (name) => {
      expect(ok(displayNameProblem(name, plain))).toBe(false);
    },
  );

  it("lets the official account use By ace", () => {
    expect(ok(displayNameProblem("By ace", { official: true, verified: [] }))).toBe(true);
  });

  it("refuses a verified publisher's display name from someone else", () => {
    expect(ok(displayNameProblem("Acme", { official: false, verified: ["Acme"] }))).toBe(false);
  });
});

const link = (url: string): MarketLink => ({ label: "site", url });

describe("linkProblem", () => {
  it.each(["https://example.com", "https://example.com/path?q=1", "https://sub.example.co.uk/x"])(
    "accepts %s",
    (url) => {
      expect(ok(linkProblem(link(url)))).toBe(true);
    },
  );

  it.each([
    ["http (not https)", "http://example.com"],
    ["credentials in the authority", "https://user:pw@example.com"],
    ["an IPv4 literal", "https://127.0.0.1/x"],
    ["localhost", "https://localhost/x"],
    ["a .local host", "https://printer.local/x"],
    ["a .internal host", "https://db.internal/x"],
  ])("refuses %s", (_name, url) => {
    expect(ok(linkProblem(link(url)))).toBe(false);
  });
});

describe("skeleton", () => {
  it("folds digits, homoglyphs and separators so lookalikes collide", () => {
    expect(skeleton("ace-team")).toBe(skeleton("ac3-t3am"));
    expect(skeleton("a-c-e")).toBe("ace");
    expect(skeleton("paypal")).toBe(skeleton("paypa1"));
  });
});
