export class DownloadError extends Error {}

/** Browser fallback is bounded; supported browsers stream directly to the chosen file. */
export async function saveDownload(
  name: string,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const picker = "showSaveFilePicker" in window ? window.showSaveFilePicker : undefined;
  if (typeof picker === "function") {
    const handle: unknown = await picker({ suggestedName: name });
    if (
      typeof handle !== "object" ||
      handle === null ||
      !("createWritable" in handle) ||
      typeof handle.createWritable !== "function"
    )
      throw new DownloadError("Couldn't open the download. Try another browser.");
    const writable: unknown = await handle.createWritable();
    if (!(writable instanceof WritableStream))
      throw new DownloadError("Couldn't save the download. Try another browser.");
    const writer = writable.getWriter();
    try {
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        await writer.write(chunk);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error);
      throw error;
    }
    return;
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024)
      throw new DownloadError(
        "This browser can download up to 64 MB. Use a browser that supports saving files directly, or choose a smaller folder.",
      );
    parts.push(new Uint8Array(chunk));
  }
  const url = URL.createObjectURL(new Blob(parts));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
