import { parse as parseToml } from "smol-toml";

/**
 * Tests only: reads `-c` overrides back the way Codex does. Each override splits at its first
 * `=`; the key splits on every `.` with nothing unquoted, and only the value is TOML (a value
 * that isn't TOML is kept as text). Overrides land on `base`, merging into tables it has.
 */
export function readCodexOverrides(
  args: readonly string[],
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const config = structuredClone(base);
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "-c") throw new Error(`Expected -c, got ${args[index]}`);
    const override = args[index + 1] ?? "";
    const at = override.indexOf("=");
    if (at < 0) throw new Error(`Override without =: ${override}`);
    const path = override.slice(0, at).trim().split(".");
    const text = override.slice(at + 1).trim();
    let value: unknown;
    try {
      value = parseToml(`value = ${text}`)["value"];
    } catch {
      value = text;
    }
    let table: Record<string, unknown> = config;
    for (const segment of path.slice(0, -1)) {
      const next = table[segment];
      if (typeof next !== "object" || next === null || Array.isArray(next)) table[segment] = {};
      table = table[segment] as Record<string, unknown>;
    }
    table[path.at(-1) ?? ""] = value;
  }
  return config;
}
