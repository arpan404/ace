import { describe, expect, it } from "vitest";
import { parseAst } from "vite";
import { z } from "zod";
import { zodWithoutMetadata } from "../../zod-json-schema.ts";

const protocolId = "/repo/packages/protocol/src/example.ts";
const source = `out.Name = z
  .string()
  .max(4)
  .meta({ "x-ace-constraint": \`At most
four characters.\` });
out.Entry = z.object({ name: out.Name, tags: z.array(z.string()).meta({ uniqueItems: true }) })
  .meta(out.Name.meta() ?? {});
out.Copy = out.Name?.meta({ title: "Copy" });
`;

function strip(code: string, id = protocolId): string | undefined {
  const { transform } = zodWithoutMetadata();
  if (typeof transform !== "function") throw new Error("transform hook missing");
  const result = transform.call({ parse: (input: string) => parseAst(input) } as never, code, id);
  return result && typeof result === "object" && "code" in result && typeof result.code === "string"
    ? result.code
    : undefined;
}

function evaluate(code: string): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  new Function("z", "out", code)(z, out);
  return out;
}

describe("zodWithoutMetadata", () => {
  it("drops protocol annotations without changing what schemas accept", () => {
    const stripped = strip(source);
    expect(stripped).toBeDefined();
    expect(stripped).not.toContain(".meta(");
    expect(stripped).not.toContain("x-ace-constraint");
    // Positions, and with them the sourcemap, are unchanged.
    expect(stripped).toHaveLength(source.length);
    expect(stripped?.split("\n").length).toBe(source.split("\n").length);
    const original = evaluate(source);
    const browser = evaluate(stripped ?? "");
    for (const value of [
      { name: "ok", tags: ["a", "a"] },
      { name: "too long", tags: [] },
      { name: 1, tags: [] },
      {},
    ])
      expect(browser["Entry"]?.safeParse(value).success).toBe(
        original["Entry"]?.safeParse(value).success,
      );
    expect(browser["Name"]?.safeParse("abcd").success).toBe(true);
    expect(browser["Copy"]?.safeParse("abcde").success).toBe(false);
    expect(browser["Name"]?.meta()).toBeUndefined();
  });

  it("leaves sources outside the protocol package alone", () => {
    expect(strip(source, "/repo/packages/client/src/example.ts")).toBeUndefined();
    expect(strip(source, "/repo/node_modules/zod/v4/classic/schemas.js")).toBeUndefined();
  });
});
