import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ParcelFiles } from "./files.ts";

// ADR 0209 §4.2: an organization's host keeps nothing more of a parcel on its way in, and never
// places one, even when it is enrolled between the last bytes and their placement.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("a parcel write or placement refused by its guard leaves nothing kept or placed", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-parcel-files-"));
  homes.push(home);
  const files = new ParcelFiles(home);
  const id = "pcl-00000000-0000-4000-8000-000000000002";
  const data = Buffer.from("results");
  const sha = createHash("sha256").update(data).digest("hex");
  let allowed = false;
  const guard = () => {
    if (!allowed) throw new Error("org host");
  };
  await expect(files.append(id, 0, data, guard)).rejects.toThrow("org host");
  expect(await files.heldOnDisk(id)).toBe(0);
  allowed = true;
  await files.append(id, 0, data, guard);
  // Enrolled after the bytes were checked, before they are placed.
  let checks = 0;
  await expect(
    files.finish(id, "results.txt", data.length, sha, () => {
      if (++checks > 0) throw new Error("org host");
    }),
  ).rejects.toThrow("org host");
  expect(existsSync(files.placed(id, "results.txt"))).toBe(false);
});
