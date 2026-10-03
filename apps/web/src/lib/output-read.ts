import type { ClientApi } from "@ace/client";

/** The most of a stream a view reads into memory at once. */
const maxChars = 1024 * 1024;

/**
 * A shell's whole output from the daemon's stream store (`output.read`, ADR 0006), decoded as
 * UTF-8 in 256 KiB pages and cut off at 1 MiB, so a runaway build log can't swamp the page.
 */
export async function readOutputText(
  client: ClientApi,
  streamId: string,
  signal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const bytes of client.output(
    { streamId, offset: 0, limit: 256 * 1024 },
    signal ? { signal } : {},
  )) {
    text += decoder.decode(bytes, { stream: true });
    if (text.length > maxChars) return text.slice(-maxChars);
  }
  return text + decoder.decode();
}
