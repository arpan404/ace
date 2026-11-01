import { expect, it } from "vitest";
import tar from "tar-stream";
import { tarHeaders } from "./tar.ts";

/** The first member's header as an independent tar reader decodes it. */
async function readHeader(blocks: Buffer[]): Promise<tar.Headers> {
  const extract = tar.extract();
  const header = new Promise<tar.Headers>((resolve, reject) => {
    extract.once("entry", (entry) => {
      resolve(entry);
      extract.destroy();
    });
    extract.once("error", reject);
  });
  for (const block of blocks) extract.write(block);
  return header;
}

it("a file beyond 8 GiB with a long UTF-8 name keeps its full size and name", async () => {
  const name = "界".repeat(70);
  const size = 9 * 1024 ** 3;
  const header = await readHeader([
    ...tarHeaders({ name, size, mtime: 1_700_000_000_000, directory: false }),
  ]);
  expect(header).toMatchObject({ name, size, type: "file" });
  // The ustar size field holds at most 8 GiB - 1; strict readers take the size from PAX only.
  expect(header.pax).toMatchObject({ size: String(size) });
});
