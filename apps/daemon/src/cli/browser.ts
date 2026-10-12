import { BrowserArtifact, ThreadId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { option, timeoutMs, validateArgs, type Args } from "./args.ts";
import { waitSelection } from "./connection.ts";
import { mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function browserCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(args, ["output", "duration", "url"], 3);
  const verb = args.words[1];
  if (verb !== "shot" && verb !== "record")
    throw new CliFailure(
      "refused",
      "Usage: ace browser shot|record THREAD [--output PATH] [--url URL]",
    );
  const threadId = ThreadId.parse(args.words[2]);
  const duration = timeoutMs({ words: [], flags: { timeout: option(args, "duration") ?? "5s" } });
  const lease = client.thread(threadId);
  let recording = false;
  const stopFrames = client.onMessage((message) => {
    if (
      message.type === "browser.frame" &&
      message.threadId === threadId &&
      client.state === "ready"
    )
      client.send({
        type: "browser.ack",
        threadId,
        requestId: randomUUID(),
        sequence: message.frame.sequence,
      });
  });
  try {
    await waitSelection(
      lease.store.select(["thread", "error"], (reader) => reader.thread ?? reader.error),
      (value) => value !== undefined,
      signal,
    );
    if (lease.store.error) throw lease.store.error;
    const thread = lease.store.thread;
    if (!thread) throw new CliFailure("uncertain", "Thread unavailable");
    const opened = await client.request(
      {
        type: "browser.open",
        options: { threadId, workspaceId: thread.workspaceId, headed: false, background: true },
      },
      { signal },
    );
    if (!opened.ok) throw new CliFailure("refused", opened.error ?? "Browser unavailable");
    const url = option(args, "url");
    if (url) {
      const navigation = await client.request(
        { type: "browser.execute", threadId, command: { action: "navigate", url } },
        { signal },
      );
      if (!navigation.ok)
        throw new CliFailure(
          navigation.blocked ? "needs-human" : "refused",
          navigation.error ?? "Navigation refused",
        );
    }
    let artifact: { path: string; mimeType: string };
    if (verb === "shot") {
      const shot = await client.request(
        { type: "browser.execute", threadId, command: { action: "screenshot" } },
        { signal },
      );
      if (!shot.ok) throw new CliFailure("refused", shot.error ?? "Screenshot refused");
      artifact = BrowserArtifact.pick({ path: true, mimeType: true }).parse(shot.result);
    } else {
      const subscribed = await client.request({ type: "browser.subscribe", threadId }, { signal });
      if (!subscribed.ok)
        throw new CliFailure("refused", subscribed.error ?? "Recording unavailable");
      const started = await client.request(
        { type: "browser.recording.start", threadId },
        { signal },
      );
      if (!started.ok) throw new CliFailure("refused", started.error ?? "Recording unavailable");
      recording = true;
      await delay(duration, undefined, { signal });
      const stopped = await client.request(
        { type: "browser.recording.stop", threadId },
        { signal },
      );
      recording = false;
      if (!stopped.ok)
        throw new CliFailure("uncertain", stopped.error ?? "Recording finalization unavailable");
      artifact = BrowserArtifact.parse(stopped.result);
      if (artifact.mimeType !== "video/mp4")
        throw new CliFailure(
          "refused",
          "Recording could not be encoded as MP4. Install ffmpeg on the daemon host and check its encoder; retry the recording. The complete player bundle remains on the host.",
          { path: artifact.path, mimeType: artifact.mimeType },
        );
    }
    const findArtifact = () =>
      lease.store.order
        .map((id) => lease.store.item(id))
        .find(
          (item) =>
            item?.type === "artifact" && item.source === "browser" && item.path === artifact.path,
        );
    const published = await waitSelection(
      lease.store.select(["order", "cursor"], findArtifact),
      (item) => !!item,
      signal,
    );
    if (published?.type !== "artifact" || !published.artifactId)
      throw new CliFailure("uncertain", "Browser artifact is not downloadable");
    const output =
      option(args, "output") ?? `ace-${verb}-${randomUUID()}.${verb === "shot" ? "png" : "mp4"}`;
    const file = await open(output, "wx", 0o600);
    let complete = false;
    try {
      for await (const bytes of client.downloadFile(
        { threadId, op: "artifact.download", artifactId: published.artifactId, offset: 0 },
        { signal },
      ))
        await file.writeFile(bytes);
      await file.sync();
      complete = true;
    } finally {
      await file.close();
      if (!complete) await rm(output, { force: true });
    }
    await mutationResult(args, {
      path: output,
      mimeType: artifact.mimeType,
      artifactId: published.artifactId,
    });
  } finally {
    stopFrames();
    if (recording && client.state === "ready")
      await client.request({ type: "browser.recording.stop", threadId }).catch(() => {});
    lease.release();
  }
}
