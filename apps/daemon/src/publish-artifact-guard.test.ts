import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FilesService } from "@ace/files";
import { publishArtifact } from "./publish-artifact.ts";

// ADR 0209 §3: a support bundle of conversations must never reach the registry once its home
// is an organization's host, even when it is enrolled between the file landing and its entry.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("an artifact refused at the last moment is never registered, and its file is removed", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-publish-"));
  homes.push(home);
  const artifacts = join(home, "artifacts");
  const workspace = join(home, "workspace");
  mkdirSync(artifacts);
  mkdirSync(workspace);
  let n = 0;
  const files = await FilesService.create({
    workspace,
    dataDir: join(home, "registry"),
    artifactRoots: [artifacts],
    now: () => 1,
    id: () => `id${++n}`,
    authorize: () => true,
  });
  // Allowed when the bytes are written, refused by the time the registry would take it.
  let asked = 0;
  const guard = () => {
    asked++;
    if (asked > 1) throw new Error("enrolled");
  };
  await expect(
    publishArtifact(
      files,
      artifacts,
      {
        size: 16,
        path: "bundle.tar.gz",
        name: "bundle.tar.gz",
        category: "support",
        id: "local-support-1",
        write: (temporary) => writeFile(temporary, "conversations"),
      },
      guard,
    ),
  ).rejects.toThrow("enrolled");
  expect(existsSync(join(artifacts, "bundle.tar.gz"))).toBe(false);
  // Nothing holds its id: the same id registers afresh once allowed.
  asked = -10;
  await expect(
    publishArtifact(
      files,
      artifacts,
      {
        size: 16,
        path: "bundle.tar.gz",
        name: "bundle.tar.gz",
        category: "support",
        id: "local-support-1",
        write: (temporary) => writeFile(temporary, "plain"),
      },
      guard,
    ),
  ).resolves.toBe("local-support-1");
  await files.close();
});
