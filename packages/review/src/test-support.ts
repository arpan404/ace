import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command, ReviewSession, ReviewComment } from "@ace/protocol";
import type { ReviewExecutor } from "./index.ts";
import { ReviewService } from "./index.ts";
const exec = promisify(execFile);
export async function repository(executor?: ReviewExecutor) {
  const directory = await mkdtemp(join(tmpdir(), "ace-review-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const git = async (...args: string[]) =>
    (
      await exec("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
    ).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Review test");
  await git("config", "user.email", "review@example.invalid");
  await writeFile(join(root, "file.ts"), "first\nbefore\nconst value = original;\nafter\nlast\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  await writeFile(join(root, "file.ts"), "first\nbefore\nconst value = wrong;\nafter\nlast\n");
  let counter = 0;
  const path = join(directory, "review.sqlite");
  const options = {
    path,
    now: () => 123,
    id: () => `id-${String(++counter).padStart(6, "0")}`,
    ...(executor ? { executor } : {}),
  };
  let service = new ReviewService(options);
  const command = (payload: unknown, id = `command-${++counter}`) =>
    Command.parse({ id, deviceId: "device", payload });
  const send = (payload: unknown, id?: string) => service.handle(command(payload, id), root);
  const opened = await send({
    type: "review.open",
    source: {
      workspaceId: "workspace",
      from: { kind: "commit", ref: base },
      to: { kind: "working-tree" },
    },
  });
  const session = ReviewSession.parse(opened.review?.session);
  const comment = async (suggestion?: string) => {
    const result = await send({
      type: "review.comment",
      sessionId: session.id,
      position: { file: "file.ts", side: "new", start: 3, end: 3 },
      text: "Fix the value",
      ...(suggestion === undefined ? {} : { suggestion }),
    });
    return ReviewComment.parse(result.review?.comment);
  };
  return {
    root,
    directory,
    git,
    send,
    command,
    session,
    comment,
    read: () => readFile(join(root, "file.ts"), "utf8"),
    write: (text: string) => writeFile(join(root, "file.ts"), text),
    reopen() {
      service.close();
      service = new ReviewService(options);
    },
    async close() {
      service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
