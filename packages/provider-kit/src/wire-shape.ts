import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The shape of a channel between the daemon and a worker thread it starts (ADR 0125): a
 * fingerprint of the channel's message schemas, computed once, on first use, in each thread.
 *
 * Messages on such a channel are not validated: both ends run this build's code, so a message
 * is in the shape its TypeScript type says. That holds only while both ends are the same build.
 * A worker loads its module from disk when it starts, and idle workers retire and start again,
 * so a worker started after an in-place update (a package manager replacing files under a
 * running daemon, or a source checkout that moved) can run newer code than the daemon. The
 * daemon passes its shape in `workerData`; the worker refuses to start on a different one
 * (`assertWireShape`), so every message is between two ends that agree on the schemas.
 */
export function wireShape(schemas: readonly z.ZodType[]): () => string {
  let shape: string | undefined;
  return () =>
    (shape ??= createHash("sha256")
      .update(
        JSON.stringify(
          schemas.map((schema) =>
            z.toJSONSchema(schema, { unrepresentable: "any", io: "output", cycles: "ref" }),
          ),
        ),
      )
      .digest("hex"));
}

/** Thrown in a worker whose channel schemas differ from the daemon's. */
export class WireShapeMismatch extends Error {
  constructor(channel: string) {
    super(`The ${channel} worker is from a different build than the daemon; restart ace`);
    this.name = "WireShapeMismatch";
  }
}

/** Run first in a worker: the daemon's shape (from `workerData`) must equal this build's. */
export function assertWireShape(channel: string, daemon: unknown, worker: () => string): void {
  if (daemon !== worker()) throw new WireShapeMismatch(channel);
}
