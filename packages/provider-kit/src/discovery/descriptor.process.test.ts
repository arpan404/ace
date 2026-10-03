import { expect, test } from "vitest";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverDescriptor } from "./index.ts";
test("explicit descriptors probe only their reviewed version command and keep login unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-descriptor-"));
  const path = join(root, "cli");
  const called = join(root, "called");
  await writeFile(
    path,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(called)}, process.argv.slice(2).join(' '));\nprocess.stdout.write('synthetic 1.2.3\\n');\n`,
  );
  await chmod(path, 0o700);
  try {
    const result = await discoverDescriptor(
      {
        command: path,
        versionArgs: ["--version"],
        version: (text) => /\d+\.\d+\.\d+/.exec(text)?.[0],
        loginHint: "synthetic login",
      },
      { env: {} },
    );
    expect(result).toMatchObject({
      installed: true,
      version: "1.2.3",
      auth: "unknown",
      loginHint: "synthetic login",
    });
    expect(await readFile(called, "utf8")).toBe("--version");
    await expect(
      discoverDescriptor(
        {
          command: "npx",
          versionArgs: ["sample"],
          version: () => undefined,
          loginHint: "local CLI",
        },
        { env: {} },
      ),
    ).rejects.toThrow("runners");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
