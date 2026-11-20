import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { withAudioPlayback, withSystemSpeech } from "@/test/spade-voice.ts";

/*
 * Replies read aloud as they are written (ADR 0134, amended): the first sentence is spoken
 * before the reply ends, code isn't read, Esc and Stop cut speech off, and with a speech model
 * the words go to Spade's `POST /v1/speech`.
 */

configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  localStorage.clear();
  let made = 0;
  URL.createObjectURL = () => `blob:spade/${++made}`;
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Speak replies on for every bot, as Settings › Spade turns it on. */
const speakReplies = () =>
  localStorage.setItem(
    "ace.spade.voice.v1",
    JSON.stringify({ defaults: { speakReplies: true }, bots: {} }),
  );

function withWriter(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "writer", name: "Writer" });
}

/**
 * The Writer's chat, open and following live: the person's message shown proves its stream is
 * open, so words streamed after it arrive.
 */
async function openWriter(seed: (api: FakeSpadeApi) => void = () => {}) {
  const opened = await spadeApp("/spade/writer", (api) => {
    withWriter(api);
    seed(api);
  });
  await screen.findByRole("combobox", { name: "Message Writer" });
  opened.spade.store("c-writer", { type: "user_message", text: "Over to you" });
  await screen.findByText("Over to you");
  return opened;
}

test("speech starts with the first sentence while the reply is still being written", async () => {
  speakReplies();
  const speech = withSystemSpeech();
  const { spade } = await openWriter();
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "Your flight leaves at nine. Bring");
  await waitFor(() => expect(speech.said).toEqual(["Your flight leaves at nine."]));
  // The rest isn't a sentence yet: nothing more is said.
  spade.delta("c-writer", "r1", " your passport");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(speech.said).toEqual(["Your flight leaves at nine."]);
});

test("Esc stops the speech at once, and the rest of the reply isn't read", async () => {
  speakReplies();
  const speech = withSystemSpeech();
  const { spade } = await openWriter();
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "First. Second. ");
  await waitFor(() => expect(speech.said).toEqual(["First."]));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(speech.counts.cancels).toBeGreaterThan(0);
  spade.delta("c-writer", "r1", "Third. ");
  spade.store("c-writer", { type: "step_finished", reply: "r1", text: "First. Second. Third." });
  spade.store("c-writer", { type: "reply_finished", reply: "r1", text: "First. Second. Third." });
  await screen.findByText(/Third\./);
  expect(speech.said).toEqual(["First."]);
});

test("a code block is never read aloud: one line says it is on screen", async () => {
  speakReplies();
  const speech = withSystemSpeech({ endsAfterMs: 5 });
  const { spade } = await openWriter();
  const text = "Run this:\n```sh\nrm -rf build. Then rebuild.\n```\nThat clears it.";
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", text);
  spade.store("c-writer", { type: "step_finished", reply: "r1", text });
  spade.store("c-writer", { type: "reply_finished", reply: "r1", text });
  await waitFor(() =>
    expect(speech.said.join(" ")).toBe("Run this: The code is on screen. That clears it."),
  );
  expect(speech.said.join(" ")).not.toContain("rebuild");
});

test("replies already in the chat when it opens are never read", async () => {
  speakReplies();
  const speech = withSystemSpeech();
  await openWriter((api) => {
    api.store("c-writer", { type: "reply_started", reply: "old" });
    api.store("c-writer", { type: "step_finished", reply: "old", text: "From yesterday." });
    api.store("c-writer", { type: "reply_finished", reply: "old", text: "From yesterday." });
  });
  await screen.findByText("From yesterday.");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(speech.said).toEqual([]);
});

test("Stop stops the bot and its speech together", async () => {
  speakReplies();
  const speech = withSystemSpeech();
  const { spade } = await openWriter();
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "Working on it. ");
  await waitFor(() => expect(speech.said).toEqual(["Working on it."]));
  const before = speech.counts.cancels;
  await userEvent.click(await screen.findByRole("button", { name: "Stop the agent" }));
  expect(speech.counts.cancels).toBeGreaterThan(before);
  await waitFor(() => expect(spade.sent("POST", "/v1/conversations/c-writer/stop")).toHaveLength(1));
});

test("with a speech model, the words go to Spade's speech route and its audio plays", async () => {
  speakReplies();
  withSystemSpeech();
  const played = withAudioPlayback();
  const { spade } = await openWriter((api) => {
    api.speechModel = "openrouter/tts-1";
  });
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "Booked. Your seat is 12A. ");
  await waitFor(() => expect(spade.spoken).toEqual(["Booked.", "Your seat is 12A."]));
  await waitFor(() => expect(played).toHaveLength(2));
  expect(spade.sent("POST", "/v1/speech")[0]).toEqual({ text: "Booked." });
});
