import { describe, expect, it } from "vitest";

import { resolveAttachmentPreviewUrl, toAttachmentPreviewUrl } from "./attachmentPreviewUrls";

describe("attachmentPreviewUrls", () => {
  it("resolves attachment routes against a websocket backend origin", () => {
    expect(
      resolveAttachmentPreviewUrl(
        "thread-attachment_1",
        "ws://127.0.0.1:3020/ws?token=secret-token",
      ),
    ).toBe("http://127.0.0.1:3020/attachments/thread-attachment_1?token=secret-token");
  });

  it("preserves already absolute preview URLs", () => {
    expect(toAttachmentPreviewUrl("blob:local-preview", "ws://127.0.0.1:3020/ws")).toBe(
      "blob:local-preview",
    );
  });
});
