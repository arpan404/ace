import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { executablePath, setup } from "./parity-test-support.ts";
import { ref } from "./test-support.ts";

const folder = async () => {
  const path = await mkdtemp(join(tmpdir(), "ace-chosen-downloads-"));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
};

it.skipIf(!executablePath)(
  "ace's Chrome saves downloads in the chosen folder under their own name, numbered when taken",
  async () => {
    const chosen = await folder();
    const f = await setup({ downloadFolder: async () => chosen });
    const download = ref(await f.execute({ action: "snapshot" }), "Download");
    await f.execute({ action: "click", ref: download });
    await f.until(() => f.service.downloadsList("thread")[0]?.state === "complete");
    await f.execute({ action: "click", ref: download });
    await f.until(() => f.service.downloadsList("thread")[1]?.state === "complete");
    expect((await readdir(chosen)).toSorted()).toEqual(["example (1).zip", "example.zip"]);
    const [first, second] = f.service.downloadsList("thread");
    expect(first?.path).toBe(join(chosen, "example.zip"));
    expect(second?.path).toBe(join(chosen, "example (1).zip"));
    expect(await readFile(join(chosen, "example.zip"), "utf8")).toBe("zip-fixture");
    // The thread's artifacts are its own quarantined copies, which the folder never replaces.
    expect(f.artifacts).toHaveLength(2);
    for (const artifact of f.artifacts) {
      expect(artifact.path.startsWith(chosen)).toBe(false);
      expect(await readFile(artifact.path, "utf8")).toBe("zip-fixture");
    }
  },
);

it.skipIf(!executablePath)(
  "with no usable downloads folder, a download stays with the thread's browser data",
  async () => {
    const f = await setup({ downloadFolder: async () => join(tmpdir(), "ace-no-such-folder") });
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Download"),
    });
    await f.until(() => f.service.downloadsList("thread")[0]?.state === "complete");
    const path = f.service.downloadsList("thread")[0]?.path ?? "";
    expect(path).not.toContain("ace-no-such-folder");
    expect(await readFile(path, "utf8")).toBe("zip-fixture");
  },
);
