import { clientView, clientSummary } from "./client-view.ts";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactCodec } from "./persistence-artifacts.ts";
import { Payload, StoredLane, StoredNode, StoredRoot, sameFields } from "./persistence-schema.ts";
import { persistenceSql } from "./persistence-sql.ts";
import { State } from "./schema.ts";

export class StatePersistence {
  private readonly sql: ReturnType<typeof persistenceSql>;
  private readonly codec: ArtifactCodec;
  constructor(db: DatabaseSync) {
    this.sql = persistenceSql(db);
    this.codec = new ArtifactCodec(this.sql);
  }
  summary(input: StoredRoot) {
    const spec = this.codec.decoder(input.id)(input.spec);
    if (spec.kind !== "spec") throw new Error("artifact_kind_mismatch");
    return clientSummary({ ...input, spec: spec.data });
  }
  view(input: StoredRoot) {
    const read = this.codec.decoder(input.id);
    const spec = read(input.spec),
      plan = input.plan ? read(input.plan) : null;
    if (spec.kind !== "spec" || (plan && plan.kind !== "plan"))
      throw new Error("artifact_kind_mismatch");
    const lanes = this.sql.clientLanes
      .all(input.id)
      .map((row) => StoredLane.parse(JSON.parse(Payload.parse(row).payload)));
    const nodes = this.sql.nodes
      .all(input.id)
      .map((row) => StoredNode.parse(JSON.parse(Payload.parse(row).payload)));
    if (nodes.length > 256) throw new Error("run_indexes_exceed_capacity");
    return clientView({ ...input, spec: spec.data, plan: plan?.data ?? null }, lanes, nodes);
  }
  /** Cold boundary only. Parse each persisted artifact and the restored state. */
  restore(input: StoredRoot): State {
    const read = this.codec.decoder(input.id);
    const spec = read(input.spec);
    if (spec.kind !== "spec") throw new Error("artifact_kind_mismatch");
    const plan = input.plan ? read(input.plan) : null;
    if (plan && plan.kind !== "plan") throw new Error("artifact_kind_mismatch");
    const laneRows = this.sql.lanes
      .all(input.id)
      .map((row) => StoredLane.parse(JSON.parse(Payload.parse(row).payload)));
    const nodeRows = this.sql.nodes
      .all(input.id)
      .map((row) => StoredNode.parse(JSON.parse(Payload.parse(row).payload)));
    if (laneRows.length > 8192 || nodeRows.length > 256)
      throw new Error("run_indexes_exceed_capacity");
    const lanes = laneRows.map((lane) => {
      const artifact = lane.artifact ? read(lane.artifact) : null;
      if (artifact && artifact.kind !== "artifact") throw new Error("artifact_kind_mismatch");
      return [lane.id, { ...lane, artifact: artifact?.data ?? null }] as const;
    });
    const nodes = nodeRows.map((node) => {
      const completion = node.completion ? read(node.completion) : null;
      const review = node.lastReview ? read(node.lastReview) : null;
      if ((completion && completion.kind !== "completion") || (review && review.kind !== "review"))
        throw new Error("artifact_kind_mismatch");
      return [
        node.id,
        { ...node, completion: completion?.data ?? null, lastReview: review?.data ?? null },
      ] as const;
    });
    const state = State.parse({
      ...input,
      spec: spec.data,
      plan: plan?.data ?? null,
      lanes: Object.fromEntries(lanes),
      nodes: Object.fromEntries(nodes),
    });
    this.codec.remember(input.id, state.spec, input.spec);
    if (state.plan && input.plan) this.codec.remember(input.id, state.plan, input.plan);
    for (const lane of laneRows) {
      const value = state.lanes[lane.id]?.artifact;
      if (value && lane.artifact) this.codec.remember(input.id, value, lane.artifact);
    }
    for (const node of nodeRows) {
      const value = state.nodes[node.id];
      if (value?.completion && node.completion)
        this.codec.remember(input.id, value.completion, node.completion);
      if (value?.lastReview && node.lastReview)
        this.codec.remember(input.id, value.lastReview, node.lastReview);
    }
    return state;
  }
  /** Changed rows only. Immutable artifact references never stringify on heartbeats. */
  write(state: State, previous: State | null, writeRoot: (root: StoredRoot) => void): void {
    const root = this.root(state);
    if (!previous || !sameFields(root, this.root(previous))) writeRoot(root);
    let artifactsChanged =
      !previous || previous.plan !== state.plan || previous.spec !== state.spec;
    if (!previous || previous.lanes !== state.lanes) {
      for (const [id, lane] of Object.entries(state.lanes)) {
        const old = previous?.lanes[id];
        if (old && sameFields(lane, old)) continue;
        const stored = {
          ...lane,
          artifact: lane.artifact ? this.codec.encode(state.id, "artifact", lane.artifact) : null,
        };
        this.sql.writeLane.run(state.id, id, JSON.stringify(stored));
        artifactsChanged ||= lane.artifact !== (old?.artifact ?? null);
      }
      for (const id of Object.keys(previous?.lanes ?? {}))
        if (!Object.hasOwn(state.lanes, id)) {
          this.sql.deleteLane.run(state.id, id);
          artifactsChanged ||= previous?.lanes[id]?.artifact !== null;
        }
    }
    if (!previous || previous.nodes !== state.nodes) {
      for (const [id, node] of Object.entries(state.nodes)) {
        const old = previous?.nodes[id];
        if (old && sameFields(node, old)) continue;
        const stored = {
          ...node,
          completion: node.completion
            ? this.codec.encode(state.id, "completion", node.completion)
            : null,
          lastReview: node.lastReview
            ? this.codec.encode(state.id, "review", node.lastReview)
            : null,
        };
        this.sql.writeNode.run(state.id, id, JSON.stringify(stored));
        artifactsChanged ||=
          node.completion !== (old?.completion ?? null) ||
          node.lastReview !== (old?.lastReview ?? null);
      }
      for (const id of Object.keys(previous?.nodes ?? {}))
        if (!Object.hasOwn(state.nodes, id)) {
          this.sql.deleteNode.run(state.id, id);
          artifactsChanged = true;
        }
    }
    if (artifactsChanged) this.compact(state);
  }
  private root(state: State): StoredRoot {
    const { lanes: _lanes, nodes: _nodes, ...root } = state;
    return {
      ...root,
      storageVersion: 2,
      spec: this.codec.encode(state.id, "spec", state.spec),
      plan: state.plan ? this.codec.encode(state.id, "plan", state.plan) : null,
    };
  }
  private compact(state: State): void {
    const refs = new Set<string>([this.codec.encode(state.id, "spec", state.spec)]);
    if (state.plan) refs.add(this.codec.encode(state.id, "plan", state.plan));
    for (const lane of Object.values(state.lanes))
      if (lane.artifact) refs.add(this.codec.encode(state.id, "artifact", lane.artifact));
    for (const node of Object.values(state.nodes)) {
      if (node.completion) refs.add(this.codec.encode(state.id, "completion", node.completion));
      if (node.lastReview) refs.add(this.codec.encode(state.id, "review", node.lastReview));
    }
    this.codec.compact(state.id, refs);
  }
}
