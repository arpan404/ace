import { expect, test } from "vitest";
import { answerStorageKey, createAnswerStore } from "./answers.ts";
import { pendingAnswers } from "./pending-answers.ts";

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
  store.remember("ask-1", answer, "call-1:hash");
  const reloaded = createAnswerStore({ storage, now: () => 0 });
  expect(reloaded.get("ask-1")).toEqual({
    resolution: answer,
    state: "sent",
    at: 42,
    identity: "call-1:hash",
  });
});

test("an answer still on its way is never stored, and leaves when it settles", () => {
  const storage = memory();
  createAnswerStore({ storage, now: () => 1 });
  pendingAnswers.set("ask-1", answer);
  expect(pendingAnswers.get("ask-1")).toEqual(answer);
  expect(storage.values.has(answerStorageKey)).toBe(false);
  pendingAnswers.clear("ask-1");
  expect(pendingAnswers.get("ask-1")).toBeUndefined();
});

test("forgetting an answer lets the request be answered again, across reloads", () => {
  const storage = memory();
  const store = createAnswerStore({ storage, now: () => 1 });
  store.remember("ask-1", answer, "call-1:hash");
  store.forget("ask-1");
  expect(createAnswerStore({ storage, now: () => 1 }).get("ask-1")).toBeUndefined();
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
  store.remember("ask-1", answer);
  expect(store.get("ask-1")?.state).toBe("sent");
});
