import "./test-host.ts";
import { expect, test } from "vitest";
import { identityGlyph } from "./machine-identity.ts";

test("a MacBook is a laptop whatever tower mark it carries by default, and finer marks stay", () => {
  expect(identityGlyph("MacBook Pro Rijan", undefined)).toBe("laptop");
  expect(identityGlyph("Studio", undefined)).toBe("desktop-tower");
  expect(identityGlyph("Build server", { kind: "laptop" })).toBe("laptop");
  expect(identityGlyph("Pixel", { kind: "phone" })).toBe("device-mobile");
  expect(identityGlyph("Rack", { kind: "cloud" })).toBe("cloud");
});
