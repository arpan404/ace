import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hostedPolicy } from "./content-policy.ts";

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );

test("the hosted page runs only its own scripts: its inline boot scripts by hash, nothing else inline", () => {
  const html = readFileSync(join(import.meta.dirname, "index.html"), "utf8");
  const policy = directives(hostedPolicy(html));
  const scripts = policy.get("script-src") ?? [];
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  expect(inline.length).toBeGreaterThan(0);
  for (const [, body] of inline)
    expect(scripts).toContain(
      `'sha256-${createHash("sha256")
        .update(body ?? "")
        .digest("base64")}'`,
    );
  expect(scripts).not.toContain("'unsafe-inline'");
  expect(scripts).not.toContain("'unsafe-eval'");
  expect(policy.get("object-src")).toEqual(["'none'"]);
  // Pictures and recordings come from the page itself, never from another site.
  expect(policy.get("img-src")).toContain("data:");
  expect(policy.get("img-src")).not.toContain("https:");
  // A page can't set frame-ancestors; the host sends it.
  expect(policy.has("frame-ancestors")).toBe(false);
  const host = JSON.parse(readFileSync(join(import.meta.dirname, "vercel.json"), "utf8"));
  expect(JSON.stringify(host.headers)).toContain("frame-ancestors 'none'");
});
