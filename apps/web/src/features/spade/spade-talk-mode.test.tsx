import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { talk, withLoudMicrophone, withSystemSpeech } from "@/test/spade-voice.ts";

/*
 * A spoken conversation (ADR 0134, amended): hands free, the end of what the person said sends
 * it and the reply is spoken; talking over the reply stops it; the desktop's push-to-talk
 * shortcut opens the main Spade and sends what was said. The microphone's loudness is the only
 * thing the test plays; ace's own detector decides when the person spoke.
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
  Reflect.deleteProperty(window, "ace");
});

function withBots(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  api.addAgent({ id: "writer", name: "Writer" });
  api.transcriptionModel = "openrouter/whisper";
  api.transcript = "Book the nine o'clock train";
}

const sentTo = (spade: FakeSpadeApi, conversation: string) =>
  spade.sent("POST", `/v1/conversations/${conversation}/messages`);

test("hands free, the end of what the person said sends it, spoken, and the reply is read aloud", async () => {
  const mic = withLoudMicrophone();
  const speech = withSystemSpeech();
  const { spade } = await spadeApp("/spade/writer", withBots);
  await userEvent.click(await screen.findByRole("button", { name: "Talk with Writer" }));
  await screen.findByText("Listening");
  await talk(mic, () => screen.findByText("Hearing you"));
  await waitFor(() => expect(sentTo(spade, "c-writer")).toHaveLength(1));
  expect(sentTo(spade, "c-writer")[0]).toEqual({
    text: "Book the nine o'clock train",
    voice: {
      data: btoa("spoken"),
      media_type: "audio/webm",
      transcript: "Book the nine o'clock train",
    },
  });
  await screen.findByText("Writer is thinking");
  // Spoken to, the bot answers aloud though Speak replies is off.
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "Done, you're on the nine o'clock. ");
  await waitFor(() => expect(speech.said).toEqual(["Done, you're on the nine o'clock."]));
  await screen.findByText(/Writer is speaking/);

  // Barge-in: talking over the reply stops it at once, and the person is heard again.
  const cancels = speech.counts.cancels;
  const recordings = mic.recordings;
  mic.level = 0.3;
  await screen.findByText("Hearing you");
  expect(speech.counts.cancels).toBeGreaterThan(cancels);
  expect(mic.recordings).toBe(recordings + 1);

  await userEvent.click(screen.getByRole("button", { name: "End" }));
  await waitFor(() => expect(mic.released).toBe(1));
  expect(screen.queryByText("Hearing you")).toBeNull();
});

test("a voice message checked in the field and sent is answered aloud", async () => {
  withLoudMicrophone();
  const speech = withSystemSpeech();
  const { spade } = await spadeApp("/spade/writer", withBots);
  const mic = await screen.findByRole("button", { name: "Record a voice message" });
  mic.focus();
  await userEvent.keyboard("{Enter}");
  const stop = await screen.findByRole("button", { name: "Stop recording" });
  stop.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Voice message attached");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sentTo(spade, "c-writer")).toHaveLength(1));
  await screen.findByText("Book the nine o'clock train");
  spade.store("c-writer", { type: "reply_started", reply: "r1" });
  spade.delta("c-writer", "r1", "On it. ");
  await waitFor(() => expect(speech.said).toEqual(["On it."]));
});

test("the desktop's push-to-talk shortcut opens the main Spade and sends what was said", async () => {
  const mic = withLoudMicrophone();
  withSystemSpeech();
  let press: ((phase: unknown) => void) | undefined;
  const reported: string[] = [];
  Reflect.set(window, "ace", {
    spade: {
      onTalk(listener: (phase: unknown) => void) {
        press = listener;
        return () => {};
      },
      talkState: (state: string) => {
        reported.push(state);
        return Promise.resolve();
      },
    },
  });
  const { spade } = await spadeApp("/spade/writer", withBots);
  await screen.findByRole("combobox", { name: "Message Writer" });
  press?.("start");
  await screen.findByRole("combobox", { name: "Message Spade" });
  await waitFor(() => expect(reported).toContain("listening"));
  await talk(mic, () => waitFor(() => expect(reported).toContain("hearing")));
  await waitFor(() => expect(sentTo(spade, "c-main")).toHaveLength(1));
  expect(sentTo(spade, "c-main")[0]).toMatchObject({ text: "Book the nine o'clock train" });
  expect(sentTo(spade, "c-writer")).toEqual([]);
  await waitFor(() => expect(reported).toContain("thinking"));
  // A press with nothing said lets go.
  press?.("cancel");
  await waitFor(() => expect(reported.at(-1)).toBe("off"));
});

test("with no way to turn speech into words, the mic offers the endpoint that can, in one click", async () => {
  withLoudMicrophone();
  const { spade } = await spadeApp("/spade/writer", (api) => {
    withBots(api);
    api.transcriptionModel = null;
    api.liveModels.set("openrouter", [
      { id: "openai/gpt-5", name: "GPT-5" },
      { id: "openai/whisper-1", name: "Whisper" },
    ]);
  });
  await userEvent.click(await screen.findByRole("button", { name: "Record a voice message" }));
  await userEvent.click(await screen.findByRole("button", { name: "Use OpenRouter · Whisper" }));
  await waitFor(() => expect(spade.transcriptionModel).toBe("openrouter/openai/whisper-1"));
  await waitFor(() => expect(screen.queryByText(/Choose how to turn speech/)).toBeNull());
});

test("when none of the person's endpoints can turn speech into words, the mic says so plainly", async () => {
  withLoudMicrophone();
  await spadeApp("/spade/writer", (api) => {
    withBots(api);
    api.transcriptionModel = null;
  });
  await userEvent.click(await screen.findByRole("button", { name: "Talk with Writer" }));
  await screen.findByText(/None of your endpoints turns speech into words/);
  screen.getByRole("button", { name: "Open Models" });
});
