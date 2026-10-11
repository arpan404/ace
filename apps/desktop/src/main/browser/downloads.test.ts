import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { z } from "zod";
import { NativeDownloads } from "./downloads.ts";

class Download extends EventEmitter {
  running = false;
  path = "";
  setSavePath(path: string) {
    this.path = path;
  }
  pause() {
    this.running = false;
  }
  resume() {
    this.running = true;
  }
  cancel() {
    this.running = false;
    this.emit("done", {}, "cancelled");
  }
  getReceivedBytes() {
    return 10;
  }
  getURL() {
    return "http://localhost/file";
  }
  getFilename() {
    return "file.txt";
  }
  getMimeType() {
    return "text/plain";
  }
  finish() {
    this.running = false;
    this.emit("done", {}, "completed");
  }
}
it("six consented downloads all complete with only four transferring at a time", () => {
  const started: string[] = [],
    completed: string[] = [];
  const downloads = new NativeDownloads("/tmp/download-fixture", (method, raw) => {
    if (method === "ace.download.started")
      started.push(z.object({ guid: z.string() }).parse(raw).guid);
    if (method === "ace.download.progress") {
      const event = z.object({ guid: z.string(), state: z.string() }).parse(raw);
      if (event.state === "completed") completed.push(event.guid);
    }
  });
  const files = Array.from({ length: 6 }, () => new Download());
  for (const file of files) expect(downloads.accept(file)).toBe(true);
  for (const guid of started) downloads.command("ace.download.resume", { guid });
  expect(files.filter((file) => file.running)).toHaveLength(4);
  files[0]?.finish();
  expect(files[4]?.running).toBe(true);
  files[1]?.finish();
  expect(files[5]?.running).toBe(true);
  for (const file of files.slice(2)) file.finish();
  expect(completed).toEqual(started);
});
