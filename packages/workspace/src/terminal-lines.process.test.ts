import { expect, it } from "vitest";
import { fixture } from "./test-support.ts";

const cases = [
  { name: "Unicode EOF", text: "😀", preview: "😀", columns: [1, 5], end: 5 },
  { name: "Unicode LF", text: "😀\n", preview: "😀", columns: [1, 5], end: 5 },
  { name: "Unicode CR", text: "😀\r", preview: "😀", columns: [1, 5], end: 5 },
  {
    name: "Unicode budget-cut prefix",
    text: "😀\nignored",
    byteBudget: 4,
    preview: "😀",
    columns: [1, 5],
    end: 5,
  },
  {
    name: "incomplete Unicode budget-cut prefix",
    text: "😀\nignored",
    byteBudget: 2,
    preview: "�",
    columns: [1, 4],
    end: 4,
  },
  { name: "ASCII EOF", text: "xyz", preview: "xyz", columns: [1, 2, 3, 4], end: 4 },
  {
    name: "ASCII budget-cut prefix",
    text: "xyz\nignored",
    byteBudget: 3,
    preview: "xyz",
    columns: [1, 2, 3, 4],
    end: 4,
  },
];

for (const ripgrep of [null, "rg"]) {
  it.each(cases)(
    `includes terminal empty matches at $name with backend ${ripgrep ?? "node"}`,
    async (example) => {
      const { service, file } = await fixture({ ripgrep });
      await file("a", example.text);
      const options = "byteBudget" in example ? { byteBudget: example.byteBudget } : {};
      const expected = (column: number) => ({
        path: "a",
        line: 1,
        column,
        preview: example.preview,
      });
      const empty = await service.search({ query: "a*", regex: true, limit: 10, ...options });
      expect(empty.backend).toBe(ripgrep ? "ripgrep" : "node");
      expect(empty.matches).toEqual(example.columns.map(expected));
      const end = await service.search({ query: "$", regex: true, limit: 10, ...options });
      expect(end.matches).toEqual([expected(example.end)]);
      expect(end.bytesScanned).toBe(
        "byteBudget" in example ? example.byteBudget : Buffer.byteLength(example.text),
      );
      expect(end.truncated).toBe("byteBudget" in example);
    },
  );

  it(`does not invent a searchable line for an empty file with backend ${ripgrep ?? "node"}`, async () => {
    const { service, file } = await fixture({ ripgrep });
    await file("empty", "");
    expect(await service.search({ query: "$", regex: true, limit: 10 })).toMatchObject({
      matches: [],
      bytesScanned: 0,
      truncated: false,
    });
  });

  it(`preserves terminal line numbers after preceding lines with backend ${ripgrep ?? "node"}`, async () => {
    const { service, file } = await fixture({ ripgrep });
    await file("multi", "x\n😀");
    expect((await service.search({ query: "$", regex: true, limit: 10 })).matches).toEqual([
      { path: "multi", line: 1, column: 2, preview: "x" },
      { path: "multi", line: 2, column: 5, preview: "😀" },
    ]);
  });

  it(`preserves EOF columns when a Unicode character spans input chunks with backend ${ripgrep ?? "node"}`, async () => {
    const { service, file } = await fixture({ ripgrep });
    await file("long", "x".repeat(65_535) + "😀");
    expect(await service.search({ query: "$", regex: true, limit: 10 })).toMatchObject({
      bytesScanned: 65_539,
      truncated: false,
      matches: [{ path: "long", line: 1, column: 65_540, preview: "x".repeat(512) }],
    });
  });
}
