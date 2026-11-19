import { ClientError } from "./errors.ts";

/** Bound bytes before decoding or parsing an HTTP response. */
export async function httpJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new ClientError("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ClientError("limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const result: unknown = JSON.parse(text);
    return result;
  } finally {
    reader.releaseLock();
  }
}
