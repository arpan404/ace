/** A tiny ustar fixture, kept separate from production archive code. */
export async function fixtureArchive(
  files: readonly { path: string; bytes: Uint8Array; folder: boolean }[],
): Promise<Uint8Array> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const encoder = new TextEncoder();
  for (const file of files) {
    const header = new Uint8Array(512);
    const put = (at: number, text: string) => header.set(encoder.encode(text), at);
    const size = file.folder ? 0 : file.bytes.length;
    put(0, file.path.slice(-99));
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, size.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, file.folder ? "5" : "0");
    put(257, "ustar\0");
    put(263, "00");
    put(
      148,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    parts.push(header);
    if (size) {
      parts.push(new Uint8Array(file.bytes));
      parts.push(new Uint8Array((512 - (size % 512)) % 512));
    }
  }
  parts.push(new Uint8Array(1024));
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
