import { expect, test } from "vitest";
import { styleKitVersion, visualizationDocument } from "./index.ts";

/** The kit styles a page receives, as the framed page carries them. */
function kitOf(outer: string): string {
  const page = (/srcdoc="([^"]*)"/.exec(outer)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  return /<style>(@layer ace\{[\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
}
const html =
  '<!doctype html><html><body><div class="card"><div class="row">Old</div></div></body></html>';

test("a page published before kits had versions keeps the unprefixed classes it was written for", () => {
  const kit = kitOf(visualizationDocument(html, {}, "static", undefined));
  expect(kit).toMatch(/\n\.card\{/);
  expect(kit).toMatch(/\n\.row\{/);
});

test("a page on the current kit gets only ace- classes, so its own .card and .row stay its own", () => {
  const kit = kitOf(visualizationDocument(html, {}, "static", styleKitVersion));
  expect(kit).toMatch(/\n\.ace-card\{/);
  expect(kit).not.toMatch(/[\n,}]\.(?:card|row|grid|bar|badge|stack|tabs)[{.,: ]/);
});
