import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectLicenses, thirdPartyLicensesFile } from "./licenses.ts";

test("every bundled dependency's license text ships in one third-party file", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ace-licenses-"));
  try {
    const modules = join(temporary, "repo/node_modules");
    const packages = [
      { dir: "zod", name: "zod", files: { LICENSE: "MIT zod text" } },
      {
        dir: "@cursor/sdk",
        name: "@cursor/sdk",
        files: { "LICENSE.md": "Cursor terms", "NOTICE.txt": "Cursor notice" },
      },
    ];
    for (const pkg of packages) {
      const root = join(modules, pkg.dir);
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: pkg.name }));
      await writeFile(join(root, "dist/index.js"), "export {}");
      await writeFile(join(root, "README.md"), "not a notice");
      for (const [file, text] of Object.entries(pkg.files)) await writeFile(join(root, file), text);
    }
    const output = join(temporary, "release");
    await mkdir(output);
    await collectLicenses(
      [
        join(modules, "zod/dist/index.js"),
        join(modules, "@cursor/sdk/dist/index.js"),
        join(temporary, "repo/apps/daemon/src/main.ts"),
      ],
      output,
    );

    expect(await readdir(output)).toEqual([thirdPartyLicensesFile]);
    const notices = await readFile(join(output, thirdPartyLicensesFile), "utf8");
    for (const text of ["MIT zod text", "Cursor terms", "Cursor notice"])
      expect(notices).toContain(text);
    expect(notices).toContain("@cursor/sdk (LICENSE.md)");
    expect(notices).toContain("zod (LICENSE)");
    expect(notices).not.toContain("not a notice");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
