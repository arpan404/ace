import type { LocalAgentStore } from "@cursor/sdk";
import { boundedJson } from "@ace/provider-kit/ipc";
import { CheckpointQuota } from "./checkpoint-quota.ts";

/** SDK keeps ownership of its format; this decorator admits writes and fences disk growth. */
export function boundedCheckpointStore(
  store: LocalAgentStore,
  root: string,
  maxBytes: number,
  overflow: () => Promise<void>,
  quota = new CheckpointQuota(root, maxBytes),
): LocalAgentStore {
  let fenced = false;
  const write = async <T>(
    admit: () => number,
    operation: () => Promise<T>,
    agentId?: string,
  ): Promise<T> => {
    if (fenced) throw new Error("SDK checkpoint writes are fenced");
    try {
      return await quota.run(admit(), operation, agentId);
    } catch (error) {
      if (!fenced) {
        fenced = true;
        await overflow();
      }
      throw error;
    }
  };
  const data = (value: Uint8Array) => {
    if (value.byteLength > Math.floor(maxBytes * 0.7))
      throw new Error("SDK checkpoint blob exceeds budget");
    // SQLite database + WAL + index/page slack; also exceeds JSONL base64 growth.
    return (
      Math.ceil(value.byteLength / Math.min(4096, Math.max(1, Math.floor(maxBytes / 64)))) *
        Math.min(4096, Math.max(1, Math.floor(maxBytes / 64))) *
        3 +
      Math.min(131072, Math.floor(maxBytes / 8))
    );
  };
  const metadata = (value: unknown) =>
    Buffer.byteLength(boundedJson(value, maxBytes)) * 3 +
    Math.min(131072, Math.floor(maxBytes / 8));
  return {
    agents: {
      ...store.agents,
      get: (input) => store.agents.get(input),
      list: (input) => store.agents.list(input),
      delete: (input) =>
        write(
          () => metadata(input),
          () => store.agents.delete(input),
        ),
      create: (input) =>
        write(
          () => metadata(input),
          () => store.agents.create(input),
          input.agent.agentId,
        ),
      update: (input) =>
        write(
          () => metadata(input),
          () => store.agents.update(input),
          input.agent.agentId,
        ),
    },
    runs: {
      ...store.runs,
      get: (input) => store.runs.get(input),
      list: (input) => store.runs.list(input),
      delete: (input) =>
        write(
          () => metadata(input),
          () => store.runs.delete(input),
        ),
      create: (input) =>
        write(
          () => metadata(input),
          () => store.runs.create(input),
          input.run.agentId,
        ),
      update: (input) =>
        write(
          () => metadata(input),
          () => store.runs.update(input),
          input.run.agentId,
        ),
    },
    checkpoints: {
      ...store.checkpoints,
      get: (input) => store.checkpoints.get(input),
      list: (input) => store.checkpoints.list(input),
      delete: (input) =>
        write(
          () => metadata(input),
          () => store.checkpoints.delete(input),
        ),
      create: (input) =>
        write(
          () => data(input.data),
          () => store.checkpoints.create(input),
          input.agentId,
        ),
      update: (input) =>
        write(
          () => data(input.data),
          () => store.checkpoints.update(input),
          input.agentId,
        ),
    },
    runEvents: {
      ...store.runEvents,
      list: (input) => store.runEvents.list(input),
      delete: (input) =>
        write(
          () => metadata(input),
          () => store.runEvents.delete(input),
        ),
      append: (input) =>
        write(
          () => metadata(input),
          () => store.runEvents.append(input),
        ),
    },
  };
}
