import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { consumeDeviceRecording } from "./index.ts";

it("a failed video export removes its temporary recording source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-recording-export-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "recording.ace-screen");
  await writeFile(path, "fake recording");
  const publication = consumeDeviceRecording(
    { id: "recording", path, bytes: 14, mimeType: "application/vnd.ace.screen" },
    async () => {
      throw new Error("Encoder failed");
    },
  );
  await expect(publication).rejects.toThrow("Encoder failed");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
