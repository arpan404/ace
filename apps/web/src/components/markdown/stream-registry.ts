import { LruCache } from "@ace/ui-core";
import { BlockStream } from "./block-stream.ts";
import { settledBlock, type MarkdownBlock } from "./blocks.ts";

/*
 * The markdown worker's side of streamed documents: one parser per stream (a message), fed the
 * text appended since the last job. A reply carries only the blocks that settled with this
 * append and the open blocks after them, never the whole document again.
 */

/** Append `append` to stream `stream`, which held `at` characters before it. */
export interface StreamJob {
  stream: string;
  at: number;
  append: string;
  /** No more text will come: every block settles. */
  final: boolean;
}

export type StreamReply =
  | {
      /** Settled blocks from this index on are `settled`; earlier ones are unchanged. */
      from: number;
      settled: MarkdownBlock[];
      open: MarkdownBlock[];
      /** Time this job took here, for the page's update cadence. */
      ms: number;
    }
  /** The stream is unknown here or holds other text: send it whole (`at: 0`). */
  | { resync: true };

export class StreamRegistry {
  private now: () => number;
  /** Streams still being written. A final job ends its stream. */
  private streams = new LruCache<string, BlockStream>({
    maxEntries: 64,
    maxWeight: 8 * 1024 * 1024,
    weigh: (stream) => stream.weight * 2 + 256,
  });
  constructor(now: () => number) {
    this.now = now;
  }
  apply(job: StreamJob): StreamReply {
    const started = this.now();
    const stream = job.at === 0 ? new BlockStream() : this.streams.get(job.stream);
    if (!stream || stream.length !== job.at) return { resync: true };
    const { from, settled, open } = stream.push(job.append, job.final);
    if (job.final) this.streams.delete(job.stream);
    else this.streams.set(job.stream, stream);
    return {
      from,
      settled: settled.map(settledBlock),
      open: open.map((token) => ({ token })),
      ms: this.now() - started,
    };
  }
}
