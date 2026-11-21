import { describe, expect, it } from "vitest";
import { buildSite, readSpec } from "./spec-site.ts";

describe("the Spade Agent Format's site", () => {
  const site = buildSite(readSpec(new URL("../spade/spec/", import.meta.url).pathname));

  it("serves each JSON Schema at its stable address, matching the $id it declares", () => {
    for (const name of ["bot", "contract", "surface", "card", "scenario"]) {
      const text = site.get(`1.0/${name}.schema.json`);
      expect(text, name).toBeDefined();
      expect(JSON.parse(text ?? "{}")["$id"]).toBe(
        `https://spec.acehq.dev/1.0/${name}.schema.json`,
      );
    }
  });

  it("has a page for every part, and every link between pages and files lands on the site", () => {
    for (const part of [
      "index",
      "package",
      "effects",
      "runtime",
      "surfaces",
      "contracts",
      "distribution",
    ])
      expect(site.has(`${part}.html`), part).toBe(true);
    expect(site.has("conformance/index.html")).toBe(true);
    for (const [path, html] of site) {
      if (!path.endsWith(".html")) continue;
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      for (const [, href] of html.matchAll(/href="([^"#:]+)(?:#[^"]*)?"/g)) {
        const target = new URL(href ?? "", `https://spec.acehq.dev/${folder}`).pathname.slice(1);
        const landed =
          site.has(target) || site.has(`${target}index.html`) || site.has(`${target}/index.html`);
        expect(landed, `${path} links to ${href}`).toBe(true);
      }
    }
  });

  it("keeps the spec's written regions as text and its marks out of the pages", () => {
    const page = site.get("package.html") ?? "";
    expect(page).toContain("package.identity");
    expect(page).not.toContain("spec:begin");
  });

  it("lets editors and other runtimes fetch the schemas from any origin", () => {
    const headers = site.get("_headers") ?? "";
    expect(headers).toMatch(/\/1\.0\/\*\.schema\.json\n\s+Content-Type: application\/schema\+json/);
    expect(headers).toMatch(/\/1\.0\/\*\n\s+Access-Control-Allow-Origin: \*/);
  });
});
