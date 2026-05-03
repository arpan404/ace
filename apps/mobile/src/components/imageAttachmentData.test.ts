import { describe, expect, it } from "vitest";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ace/contracts";
import {
  attachmentPermissionCopy,
  buildMobileImageAttachmentsFromAssets,
  estimateBase64Bytes,
  formatBytes,
  queuedComposerImageToMobileImageAttachment,
  toUploadChatAttachments,
  type MobileImageAttachment,
} from "./imageAttachmentData";

const NOW = new Date("2026-05-02T00:00:00.000Z");

describe("imageAttachmentData", () => {
  it("estimates base64 byte length with padding", () => {
    expect(estimateBase64Bytes("TQ==")).toBe(1);
    expect(estimateBase64Bytes("TWE=")).toBe(2);
    expect(estimateBase64Bytes("TWFu")).toBe(3);
  });

  it("formats byte counts for mobile attachment copy", () => {
    expect(formatBytes(1)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });

  it("converts mobile images to upload attachments without preview-only fields", () => {
    const image: MobileImageAttachment = {
      id: "image-1",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,TWFu",
      previewUri: "file:///screen.png",
    };

    expect(toUploadChatAttachments([image])).toEqual([
      {
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,TWFu",
      },
    ]);
  });

  it("restores queued composer images as mobile attachments", () => {
    expect(
      queuedComposerImageToMobileImageAttachment({
        id: "queued-image-1" as never,
        type: "image",
        name: "queued.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,TWFu",
      }),
    ).toEqual({
      id: "queued-image-1",
      type: "image",
      name: "queued.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,TWFu",
      previewUri: "data:image/png;base64,TWFu",
    });
  });

  it("describes recoverable and blocked native attachment permissions", () => {
    expect(attachmentPermissionCopy("camera", { granted: false, canAskAgain: true })).toEqual({
      title: "Camera access required",
      message: "Allow camera access to attach a photo.",
      settingsLabel: null,
    });
    expect(
      attachmentPermissionCopy("photo-library", { granted: false, canAskAgain: false }),
    ).toEqual({
      title: "Photo access blocked",
      message: "Enable photo library access in Settings to attach saved images from this device.",
      settingsLabel: "Open Settings",
    });
  });

  it("builds normalized image attachments from picked assets", () => {
    let nextId = 0;
    const result = buildMobileImageAttachmentsFromAssets({
      existingCount: 0,
      now: NOW,
      makeId: () => `image-${++nextId}`,
      assets: [
        {
          uri: "file:///screen.png",
          base64: "TWFu",
          mimeType: "image/png",
          fileName: "screen.png",
        },
        {
          uri: "file:///fallback",
          base64: "TQ==",
          mimeType: "application/octet-stream",
        },
      ],
    });

    expect(result.rejectedForSize).toBe(0);
    expect(result.attachments).toEqual([
      {
        id: "image-1",
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,TWFu",
        previewUri: "file:///screen.png",
      },
      {
        id: "image-2",
        type: "image",
        name: "library-image-2026-05-02T00-00-00-000Z.jpeg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        dataUrl: "data:image/jpeg;base64,TQ==",
        previewUri: "file:///fallback",
      },
    ]);
  });

  it("skips non-images, missing base64, oversize images, and full slots", () => {
    const result = buildMobileImageAttachmentsFromAssets({
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      now: NOW,
      makeId: () => "image",
      assets: [
        {
          uri: "file:///video.mov",
          type: "video",
          base64: "TWFu",
        },
        {
          uri: "file:///missing-base64.png",
          type: "image",
        },
        {
          uri: "file:///large.png",
          type: "image",
          base64: "TWFu",
          fileSize: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
        },
        {
          uri: "file:///ok.png",
          type: "image",
          base64: "TQ==",
          mimeType: "image/png",
        },
        {
          uri: "file:///ignored-slot.png",
          type: "image",
          base64: "TQ==",
          mimeType: "image/png",
        },
      ],
    });

    expect(result.rejectedForSize).toBe(1);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.previewUri).toBe("file:///ok.png");
  });
});
