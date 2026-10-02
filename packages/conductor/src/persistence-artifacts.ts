import { createHash } from "node:crypto";
import { z } from "zod";
import { ConductorPlan, ConductorReview, ConductorSpec } from "@ace/protocol";
import { Artifact, Completion } from "./schema.ts";
import { Count, Payload } from "./persistence-schema.ts";
import type { PersistenceSql } from "./persistence-sql.ts";

const Envelope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spec"), data: ConductorSpec }),
  z.object({ kind: z.literal("plan"), data: ConductorPlan }),
  z.object({ kind: z.literal("artifact"), data: Artifact }),
  z.object({ kind: z.literal("completion"), data: Completion }),
  z.object({ kind: z.literal("review"), data: ConductorReview }),
]);
type Envelope = z.infer<typeof Envelope>;
export type ArtifactKind = Envelope["kind"];
const MAX_BYTES = 32 * 1024 * 1024;

/** Weak memo keys are the admitted immutable objects, not retained history.
 * A restore-local decoder bounds strong reference indexes. */
export class ArtifactCodec {
  private readonly ids = new WeakMap<object, { run: string; id: string }>();
  private readonly sql: PersistenceSql;
  constructor(sql: PersistenceSql) {
    this.sql = sql;
  }
  encode(run: string, kind: ArtifactKind, data: object): string {
    const known = this.ids.get(data);
    if (known?.run === run) return known.id;
    const payload = JSON.stringify({ kind, data });
    const id = createHash("sha256").update(payload).digest("hex");
    this.sql.insertArtifact.run(run, id, payload);
    this.ids.set(data, { run, id });
    return id;
  }
  remember(run: string, data: object, id: string): void {
    this.ids.set(data, { run, id });
  }
  decoder(run: string) {
    const admitted = new Map<string, Envelope>();
    let bytes = 0;
    return (id: string): Envelope => {
      const known = admitted.get(id);
      if (known) return known;
      if (admitted.size >= 1024) throw new Error("artifact_backpressure");
      const row = this.sql.artifact.get(run, id);
      if (!row) throw new Error("artifact_not_found");
      const payload = Payload.parse(row).payload;
      bytes += Buffer.byteLength(payload);
      if (bytes > MAX_BYTES) throw new Error("artifact_byte_backpressure");
      if (createHash("sha256").update(payload).digest("hex") !== id)
        throw new Error("artifact_digest_mismatch");
      const envelope = Envelope.parse(JSON.parse(payload));
      admitted.set(id, envelope);
      return envelope;
    };
  }
  compact(run: string, refs: Iterable<string>): void {
    this.sql.clearRetained.run();
    let count = 0;
    for (const ref of refs) {
      if (++count > 1024) throw new Error("artifact_backpressure");
      this.sql.retain.run(ref);
    }
    this.sql.removeUnused.run(run);
    if (Count.parse(this.sql.artifactBytes.get(run)).n > MAX_BYTES)
      throw new Error("artifact_byte_backpressure");
  }
}
