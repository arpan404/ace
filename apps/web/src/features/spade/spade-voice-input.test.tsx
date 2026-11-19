import type { FakeSpadeApi } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/*
 * The mic and Read aloud across the chat's lifetime: a microphone granted late, a press let go
 * or taken away before or while recording, and speech left running when the chat goes.
 */

configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withWriter(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const writer = api.addAgent({ id: "writer", name: "Writer" });
  api.transcriptionModel = "openrouter/whisper";
  api.transcript = "Book the flight";
  return writer;
}

/**
 * A microphone whose permission is answered when the test says (`grant`), and a recorder that
 * says how many recordings began. Each granted stream's tracks count their stops.
 */
function withSlowMicrophone(options: { grantAtOnce?: boolean } = {}) {
  const recordings = { started: 0, trackStops: 0 };
  let grant: (() => void) | undefined;
  class FakeRecorder extends EventTarget {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    start() {
      recordings.started++;
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), {
          data: new Blob(["spoken"], { type: "audio/webm" }),
        }),
      );
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const stream = { getTracks: () => [{ stop: () => recordings.trackStops++ }] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        options.grantAtOnce
          ? Promise.resolve(stream)
          : new Promise((resolve) => {
              grant = () => resolve(stream);
            }),
    },
  });
  return { recordings, grant: () => grant?.() };
}

const mic = () =>
  screen.findByRole("button", { name: /^(Record a voice message|Stop recording)$/ });
/** Long enough that a release counts as the end of a hold, not a tap. */
const holdLonger = () => new Promise((resolve) => setTimeout(resolve, 450));

test("a microphone granted after leaving the chat records nothing and is let go at once", async () => {
  const { recordings, grant } = withSlowMicrophone();
  const history = createMemoryHistory({ initialEntries: ["/spade/writer"] });
  await spadeApp("/spade/writer", withWriter, { history });
  fireEvent.pointerDown(await mic(), { button: 0 });
  history.push("/settings/spade");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Record a voice message" })).toBeNull(),
  );
  grant();
  await waitFor(() => expect(recordings.trackStops).toBe(1));
  expect(recordings.started).toBe(0);
});

test("letting go of a held mic before it records ends there, with nothing recorded", async () => {
  const { recordings, grant } = withSlowMicrophone();
  const { spade } = await spadeApp("/spade/writer", withWriter);
  const button = await mic();
  fireEvent.pointerDown(button, { button: 0 });
  await holdLonger();
  fireEvent.pointerUp(button, { button: 0 });
  grant();
  await waitFor(() => expect(recordings.trackStops).toBe(1));
  expect(recordings.started).toBe(0);
  expect(screen.queryByText("Recording")).toBeNull();
  expect(spade.sent("POST", "/v1/transcriptions")).toEqual([]);
  // The mic is ready for the next press.
  fireEvent.pointerDown(button, { button: 0 });
  grant();
  await screen.findByRole("button", { name: "Stop recording" });
});

test("a held recording the system takes the pointer from stops, and its words fill the message", async () => {
  const { recordings } = withSlowMicrophone({ grantAtOnce: true });
  const { spade } = await spadeApp("/spade/writer", withWriter);
  const message = await screen.findByRole("combobox", { name: "Message Writer" });
  fireEvent.pointerDown(await mic(), { button: 0 });
  const stop = await screen.findByRole("button", { name: "Stop recording" });
  fireEvent.pointerCancel(stop);
  await waitFor(() => expect(message.textContent).toBe("Book the flight"));
  expect(recordings.started).toBe(1);
  expect(spade.sent("POST", "/v1/transcriptions")).toHaveLength(1);
});

test("a tapped mic keeps recording after the release, until the next press", async () => {
  withSlowMicrophone({ grantAtOnce: true });
  const { spade } = await spadeApp("/spade/writer", withWriter);
  const button = await mic();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.pointerUp(button, { button: 0 });
  // The capture ends with the release; that is not the press being taken away.
  fireEvent(button, new Event("lostpointercapture", { bubbles: true }));
  await screen.findByRole("button", { name: "Stop recording" });
  expect(spade.sent("POST", "/v1/transcriptions")).toEqual([]);
  fireEvent.pointerDown(button, { button: 0 });
  await waitFor(() => expect(spade.sent("POST", "/v1/transcriptions")).toHaveLength(1));
});

test("Read aloud stops when the person leaves the chat", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class extends EventTarget {
      text: string;
      constructor(text: string) {
        super();
        this.text = text;
      }
    },
  );
  const history = createMemoryHistory({ initialEntries: ["/spade/writer"] });
  await spadeApp(
    "/spade/writer",
    (api) => {
      const writer = withWriter(api);
      api.store(writer.conversation, { type: "user_message", text: "Hi" });
      api.store(writer.conversation, { type: "reply_started", reply: "r1" });
      api.store(writer.conversation, { type: "step_finished", reply: "r1", text: "Hello" });
      api.store(writer.conversation, { type: "reply_finished", reply: "r1", text: "Hello" });
    },
    { history },
  );
  await userEvent.click(await screen.findByRole("button", { name: "Read aloud" }));
  await screen.findByRole("button", { name: "Stop reading" });
  const beforeLeaving = cancel.mock.calls.length;
  history.push("/settings/spade");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop reading" })).toBeNull());
  expect(cancel.mock.calls.length).toBeGreaterThan(beforeLeaving);
});
