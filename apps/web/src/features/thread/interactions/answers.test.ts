import { expect, test } from "vitest";
import { answerStorageKey, createAnswerStore } from "./answers.ts";

function memory(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(answerStorageKey, initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const answer = { kind: "question" as const, answers: { recovery: ["persist"] } };

test("an accepted answer is remembered across reloads with the request it answered", () => {
  const storage = memory();
  const store = createAnswerStore({ storage, now: () => 42 });
  store.sending("ask-1", answer, "call-1:hash");
  store.sent("ask-1");
  const reloaded = createAnswerStore({ storage, now: () => 0 });
  expect(reloaded.get("ask-1")).toEqual({
    resolution: answer,
    state: "sent",
    at: 42,
    identity: "call-1:hash",
  });
});

test("an answer the daemon refused is forgotten, and nothing unsent is stored", () => {
  const storage = memory();
  const store = createAnswerStore({ storage, now: () => 1 });
  store.sending("ask-1", answer);
  expect(store.get("ask-1")?.state).toBe("sending");
  store.failed("ask-1");
  expect(store.get("ask-1")).toBeUndefined();
  expect(storage.values.has(answerStorageKey)).toBe(false);
});

test("corrupt or foreign stored answers are dropped instead of reaching the UI", () => {
  for (const stored of [
    JSON.stringify([
      ["ask-1", { resolution: { kind: "question", answers: { recovery: 42 } }, at: 1 }],
    ]),
    JSON.stringify([["ask-1", { resolution: { kind: "nonsense" }, at: 1 }]]),
    JSON.stringify({ "ask-1": answer }),
    "{not json",
  ]) {
    const store = createAnswerStore({ storage: memory(stored), now: () => 1 });
    expect(store.get("ask-1")).toBeUndefined();
  }
});

test("storage that throws leaves answers in memory for the session", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  const store = createAnswerStore({ storage: broken, now: () => 1 });
  store.sending("ask-1", answer);
  store.sent("ask-1");
  expect(store.get("ask-1")?.state).toBe("sent");
});
