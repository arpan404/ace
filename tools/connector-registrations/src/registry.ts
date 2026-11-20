import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The shipped list itself, through @ace/cloud's export, so the check never holds a copy of it.
import { SHIPPED_APPS } from "@ace/cloud/apps";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { Facts } from "./check.ts";
import { type LegalSite, PublicConfig, Registry } from "./types.ts";

/** The repository root, from this file's place in it. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const paths = {
  registry: "tools/connector-registrations/registry.json",
  wrangler: "apps/cloud/wrangler.jsonc",
  publicConfig: "spade/config/connector-apps.json",
  legal: "apps/marketing/src/content/legal.ts",
  redirects: "apps/marketing/public/_redirects",
  doc: "spade/docs/connector-registrations.md",
  out: "tools/connector-registrations/out",
} as const;

async function read(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRequired(root: string, path: string): Promise<string> {
  const text = await read(root, path);
  if (text === undefined) throw new Error(`${path} is missing`);
  return text;
}

export async function loadRegistry(root: string): Promise<Registry> {
  const parsed = Registry.safeParse(JSON.parse(await readRequired(root, paths.registry)));
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${paths.registry}: ${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  return parsed.data;
}

const CloudWrangler = z.object({
  env: z.object({
    production: z.object({
      vars: z.object({
        ACE_ACCOUNT_PUBLIC_URL: z.url(),
      }),
    }),
  }),
});

/** The production origin in `apps/cloud/wrangler.jsonc`, from which the broker builds callbacks. */
export function parseCloudPublicUrl(source: string): string {
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${paths.wrangler}: invalid JSONC`);
  return CloudWrangler.parse(raw).env.production.vars.ACE_ACCOUNT_PUBLIC_URL;
}

/** `_redirects` rules (Cloudflare Pages): `from to [status]` per line, `#` for comments. */
export function parseRedirects(text: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [from, to] = line.trim().split(/\s+/);
    if (!from || from.startsWith("#") || !to) continue;
    if (!rules.has(from)) rules.set(from, to);
  }
  return rules;
}

/**
 * The two legal paths, read from `legal.ts` as text: importing it would pull the marketing site's
 * modules into this tool.
 */
export function parseLegalPaths(source: string): Pick<LegalSite, "privacyPath" | "termsPath"> {
  const path = (name: string) =>
    new RegExp(`export const ${name}: LegalDocument = \\{\\s*path: "([^"]+)"`).exec(source)?.[1];
  return { privacyPath: path("privacyPolicy"), termsPath: path("termsOfService") };
}

export async function loadFacts(root: string): Promise<Facts> {
  const cloudPublicUrl = parseCloudPublicUrl(await readRequired(root, paths.wrangler));
  const config = PublicConfig.parse(JSON.parse(await readRequired(root, paths.publicConfig)));
  const legal = parseLegalPaths(await readRequired(root, paths.legal));
  const redirects = parseRedirects((await read(root, paths.redirects)) ?? "");
  return { apps: SHIPPED_APPS, cloudPublicUrl, config, site: { ...legal, redirects } };
}

export async function readDoc(root: string): Promise<string | undefined> {
  return read(root, paths.doc);
}
