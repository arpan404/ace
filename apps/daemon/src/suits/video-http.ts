import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { SuitVideoFile } from "./library.ts";
import { byteRange } from "./range.ts";
import { openInsideSuit } from "./reader.ts";

/*
 * A Suit's video, streamed from disk (ADR 0169): never read whole, served by byte range so the
 * page can seek and the browser fetches only what it plays. The caller has checked the URL's
 * grant and the version; this opens the file with no link anywhere on its path (`openInsideSuit`)
 * and serves it only while
 * it is the file that version was hashed with (same size and modification time).
 */

const videoTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export async function serveSuitVideo(
  request: IncomingMessage,
  response: ServerResponse,
  video: SuitVideoFile,
): Promise<void> {
  let handle;
  try {
    handle = await openInsideSuit(video.folder, video.path);
  } catch {
    response.statusCode = 404;
    response.end();
    return;
  }
  try {
    const stat = await handle.stat();
    // Changed since the version was hashed: that version is gone.
    if (!stat.isFile() || stat.size !== video.size || stat.mtimeMs !== video.mtimeMs) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      videoTypes[extname(video.path).toLowerCase()] ?? "application/octet-stream",
    );
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    const range = byteRange(request.headers.range, stat.size);
    if (range === "unsatisfiable") {
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.statusCode = 416;
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    if (range) {
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    } else response.statusCode = 200;
    response.setHeader("Content-Length", Math.max(0, end - start + 1));
    if (request.method === "HEAD" || stat.size === 0) {
      response.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: false });
    // A seek or a closed tab ends the response early; that is how media requests finish.
    await pipeline(stream, response).catch(() => {});
  } finally {
    await handle.close();
  }
}
