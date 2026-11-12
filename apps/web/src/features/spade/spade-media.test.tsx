import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  localStorage.clear();
  let made = 0;
  // jsdom has no object URLs.
  URL.createObjectURL = () => `blob:spade/${++made}`;
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hash = (char: string) => char.repeat(64);

function withWriter(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "writer", name: "Writer" });
}

async function openWriter() {
  await userEvent.click(await botRow("Writer"));
  return screen.findByRole("combobox", { name: "Message Writer" });
}

const messagesPath = "/v1/conversations/c-writer/messages";

/** The microphone, recorded by a stand-in MediaRecorder that hands back one chunk. */
function withMicrophone() {
  class FakeRecorder extends EventTarget {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    start() {
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
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
  });
}

/** On-device recognition that hears `words` when stopped, or fails with `error`. */
function withRecognition(outcome: { words: string } | { error: string }) {
  class FakeRecognition extends EventTarget {
    continuous = false;
    interimResults = false;
    lang = "";
    private say(type: string, fields: object = {}) {
      this.dispatchEvent(Object.assign(new Event(type), fields));
    }
    start() {
      if ("error" in outcome) {
        this.say("error", { error: outcome.error });
        this.say("end");
      }
    }
    stop() {
      if ("words" in outcome)
        this.say("result", { results: [{ isFinal: true, 0: { transcript: outcome.words } }] });
      this.say("end");
    }
    abort() {
      this.say("end");
    }
  }
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
}

async function speak() {
  const mic = await screen.findByRole("button", { name: "Record a voice message" });
  mic.focus();
  await userEvent.keyboard("{Enter}");
  const stop = await screen.findByRole("button", { name: "Stop recording" });
  stop.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Voice message attached");
}

test("a PDF attached in the composer goes as a document, and an image still as an image", async () => {
  const { spade } = await spadeApp("/spade", withWriter);
  const message = await openWriter();
  await userEvent.upload(screen.getByLabelText("Files to attach"), [
    new File(["%PDF-1.7 report"], "report.pdf", { type: "application/pdf" }),
    new File(["png bytes"], "chart.png", { type: "image/png" }),
  ]);
  await userEvent.click(message);
  await userEvent.keyboard(" What does section 4 say?");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(spade.sent("POST", messagesPath)).toHaveLength(1));
  const [body] = spade.sent("POST", messagesPath);
  expect(body?.files).toEqual([{ name: "report.pdf", data: btoa("%PDF-1.7 report") }]);
  expect(body?.images).toEqual([{ data: btoa("png bytes") }]);
  // Spade stored it: the person's bubble shows the document's chip.
  await screen.findByRole("group", { name: "report.pdf" });
});

test("a document chip shows its name and pages, and Download saves it under its name without opening it in the app", async () => {
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  const saved: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
  const { spade } = await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, {
      type: "user_message",
      text: "Summarise it",
      documents: [
        {
          sha256: hash("d"),
          name: "report.pdf",
          media_type: "application/pdf",
          bytes: 482_113,
          pages: 12,
          chars: 48_211,
          cut: false,
          view: "…",
        },
      ],
    });
  });
  await openWriter();
  const chip = within(await screen.findByRole("group", { name: "report.pdf" }));
  chip.getByText("12 pages · 482 KB");
  await userEvent.click(chip.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(saved).toEqual([{ href: "blob:spade/1", download: "report.pdf" }]));
  expect(spade.requests.map((request) => request.path)).toContain(
    `/v1/documents/${hash("d")}?name=report.pdf`,
  );
  // Nothing offers to show the file in a tab of the app's own origin.
  expect(chip.queryByRole("button", { name: "Open" })).toBeNull();
  expect(opened).not.toHaveBeenCalled();
});

test("an image a bot's tool showed sits in that reply's bubble with Save", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.images.set(hash("f"), "image/png");
    api.store(writer.conversation, { type: "user_message", text: "Draw it" });
    api.store(writer.conversation, { type: "reply_started", reply: "r1" });
    api.store(writer.conversation, {
      type: "step_finished",
      reply: "r1",
      text: "Here it is.",
      calls: [{ id: "c1", name: "image_generate" }],
    });
    api.store(writer.conversation, {
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "image_generate",
      content: "Shown to the person: 1 image.",
    });
    api.store(writer.conversation, {
      type: "shared",
      reply: "r1",
      call_id: "c1",
      images: [{ sha256: hash("f"), media_type: "image/png", bytes: 9 }],
    });
    api.store(writer.conversation, { type: "reply_finished", reply: "r1", text: "Here it is." });
  });
  await openWriter();
  const replies = await screen.findAllByRole("article", { name: "Writer" });
  const reply = within(replies[replies.length - 1] ?? document.body);
  reply.getByText("Here it is.");
  await reply.findByRole("button", { name: "Save" });
  expect(spade.requests.map((request) => request.path)).toContain(`/v1/images/${hash("f")}`);
  // The call itself never shows.
  expect(screen.queryByText(/image_generate/)).toBeNull();
});

test("the mic is hidden with no speech recognition and no transcription model", async () => {
  withMicrophone();
  await spadeApp("/spade", withWriter);
  await openWriter();
  expect(screen.queryByRole("button", { name: "Record a voice message" })).toBeNull();
});

test("with a transcription model the mic shows, and its words fill the message", async () => {
  withMicrophone();
  const { spade } = await spadeApp("/spade", (api) => {
    withWriter(api);
    api.transcriptionModel = "openrouter/whisper";
    api.transcript = "Book the flight";
  });
  const message = await openWriter();
  await speak();
  await waitFor(() => expect(message.textContent).toBe("Book the flight"));
  expect(spade.sent("POST", "/v1/transcriptions")).toEqual([
    { data: btoa("spoken"), media_type: "audio/webm" },
  ]);
});

test("words heard on the device fill the message, and sending carries the recording", async () => {
  withMicrophone();
  withRecognition({ words: "What does section 4 say" });
  const { spade } = await spadeApp("/spade", withWriter);
  const message = await openWriter();
  await speak();
  await waitFor(() => expect(message.textContent).toBe("What does section 4 say"));
  await userEvent.click(message);
  await userEvent.keyboard("?");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(spade.sent("POST", messagesPath)).toHaveLength(1));
  expect(spade.sent("POST", messagesPath)[0]).toEqual({
    text: "What does section 4 say?",
    voice: {
      data: btoa("spoken"),
      media_type: "audio/webm",
      transcript: "What does section 4 say?",
    },
  });
  expect(spade.sent("POST", "/v1/transcriptions")).toEqual([]);
  await waitFor(() => expect(screen.queryByText("Voice message attached")).toBeNull());
  await screen.findByRole("button", { name: "Play voice message" });
});

test("when on-device recognition can't reach its service, the transcription model hears it", async () => {
  withMicrophone();
  withRecognition({ error: "network" });
  const { spade } = await spadeApp("/spade", (api) => {
    withWriter(api);
    api.transcriptionModel = "openrouter/whisper";
    api.transcript = "Call me later";
  });
  const message = await openWriter();
  await speak();
  await waitFor(() => expect(message.textContent).toBe("Call me later"));
  expect(spade.sent("POST", "/v1/transcriptions")).toHaveLength(1);
});

test("Read aloud speaks the reply's words and becomes Stop reading", async () => {
  const spoken = vi.fn();
  vi.stubGlobal("speechSynthesis", { speak: spoken, cancel: vi.fn() });
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
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, { type: "user_message", text: "Hi" });
    api.store(writer.conversation, { type: "reply_started", reply: "r1" });
    api.store(writer.conversation, { type: "step_finished", reply: "r1", text: "Hello **there**" });
    api.store(writer.conversation, {
      type: "reply_finished",
      reply: "r1",
      text: "Hello **there**",
    });
  });
  await openWriter();
  await userEvent.click(await screen.findByRole("button", { name: "Read aloud" }));
  expect(spoken).toHaveBeenCalledTimes(1);
  expect(spoken.mock.calls[0]?.[0]).toMatchObject({ text: "Hello there" });
  screen.getByRole("button", { name: "Stop reading" });
});

test("Read aloud isn't offered where the system can't speak", async () => {
  vi.stubGlobal("speechSynthesis", undefined);
  await spadeApp("/spade", (api) => {
    const writer = withWriter(api);
    api.store(writer.conversation, { type: "reply_started", reply: "r1" });
    api.store(writer.conversation, { type: "step_finished", reply: "r1", text: "Hello" });
    api.store(writer.conversation, { type: "reply_finished", reply: "r1", text: "Hello" });
  });
  await openWriter();
  await screen.findByText("Hello");
  expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
});

test("choosing a transcription model stores only that setting, leaving the model's facts alone, and Turn off clears it", async () => {
  const saved = {
    id: "saved/model",
    name: "Saved model",
    source: "typed",
    capabilities: ["images"],
  };
  const { spade } = await spadeApp("/settings/spade", (api) => {
    withEndpoint(api);
    api.endpoints[0] = { ...api.endpoints[0], models: [saved] };
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Search models" }), "saved/model");
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/settings")).toEqual([
      { transcription_model: "openrouter/saved/model" },
    ]),
  );
  await screen.findByRole("button", { name: "Turn off" });
  expect(spade.sent("POST", "/v1/endpoints/openrouter/models")).toEqual([]);
  expect(spade.endpoints[0]).toMatchObject({ models: [saved] });
  await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/settings").at(-1)).toEqual({ transcription_model: null }),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull());
});
