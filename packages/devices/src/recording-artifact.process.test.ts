import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { publishDeviceRecording } from "./index.ts";

async function recorded(parts: number) {
  const root = await mkdtemp(join(tmpdir(), "ace-recording-export-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "r1.parts");
  await mkdir(directory);
  const written = [];
  for (let index = 0; index < parts; index++) {
    const path = join(directory, `part-000${index}.mp4`);
    await writeFile(path, `part ${index}`);
    written.push({ path, index, bytes: 6, durationMs: 1000, gaps: 0 });
  }
  return { root, artifact: { id: "r1", directory, parts: written } };
}

it("publishes every part ace-media wrote, in order, under the recording's id, and removes its directory", async () => {
  const { root, artifact } = await recorded(2);
  const published: { id: string; name: string; contents: string }[] = [];
  const result = await publishDeviceRecording(artifact, root, async (part) => {
    published.push({ id: part.id, name: part.name, contents: await readFile(part.path, "utf8") });
  });
  expect(published).toEqual([
    { id: "r1", name: "Device recording.mp4", contents: "part 0" },
    { id: "r1-2", name: "Device recording (part 2).mp4", contents: "part 1" },
  ]);
  expect(result).toEqual({ id: "r1", bytes: 12, mimeType: "video/mp4" });
  expect((await readdir(root)).toSorted()).toEqual(["r1-2.mp4", "r1.mp4"]);
});

it("a publication that fails on part 0 deletes no video: every part is still on disk, and the error says where", async () => {
  const { root, artifact } = await recorded(3);
  const publication = publishDeviceRecording(artifact, root, async () => {
    throw new Error("Thread is gone");
  });
  await expect(publication).rejects.toThrow(artifact.directory);
  // Part 0 was moved to its artifact name before the failure; the rest never left.
  await expect(readFile(join(root, "r1.mp4"), "utf8")).resolves.toBe("part 0");
  await expect(readFile(join(artifact.directory, "part-0001.mp4"), "utf8")).resolves.toBe("part 1");
  await expect(readFile(join(artifact.directory, "part-0002.mp4"), "utf8")).resolves.toBe("part 2");
});

it("a part ace-media never reported (a stop that timed out) survives, and the result says where it is", async () => {
  const { root, artifact } = await recorded(2);
  // Only part 0 was reported before the stop timed out; part 1 is on disk all the same.
  const reported = { ...artifact, parts: artifact.parts.slice(0, 1) };
  const result = await publishDeviceRecording(reported, root, async () => {});
  expect(result).toEqual({
    id: "r1",
    bytes: 6,
    mimeType: "video/mp4",
    kept: { directory: artifact.directory, files: ["part-0001.mp4"] },
  });
  await expect(readFile(join(artifact.directory, "part-0001.mp4"), "utf8")).resolves.toBe("part 1");
});
