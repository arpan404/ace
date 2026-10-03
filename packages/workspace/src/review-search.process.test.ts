import { expect, it } from "vitest";
import { fixture } from "./test-support.ts";

it.each([null, "rg"])(
  "rejects unsupported regex escapes consistently with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("a", "\u0001 😀\n");
    for (const query of [String.raw`\cA`, String.raw`\uD83D\uDE00`, String.raw`\0`]) {
      await expect(service.search({ query, regex: true, limit: 10 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  },
);
it.each([null, "rg"])(
  "returns zero-width matches only at Unicode boundaries with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("a", "😀\n");
    expect((await service.search({ query: "a*", regex: true, limit: 10 })).matches).toEqual([
      { path: "a", line: 1, column: 1, preview: "😀" },
      { path: "a", line: 1, column: 5, preview: "😀" },
    ]);
  },
);
it.each([null, "rg"])(
  "returns a successful limited result for a dense one-MiB line with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("dense", "a".repeat(1024 * 1024));
    const result = await service.search({ query: "a", limit: 1 });
    expect(result).toMatchObject({
      truncated: true,
      matches: [{ path: "dense", line: 1, column: 1, preview: "a".repeat(512) }],
    });
  },
);
it.each([null, "rg"])(
  "searches beyond the read cap while obeying the remaining byte budget with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    const text = "needle\n" + "x".repeat(1_100_000) + "\nneedle\n";
    await file("large", text);
    const result = await service.search({ query: "needle", limit: 10 });
    expect(result.matches).toEqual([
      { path: "large", line: 1, column: 1, preview: "needle" },
      { path: "large", line: 3, column: 1, preview: "needle" },
    ]);
    expect(result.bytesScanned).toBe(Buffer.byteLength(text));
    const bounded = await service.search({ query: "needle", limit: 10, byteBudget: 7 });
    expect(bounded).toMatchObject({
      bytesScanned: 7,
      truncated: true,
      matches: [result.matches[0]],
    });
  },
);
it.each([null, "rg"])(
  "preserves every byte column on a long Unicode line with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("sparse", ("α" + "x".repeat(79) + "hit").repeat(10_000));
    const result = await service.search({ query: "hit", limit: 10_000 });
    expect(result.matches).toHaveLength(10_000);
    expect(result.matches[0]).toMatchObject({ path: "sparse", line: 1, column: 82 });
    expect(result.matches[1]).toMatchObject({ column: 166 });
    expect(result.matches.at(-1)).toMatchObject({ column: 839_998 });
  },
);

it.each([null, "rg"])(
  "rejects multiline escapes, surrogate scalars and engine-specific class operators with backend %s",
  async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("a", "a&b\n😀\n");
    for (const query of [
      String.raw`\x0a`,
      String.raw`\u000A`,
      String.raw`\u{A}`,
      String.raw`\u{D800}`,
      "[a&&b]",
      "[a~~b]",
      "[]",
      "[^]",
      "[[]",
      "\ud800",
    ]) {
      await expect(service.search({ query, regex: true, limit: 10 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  },
);
