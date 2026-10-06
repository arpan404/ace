import { readFileSync } from "node:fs";
import { z } from "zod";

/** Versioned provider schema evidence, not a schema invented by the CLI double. */
export function validateNativeMcpConfig(
  provider: "opencode" | "codex" | "acp",
  config: unknown,
): void {
  const fixture = { opencode: "opencode/2.0.22", codex: "codex/0.159.1", acp: "acp/1.7.0" }[
    provider
  ];
  const json: unknown = JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/${fixture}/mcp-config.schema.json`, import.meta.url),
      "utf8",
    ),
  );
  z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(json)).parse(config);
}
export function shellExposesBearer(authorization: string): boolean {
  const bearer = authorization.slice(7);
  return JSON.stringify(process.env).includes(bearer) || process.argv.join(" ").includes(bearer);
}
