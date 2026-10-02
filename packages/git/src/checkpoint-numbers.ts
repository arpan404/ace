import { z } from "zod";
import { GitCli, textOutput } from "./cli.ts";
import { decode, hash, malformed, nul } from "./decode.ts";
import { checkpointIdentity, checkpointPrefix, metadata } from "./checkpoint-metadata.ts";

export interface Counter {
  sha: string | null;
  sequence: number;
}
export interface CheckpointRef {
  id: string;
  sha: string;
  sequence: number;
}
export function counterRef(threadId: string): string {
  checkpointPrefix(threadId);
  return `refs/ace/checkpoint-sequences/${threadId}`;
}
export async function checkpointRefs(
  cli: GitCli,
  root: string,
  threadId: string,
): Promise<CheckpointRef[]> {
  const prefix = checkpointPrefix(threadId);
  const output = textOutput(
    await cli.call(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]),
  );
  if (!output) return [];
  return output
    .split("\n")
    .map((record) => {
      const [id, sha] = decode(
        z.tuple([z.string(), z.string()]),
        record.split("\0"),
        "checkpoint ref record",
      );
      let identity;
      try {
        identity = checkpointIdentity(id);
      } catch {
        throw malformed("checkpoint ref identity");
      }
      if (identity.threadId !== threadId) throw malformed("checkpoint ref namespace");
      return { id, sha: hash(sha), sequence: identity.sequence };
    })
    .toSorted((a, b) => a.sequence - b.sequence);
}
export class CheckpointNumbers {
  private readonly cache = new Map<string, Counter>();
  private readonly cli: GitCli;
  private readonly capacity: number;
  constructor(cli: GitCli, capacity = 128) {
    this.cli = cli;
    this.capacity = z.number().int().min(1).max(4096).parse(capacity);
  }
  get size(): number {
    return this.cache.size;
  }
  async get(root: string, threadId: string): Promise<Counter> {
    const value = this.cache.get(`${root}\0${threadId}`);
    if (!value) return this.refresh(root, threadId);
    this.remember(root, threadId, value);
    return value;
  }
  remember(root: string, threadId: string, value: Counter): void {
    const key = `${root}\0${threadId}`;
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
  forget(root: string, threadId: string): void {
    this.cache.delete(`${root}\0${threadId}`);
  }
  async refresh(root: string, threadId: string): Promise<Counter> {
    const ref = counterRef(threadId);
    const result = await this.cli.call(
      root,
      ["show", "--no-show-signature", "-s", "--format=%H%x00%B%x00", ref],
      { allowFailure: true },
    );
    let value: Counter;
    if (result.exitCode === 0) {
      // show adds a newline after the final NUL.
      if (result.stdout.at(-1) !== 10 || result.stdout.at(-2) !== 0)
        throw malformed("checkpoint counter framing");
      const bytes = result.stdout.subarray(0, result.stdout.length - 1);
      const [sha, message] = decode(
        z.tuple([z.string(), z.string()]),
        nul(bytes),
        "checkpoint counter record",
      );
      const data = metadata(message);
      if (data.threadId !== threadId || data.sequence === undefined)
        throw malformed("checkpoint counter metadata");
      value = { sha: hash(sha), sequence: data.sequence };
    } else {
      // One-time migration for checkpoints written before durable counters existed.
      const refs = await checkpointRefs(this.cli, root, threadId);
      value = { sha: null, sequence: refs.at(-1)?.sequence ?? 0 };
    }
    this.remember(root, threadId, value);
    return value;
  }
}
