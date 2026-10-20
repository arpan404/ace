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
