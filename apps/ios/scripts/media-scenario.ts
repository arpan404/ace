import { createHash } from "node:crypto";
import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";

export function seedNativeMedia(daemon: FakeDaemon): void {
  const threadId = "ios-media";
  const html =
    '<!doctype html><html><head><title>Counter</title></head><body><h1>Native canvas</h1><button id="next">Next</button><p id="value">Step 1</p><script>let step=1;document.getElementById("next").addEventListener("click",()=>document.getElementById("value").textContent="Step "+(++step));</script></body></html>';
  const sha256 = createHash("sha256").update(html).digest("hex");
  daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    provider: "codex",
    title: "Canvas and image",
    hasSentMessage: true,
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "item.upsert",
      agent: "root",
      item: "native-page",
      draft: {
        type: "html",
        complete: true,
        visualization: {
          title: "Interactive counter",
          mode: "interactive",
          document: {
            sha256,
            bytes: Buffer.byteLength(html),
            mimeType: "text/plain",
            name: "canvas.html",
          },
        },
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "native-image",
      draft: {
        type: "image",
        complete: true,
        image: {
          alt: "Orange fixture image",
          attachment: {
            sha256: fixtureImage.sha256,
            bytes: Buffer.from(fixtureImage.data, "base64").length,
            mimeType: "image/png",
            name: fixtureImage.name,
          },
        },
      },
    },
  ]);
  daemon.seedServices({
    attachmentTexts: [{ threadId, sha256, text: html, name: "canvas.html" }],
    attachmentImages: [{ threadId, name: fixtureImage.name }],
  });
}

/** A person's message sent from the web with a screenshot and a text file attached. */
export function seedMessageAttachments(daemon: FakeDaemon): void {
  const threadId = "ios-attachments";
  const notes = "Checkout timings\nfirst paint: 180ms\nsubmit: 420ms\n";
  const notesSha = createHash("sha256").update(notes).digest("hex");
  daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    provider: "codex",
    title: "Screenshot and notes",
    hasSentMessage: true,
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "item.upsert",
      agent: "root",
      item: "web-ask",
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "Why is the submit step slow here?" }],
        attachments: [
          {
            sha256: fixtureImage.sha256,
            bytes: Buffer.from(fixtureImage.data, "base64").length,
            mimeType: "image/png",
            name: "checkout.png",
            kind: "image",
            thumbnailAvailable: true,
          },
          {
            sha256: notesSha,
            bytes: Buffer.byteLength(notes),
            mimeType: "text/plain",
            name: "timings.txt",
            kind: "text",
          },
        ],
      },
    },
    facts.message("root", "answer", "assistant", "The submit step waits on two serial requests."),
    facts.endTurn("root"),
  ]);
  daemon.seedServices({
    attachmentImages: [{ threadId, name: "checkout.png" }],
    attachmentTexts: [{ threadId, sha256: notesSha, text: notes, name: "timings.txt" }],
  });
}
