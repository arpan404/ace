import { PassThrough } from "node:stream";
import { hash } from "./decode.ts";
import { textOutput } from "./cli.ts";
import type { Repository } from "./repository.ts";
import type { GitCli } from "./cli.ts";

// Git reads and transports object bytes. JS only owns a backpressured pipe.
export async function transferObjects(
  cli: GitCli,
  from: string,
  to: string,
  commit: string,
): Promise<void> {
  const channel = new PassThrough();
  // The channel owner also handles late errors after either CLI has detached
  // its listeners. Active calls report failures through their own promises.
  channel.on("error", () => {});
  const stop = (error: unknown) => {
    channel.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  };
  const results = await Promise.allSettled([
    cli
      .call(from, ["pack-objects", "--stdout", "--revs"], { input: commit + "\n", output: channel })
      .catch(stop),
    cli.call(to, ["unpack-objects", "-q"], { write: true, input: channel }).catch(stop),
  ]);
  channel.destroy();
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export async function transferTree(
  repository: Repository,
  from: string,
  to: string,
  tree: string,
): Promise<void> {
  const createdAt = (await repository.now()).toISOString();
  const commit = hash(
    textOutput(
      await repository.cli.call(from, ["-c", "commit.gpgSign=false", "commit-tree", tree], {
        write: true,
        input: "ace nested snapshot\n",
        env: {
          GIT_AUTHOR_NAME: "ace",
          GIT_AUTHOR_EMAIL: "checkpoints@ace.local",
          GIT_COMMITTER_NAME: "ace",
          GIT_COMMITTER_EMAIL: "checkpoints@ace.local",
          GIT_AUTHOR_DATE: createdAt,
          GIT_COMMITTER_DATE: createdAt,
        },
      }),
    ),
  );
  await transferObjects(repository.cli, from, to, commit);
}
