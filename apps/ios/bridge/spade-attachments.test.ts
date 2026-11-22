import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeBubbleRow } from "./spade-rows.ts";

/*
 * Photos, files and voice from the iPhone's Spade composer, over the real SDK and the fake
 * daemon's Spade: what reaches Spade, what Spade's limits refuse before anything goes, and how
 * a message's documents and recording show and open in the conversation.
 */

const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text).toString("base64");

async function openBot(seed: (fake: FakeSpadeApi) => void = () => {}) {
  let conversation = "";
  const set = await setUp((fake) => {
    conversation = fake.addAgent({ name: "Helper" }).conversation;
    seed(fake);
  });
  set.spade.handle({ type: "spade.open", conversationId: conversation });
  await until(() => set.patches.head?.loaded === true);
  const posted = () => set.api.sent("POST", `/v1/conversations/${conversation}/messages`);
  return { ...set, conversation, posted };
}

const sha = (letter: string) => letter.repeat(64);

const person = (rows: SpadeBubbleRow[]) =>
  rows.find((row): row is Extract<SpadeBubbleRow, { kind: "person" }> => row.kind === "person");

test("a photo, a PDF and a voice recording reach Spade in one message, as Spade takes them", async () => {
  const { ask, stage, conversation, posted, patches } = await openBot();
  const photo = stage("Photo.jpg", "image/jpeg", bytes("jpeg bytes"));
  const pdf = stage("brief.pdf", "application/pdf", bytes("pdf bytes"));
  const voice = stage("Voice message.m4a", "audio/mp4", bytes("m4a bytes"));

  const outcome = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "Read these",
    files: [photo, pdf],
    voice,
  });

  expect(outcome).toEqual({ ok: true });
  expect(posted()).toEqual([
    {
      text: "Read these",
      images: [{ data: b64("jpeg bytes") }],
      files: [{ name: "brief.pdf", data: b64("pdf bytes") }],
      voice: { data: b64("m4a bytes"), media_type: "audio/mp4", transcript: "Read these" },
    },
  ]);
  const shown = await until(() => {
    const row = person(patches.bubbles);
    return row && !row.sending && row;
  });
  expect(shown.images.map((line) => line.ref)).toEqual([photo.sha256]);
  expect(shown.files).toEqual([
    expect.objectContaining({ kind: "pdf", name: "brief.pdf", ref: `document:${pdf.sha256}` }),
  ]);
  expect(shown.voice).toEqual({ ref: voice.sha256, mimeType: "audio/mp4", bytes: 9 });
});

test("a file Spade doesn't take as a picture goes as a document", async () => {
  const { ask, stage, conversation, posted } = await openBot();
  const heic = stage("Photo.heic", "image/heic", bytes("heic"));

  await ask({ type: "spade.send", conversationId: conversation, text: "", files: [heic] });

  expect(posted()).toEqual([{ text: "", files: [{ name: "Photo.heic", data: b64("heic") }] }]);
});

test("a ninth image is refused with Spade's sentence before anything is sent", async () => {
  const { ask, stage, conversation, posted, patches } = await openBot();
  const nine = Array.from({ length: 9 }, (_, at) =>
    stage(`Photo ${at}.png`, "image/png", bytes(`png ${at}`)),
  );

  const outcome = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "All of them",
    files: nine,
  });

  expect(outcome).toMatchObject({
    ok: false,
    message: "Spade takes at most 8 images in a message.",
  });
  expect(posted()).toEqual([]);
  expect(patches.bubbles).toEqual([]);
});

test("an image over 3.75 MB, or a document over 32 MB, is refused by name and nothing goes", async () => {
  const { ask, stage, conversation, posted } = await openBot();
  const big = { ...stage("Big.png", "image/png", bytes("png")), bytes: 3_750_001 };
  const huge = { ...stage("huge.zip", "application/zip", bytes("zip")), bytes: 32_000_001 };

  const image = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "",
    files: [big],
  });
  const document = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "",
    files: [huge],
  });

  expect(image).toMatchObject({
    ok: false,
    message: "Big.png is larger than 3.75 MB, the most Spade takes.",
  });
  expect(document).toMatchObject({
    ok: false,
    message: "huge.zip is larger than 32 MB, the most Spade takes.",
  });
  expect(posted()).toEqual([]);
});

test("a recording over 25 MB is refused before it is read", async () => {
  const { ask, stage, conversation, posted } = await openBot();
  const long = { ...stage("Voice.m4a", "audio/mp4", bytes("m4a")), bytes: 25_000_001 };

  const outcome = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "",
    voice: long,
  });

  expect(outcome).toMatchObject({
    ok: false,
    message: "The recording is longer than Spade takes (25 MB).",
  });
  expect(posted()).toEqual([]);
});

test("a voice message on its own goes with the words Spade's transcription model heard", async () => {
  const { ask, stage, conversation, posted, api } = await openBot((fake) => {
    fake.transcriptionModel = "openai/whisper-1";
    fake.transcript = "Remind me at five";
  });
  const voice = stage("Voice message.m4a", "audio/mp4", bytes("spoken"));

  const outcome = await ask({ type: "spade.send", conversationId: conversation, text: "", voice });

  expect(outcome).toEqual({ ok: true });
  expect(api.sent("POST", "/v1/transcriptions")).toEqual([
    { data: b64("spoken"), media_type: "audio/mp4" },
  ]);
  expect(posted()).toEqual([
    {
      text: "Remind me at five",
      voice: { data: b64("spoken"), media_type: "audio/mp4", transcript: "Remind me at five" },
    },
  ]);
});

test("with no transcription model, a voice message alone says how to set one and nothing goes", async () => {
  const { ask, stage, conversation, posted, patches } = await openBot();
  const voice = stage("Voice message.m4a", "audio/mp4", bytes("spoken"));

  const outcome = await ask({ type: "spade.send", conversationId: conversation, text: "", voice });

  expect(outcome).toMatchObject({
    ok: false,
    message: "Choose a transcription model in Settings › Spade to send voice messages.",
  });
  expect(posted()).toEqual([]);
  expect(patches.bubbles).toEqual([]);
});

test("a file no longer on the phone refuses the message, and nothing is half-sent", async () => {
  const { ask, stage, staged, conversation, posted, patches } = await openBot();
  const photo = stage("Photo.png", "image/png", bytes("png"));
  const pdf = stage("notes.pdf", "application/pdf", bytes("pdf"));
  staged.delete(pdf.localId);

  const outcome = await ask({
    type: "spade.send",
    conversationId: conversation,
    text: "Both",
    files: [photo, pdf],
  });

  expect(outcome).toMatchObject({
    ok: false,
    message: "notes.pdf is no longer on this phone. Attach it again.",
  });
  expect(posted()).toEqual([]);
  expect(patches.bubbles).toEqual([]);
});

test("a message with no words and nothing attached isn't sent", async () => {
  const { ask, conversation, posted } = await openBot();

  const outcome = await ask({ type: "spade.send", conversationId: conversation, text: "  " });

  expect(outcome).toMatchObject({ ok: false });
  expect(posted()).toEqual([]);
});

test("a bot's pictures and documents show in its bubble, and a document and recording open", async () => {
  const { ask, patches } = await openBot((fake) => {
    const bot = fake.agents.at(-1);
    if (!bot) return;
    fake.store(bot.conversation, {
      type: "user_message",
      text: "Listen",
      voice: { sha256: sha("a"), media_type: "audio/mp4", bytes: 2048 },
    });
    fake.reply(bot, "Here is the report", "r1");
    fake.store(bot.conversation, {
      type: "shared",
      reply: "r1",
      call_id: "c1",
      images: [{ sha256: sha("b"), media_type: "image/png", bytes: 100 }],
      documents: [
        {
          sha256: sha("c"),
          name: "report.pdf",
          media_type: "application/pdf",
          bytes: 4096,
          pages: 3,
        },
      ],
    });
  });
  const bot = await until(() =>
    patches.bubbles.find(
      (row): row is Extract<SpadeBubbleRow, { kind: "bot" }> =>
        row.kind === "bot" && row.files.length > 0,
    ),
  );
  expect(bot.text).toBe("Here is the report");
  expect(bot.images.map((line) => line.ref)).toEqual([sha("b")]);
  expect(bot.files).toEqual([
    expect.objectContaining({
      kind: "pdf",
      name: "report.pdf",
      ref: `document:${sha("c")}`,
      opens: true,
    }),
  ]);
  expect(person(patches.bubbles)?.voice).toEqual({
    ref: sha("a"),
    mimeType: "audio/mp4",
    bytes: 2048,
  });

  const document = await ask({ type: "spade.document", sha256: sha("c"), name: "report.pdf" });
  const recording = await ask({ type: "spade.audio", sha256: sha("a") });

  expect(document).toEqual({
    ok: true,
    kind: "file",
    name: "report.pdf",
    mimeType: "application/octet-stream",
    data: b64(`bytes of ${sha("c")}`),
  });
  expect(recording).toEqual({
    ok: true,
    kind: "file",
    name: "Voice message",
    mimeType: "audio/webm",
    data: b64(`bytes of ${sha("a")}`),
  });
});
