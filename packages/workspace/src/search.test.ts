import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "./index.ts";
import { exec, fixture } from "./test-support.ts";

describe("workspace search", () => {
  it("ripgrep and Node return identical literal, regex, case and glob results", async () => {
    await exec("rg", ["--version"]); // A real ripgrep is required for this contract test.
    const { root, service, file } = await fixture({}, true);
    const node = await createWorkspace(root, { ripgrep: null });
    await file(".gitignore", "ignored/\n*.log\n");
    await file("a.ts", "café needle needle\nNEEDLE\nalpha42\n");
    await file("sub/b.ts", "needle\r\nalpha7\r\n");
    await file(".hidden.ts", "needle\n");
    await file("c.txt", "needle\n");
    await file("ignored/a.ts", "needle\n");
    await file("hidden.log", "needle\n");
    await file("binary.ts", Buffer.from("needle\0needle"));
    await file("late-binary.ts", "a".repeat(8192) + "\0needle");
    const outside = await fixture();
    await outside.file("secret.ts", "needle");
    await symlink(outside.root, join(root, "escape"));
    for (const query of [
      { query: "needle" },
      { query: "needle", caseSensitive: false },
      { query: "alpha[0-9]+|needle", regex: true, glob: "**/*.ts" },
      { query: "needle", glob: "*.txt" },
      { query: "not here" },
    ]) {
      const rgResult = await service.search({ ...query, limit: 100 });
      const nodeResult = await node.search({ ...query, limit: 100 });
      expect(rgResult.backend).toBe("ripgrep");
      expect(nodeResult.backend).toBe("node");
      expect(rgResult.matches).toEqual(nodeResult.matches);
      expect(rgResult.bytesScanned).toBe(nodeResult.bytesScanned);
    }
    expect((await service.search({ query: "needle", glob: "a.ts", limit: 100 })).matches).toEqual([
      { path: "a.ts", line: 1, column: 7, preview: "café needle needle" },
      { path: "a.ts", line: 1, column: 14, preview: "café needle needle" },
    ]);
    expect(
      (await service.search({ query: "needle", caseSensitive: false, glob: "a.ts", limit: 100 }))
        .matches,
    ).toContainEqual({
      path: "a.ts",
      line: 2,
      column: 1,
      preview: "NEEDLE",
    });
    expect(
      (await node.search({ query: "needle", limit: 100 })).matches.map((match) => match.path),
    ).toEqual([".hidden.ts", "a.ts", "a.ts", "c.txt", "sub/b.ts"]);
  });
  it("uses the same shorthand classes and newline rules for Unicode and CRLF text", async () => {
    const { root, service, file } = await fixture();
    const node = await createWorkspace(root, { ripgrep: null });
    await file("a", "word7 ١ K\r\nalpha42\u2028beta9\rfinal\n");
    for (const query of [
      String.raw`\d+`,
      String.raw`[\w]+`,
      String.raw`\W+`,
      String.raw`\s+`,
      "^.*$",
      "K$",
      "^beta9$",
    ]) {
      const request = { query, regex: true, limit: 100 };
      expect((await service.search(request)).matches).toEqual((await node.search(request)).matches);
    }
    expect((await node.search({ query: "^beta9$", regex: true, limit: 10 })).matches).toEqual([
      { path: "a", line: 3, column: 1, preview: "beta9" },
    ]);
  });
  it("returns identical BOM text and zero-width regex occurrences", async () => {
    const { root, service, file } = await fixture();
    const node = await createWorkspace(root, { ripgrep: null });
    await file("a", "\ufeffabc\n");
    for (const query of ["abc", "a*", "^|$", "b?"]) {
      const request = { query, regex: true, limit: 20 };
      expect((await service.search(request)).matches).toEqual((await node.search(request)).matches);
    }
    expect(
      (await node.search({ query: "a*", regex: true, limit: 20 })).matches.map(
        (match) => match.column,
      ),
    ).toEqual([1, 3, 4]);
  });
  it("runs the fallback safely when the parent Node process uses inline input mode", async () => {
    const { root, file } = await fixture();
    await file("a", "found");
    const module = new URL("./index.ts", import.meta.url).href;
    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { createWorkspace } from ${JSON.stringify(module)};
      const service = await createWorkspace(process.argv[1], { ripgrep: null });
      console.log(JSON.stringify(await service.search({ query: 'found', limit: 1 })));
    `,
      root,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "node",
      matches: [{ path: "a", line: 1, column: 1, preview: "found" }],
    });
  });
  it.each([null, "rg"])("stops at the match limit with backend %s", async (ripgrep) => {
    const { service, file } = await fixture({ ripgrep });
    await file("a.txt", "hit hit hit\nhit\n");
    await file("b.txt", "hit\n");
    const result = await service.search({ query: "hit", limit: 2 });
    expect(result.matches).toEqual([
      { path: "a.txt", line: 1, column: 1, preview: "hit hit hit" },
      { path: "a.txt", line: 1, column: 5, preview: "hit hit hit" },
    ]);
    expect(result.truncated).toBe(true);
  });
  it.each([null, "rg"])(
    "caps scanned bytes and skips oversized files with backend %s",
    async (ripgrep) => {
      const { service, file } = await fixture({ ripgrep });
      await file("a.txt", "hit\n");
      await file("b.txt", "hit\n");
      await file("huge.txt", "hit\n".repeat(300_000));
      const result = await service.search({ query: "hit", limit: 10, byteBudget: 4 });
      expect(result).toMatchObject({ bytesScanned: 4, truncated: true });
      expect(result.matches.map((match) => match.path)).toEqual(["a.txt"]);
      const large = await service.search({ query: "hit", limit: 10 });
      expect(large.matches.map((match) => match.path)).toEqual(["a.txt", "b.txt"]);
      expect(large.truncated).toBe(true);
    },
  );
  it("automatically falls back when the executable is missing", async () => {
    const { service, file } = await fixture({ ripgrep: "/does-not-exist/rg" });
    await file("a", "found");
    expect(await service.search({ query: "found", limit: 1 })).toMatchObject({
      backend: "node",
      matches: [{ path: "a", line: 1 }],
    });
  });
  it.each([null, "rg"])(
    "rejects pre-cancelled and in-progress searches with backend %s",
    async (ripgrep) => {
      const { service, file } = await fixture({ ripgrep });
      await file("a", "needle\n".repeat(10_000));
      const before = new AbortController();
      before.abort();
      await expect(
        service.search({ query: "needle", limit: 10, signal: before.signal }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      const during = new AbortController();
      const searching = service.search({ query: "needle", limit: 10, signal: during.signal });
      // Yield to I/O, then abort the ongoing operation without a timing assertion.
      await new Promise<void>((resolve) => setImmediate(resolve));
      during.abort();
      await expect(searching).rejects.toMatchObject({ code: "ABORTED" });
      expect((await service.search({ query: "needle", limit: 1 })).matches).toHaveLength(1);
    },
  );
  it("rejects invalid regexes, unsupported regex features and unbounded requests", async () => {
    const { service } = await fixture();
    for (const options of [
      { query: "", limit: 1 },
      { query: "[", regex: true, limit: 1 },
      { query: "a(?=b)", regex: true, limit: 1 },
      { query: "a", limit: 0 },
      { query: "a", limit: 10_001 },
      { query: "a", limit: 1, byteBudget: 0 },
    ])
      await expect(service.search(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
