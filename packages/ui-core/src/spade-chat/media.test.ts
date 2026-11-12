import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeEvent,
  parseSpadeLiveFrame,
  parseSpadeModels,
  spadeBubbles,
  spadeDocumentFacts,
  spadeModelCan,
  spadeView,
} from "./index.ts";

const hash = (char: string) => char.repeat(64);

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
    if (input) foldSpade(state, input);
  };
  return { stored, bubbles: () => spadeBubbles(spadeView(state)) };
}

const report = {
  sha256: hash("d"),
  name: "report.pdf",
  media_type: "application/pdf",
  bytes: 482_113,
  pages: 12,
  chars: 48_211,
  cut: false,
  view: "…",
};

describe("documents and voice on the person's messages", () => {
  test("documents and a recording are read; entries without a hash or name are left out", () => {
    const event = parseSpadeEvent({
      type: "user_message",
      text: "What does section 4 say?",
      documents: [report, { sha256: "nope", name: "bad.pdf" }, { sha256: hash("e") }, 7],
      voice: { sha256: hash("a"), media_type: "audio/webm", bytes: 81_234 },
    });
    expect(event.type).toBe("user_message");
    if (event.type !== "user_message") return;
    expect(event.documents.map((doc) => doc.name)).toEqual(["report.pdf"]);
    expect(event.documents[0]).toMatchObject({ pages: 12, sheets: undefined, cut: false });
    expect(event.voice).toEqual({ sha256: hash("a"), mediaType: "audio/webm", bytes: 81_234 });
  });

  test("an unreadable recording leaves a message with its words", () => {
    const event = parseSpadeEvent({ type: "user_message", text: "Hi", voice: { sha256: 3 } });
    expect(event).toMatchObject({ type: "user_message", text: "Hi", voice: undefined });
  });

  test("the person's bubble carries its documents and recording", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: "Read this",
      documents: [report],
      voice: { sha256: hash("a"), media_type: "audio/ogg", bytes: 10 },
    });
    expect(c.bubbles()).toMatchObject([
      {
        kind: "person",
        text: "Read this",
        documents: [{ name: "report.pdf" }],
        voice: { mediaType: "audio/ogg" },
      },
    ]);
  });

  test("a sent message shows its documents while it waits to be stored", () => {
    const state = emptySpadeConversation();
    foldSpade(state, {
      kind: "sent",
      key: "local-1",
      text: "",
      documents: [
        {
          sha256: hash("d"),
          name: "notes.md",
          mediaType: "text/markdown",
          bytes: 4,
          pages: undefined,
          sheets: undefined,
          chars: 0,
          cut: false,
        },
      ],
    });
    expect(spadeBubbles(spadeView(state))).toMatchObject([
      { kind: "person", sending: true, documents: [{ name: "notes.md" }] },
    ]);
  });
});

describe("what a bot's tools show", () => {
  test("shared images and documents go in that reply's bubble, after its words", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Chart it" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Making it.",
      calls: [{ id: "c1", name: "image_generate" }],
    });
    c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "image_generate" });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "image_generate",
      content: "Shown to the person: 1 image.",
      shared_images: [
        { sha256: hash("f"), media_type: "image/png", bytes: 81_234 },
        { sha256: "short" },
      ],
      shared_documents: [{ ...report, name: "data.csv", pages: undefined }],
    });
    c.stored({ type: "step_finished", reply: "r1", text: "Here it is." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Here it is." });
    const bubbles = c.bubbles();
    expect(bubbles.map((bubble) => bubble.kind)).toEqual(["person", "bot"]);
    expect(bubbles[1]).toMatchObject({
      kind: "bot",
      text: "Making it.\n\nHere it is.",
      images: [{ sha256: hash("f") }],
      documents: [{ name: "data.csv" }],
    });
  });

  test("an image shared by a reply that said nothing still shows as the bot's bubble", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", calls: [{ id: "c1", name: "share_file" }] });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "share_file",
      shared_images: [{ sha256: hash("b"), media_type: "image/webp", bytes: 9 }],
    });
    expect(c.bubbles()).toMatchObject([{ kind: "bot", text: "", images: [{ sha256: hash("b") }] }]);
  });

  test("a tool that showed nothing adds nothing to the chat", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", calls: [{ id: "c1", name: "web_fetch" }] });
    c.stored({ type: "tool_finished", reply: "r1", call_id: "c1", name: "web_fetch" });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(c.bubbles()).toEqual([]);
  });
});

test("a document's chip says its pages or sheets and its size", () => {
  expect(spadeDocumentFacts({ pages: 12, sheets: undefined, bytes: 482_113 })).toBe(
    "12 pages · 482 KB",
  );
  expect(spadeDocumentFacts({ pages: undefined, sheets: 1, bytes: 1_200_000 })).toBe(
    "1 sheet · 1.2 MB",
  );
  expect(spadeDocumentFacts({ pages: undefined, sheets: undefined, bytes: 4_000 })).toBe("4 KB");
});

test("the models list names the transcription model and models that can transcribe", () => {
  const models = parseSpadeModels(
    JSON.stringify({
      endpoints: [
        {
          id: "openai",
          base_url: "https://api.openai.com/v1/",
          models: [{ id: "whisper-1", capabilities: ["transcription"] }, { id: "gpt" }],
        },
      ],
      transcription_model: "openai/whisper-1",
    }),
  );
  expect(models?.transcriptionModel).toBe("openai/whisper-1");
  const [whisper, gpt] = models?.endpoints[0]?.models ?? [];
  expect(whisper && spadeModelCan(whisper, "transcription")).toBe(true);
  expect(gpt && spadeModelCan(gpt, "transcription")).toBe(false);
  expect(parseSpadeModels("{}")?.transcriptionModel).toBeUndefined();
});
