import type { LocalAgentStore } from "@cursor/sdk";
import { boundedJson } from "@ace/provider-kit/ipc";
import { checkCheckpointBudget } from "./checkpoints.ts";

/** SDK keeps ownership of its format; this decorator admits writes and fences disk growth. */
export function boundedCheckpointStore(
  store: LocalAgentStore,
  root: string,
  maxBytes: number,
  overflow: () => Promise<void>,
): LocalAgentStore {
  let fenced = false;
  const write = async <T>(admit: () => void, operation: () => Promise<T>): Promise<T> => {
    if (fenced) throw new Error("SDK checkpoint writes are fenced");
    try {
      admit();
      await checkCheckpointBudget(root, maxBytes);
      const result = await operation();
      await checkCheckpointBudget(root, maxBytes);
      return result;
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
  };
  return {
    agents: {
      ...store.agents,
      get: (input) => store.agents.get(input),
      list: (input) => store.agents.list(input),
      delete: (input) => store.agents.delete(input),
      create: (input) =>
        write(
          () => {
            boundedJson(input, maxBytes);
          },
          () => store.agents.create(input),
        ),
      update: (input) =>
        write(
          () => {
            boundedJson(input, maxBytes);
          },
          () => store.agents.update(input),
        ),
    },
    runs: {
      ...store.runs,
      get: (input) => store.runs.get(input),
      list: (input) => store.runs.list(input),
      delete: (input) => store.runs.delete(input),
      create: (input) =>
        write(
          () => {
            boundedJson(input, maxBytes);
          },
          () => store.runs.create(input),
        ),
      update: (input) =>
        write(
          () => {
            boundedJson(input, maxBytes);
          },
          () => store.runs.update(input),
        ),
    },
    checkpoints: {
      ...store.checkpoints,
      get: (input) => store.checkpoints.get(input),
      list: (input) => store.checkpoints.list(input),
      delete: (input) => store.checkpoints.delete(input),
      create: (input) =>
        write(
          () => data(input.data),
          () => store.checkpoints.create(input),
        ),
      update: (input) =>
        write(
          () => data(input.data),
          () => store.checkpoints.update(input),
        ),
    },
    runEvents: {
      ...store.runEvents,
      list: (input) => store.runEvents.list(input),
      delete: (input) => store.runEvents.delete(input),
      append: (input) =>
        write(
          () => {
            boundedJson(input, Math.min(262144, maxBytes));
          },
          () => store.runEvents.append(input),
        ),
    },
  };
}
