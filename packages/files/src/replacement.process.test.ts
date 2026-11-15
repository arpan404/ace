// Real edge: the OS's atomic exchange (renamex_np / renameat2 through the rename worker) on a
// real filesystem, with an outside program saving in the moment before it runs.
import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createExclusiveRename, type ExclusiveRename } from "./index.ts";
import { FileError } from "./types.ts";
import { fixture } from "./test-support.ts";

const Upload = z.object({ uploadId: z.string(), offset: z.number() });
const Stat = z.object({ version: z.string().nullable() });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

type Save = (path: string, text: string) => Promise<void>;
/** An editor that writes into the open file. */
const inPlace: Save = (path, text) => writeFile(path, text);
/** An editor that saves to a temp file and renames it over the original. */
const replacing: Save = async (path, text) => {
  await writeFile(`${path}.editor-tmp`, text);
  await rename(`${path}.editor-tmp`, path);
};

/** The native mover, with outside saves landing right before or after the first exchange. */
function racing(hooks: {
  before?(path: string): Promise<void>;
  after?(path: string): Promise<void>;
}) {
  const native = createExclusiveRename();
  let exchanges = 0;
  const mover: ExclusiveRename = {
    move: (source, destination) => native.move(source, destination),
    async exchange(first, second) {
      const call = ++exchanges;
      if (call === 1) await hooks.before?.(second);
      if (!native.exchange) throw new Error("The native mover has no exchange");
      await native.exchange(first, second);
      if (call === 1) await hooks.after?.(second);
    },
    close: () => native.close(),
  };
  return mover;
}

async function setup(exclusiveRename: ExclusiveRename) {
  const f = await fixture({ exclusiveRename });
  cleanup.push(() => f.close());
  await writeFile(join(f.root, "notes.md"), "original");
  const expected = Stat.parse(
    await f.service.request("writer", { op: "stat", path: "notes.md" }),
  ).version;
  const upload = async (text: string) => {
    const { uploadId } = Upload.parse(
      await f.service.request("writer", {
        op: "upload.begin",
        path: "notes.md",
        expected,
        size: Buffer.byteLength(text),
      }),
    );
    await f.service.append("writer", uploadId, 0, Buffer.from(text));
    const commit = f.service.request("writer", {
      op: "upload.commit",
      uploadId,
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    return { uploadId, commit };
  };
  const files = async () => (await readdir(f.root)).toSorted();
  const read = (name: string) => readFile(join(f.root, name), "utf8");
  return { f, expected, upload, files, read };
}

describe.runIf(process.platform === "darwin" || process.platform === "linux")(
  "replacing a file with atomic exchange",
  () => {
    for (const [how, save] of [
      ["edits the file in place", inPlace],
      ["renames a new file over it", replacing],
    ] as const) {
      test(`an outside program that ${how} just before an upload publishes keeps its save, and the upload is refused but resumable`, async () => {
        const { f, upload, files, read } = await setup(
          racing({ before: (path) => save(path, "outside save") }),
        );
        const { uploadId, commit } = await upload("from the phone");
        await expect(commit).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await read("notes.md")).toBe("outside save");
        // The new bytes went back under the upload's private name.
        expect(await files()).toEqual([`.ace-upload-${uploadId}`, "notes.md"]);
        // The refused upload still holds its bytes; the client can retry against the new version.
        await expect(
          f.service.request("writer", { op: "upload.resume", uploadId }),
        ).resolves.toMatchObject({ offset: 14 });
      });
    }

    test("a second outside save that lands between the exchange and the swap back leaves both saves on disk", async () => {
      const { upload, files, read } = await setup(
        racing({
          before: (path) => replacing(path, "first outside save"),
          after: (path) => replacing(path, "second outside save"),
        }),
      );
      const { uploadId, commit } = await upload("from the phone");
      await expect(commit).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await read("notes.md")).toBe("second outside save");
      expect(await files()).toEqual(["notes.md", `notes.conflict-${uploadId}.md`].toSorted());
      expect(await read(`notes.conflict-${uploadId}.md`)).toBe("first outside save");
    });

    test("an unraced replacing upload publishes and leaves no copy of the old file behind", async () => {
      const { upload, files, read } = await setup(racing({}));
      const { commit } = await upload("from the phone");
      await expect(commit).resolves.toMatchObject({ path: "notes.md" });
      expect(await read("notes.md")).toBe("from the phone");
      expect(await files()).toEqual(["notes.md"]);
    });

    test("a text save keeps an outside save that lands just before it publishes", async () => {
      const { f, expected, files, read } = await setup(
        racing({ before: (path) => replacing(path, "outside save") }),
      );
      await expect(
        f.service.request("writer", { op: "write", path: "notes.md", expected, text: "editor" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await read("notes.md")).toBe("outside save");
      expect(await files()).toEqual(["notes.md"]);
    });
  },
);

test("where the filesystem has no atomic exchange, a replacing upload publishes as before", async () => {
  const native = createExclusiveRename();
  const { upload, files, read } = await setup({
    move: (source, destination) => native.move(source, destination),
    async exchange() {
      throw new FileError("UNSUPPORTED", "Atomic exchange is unavailable on this platform");
    },
    close: () => native.close(),
  });
  const { commit } = await upload("from the phone");
  await expect(commit).resolves.toMatchObject({ path: "notes.md" });
  expect(await read("notes.md")).toBe("from the phone");
  expect(await files()).toEqual(["notes.md"]);
});
