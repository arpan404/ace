import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type QueuedComposerImageAttachment,
  type UploadChatAttachment,
} from "@ace/contracts";

export interface MobileImageAttachment {
  readonly id: string;
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  readonly previewUri: string;
}

export interface PickedImageAsset {
  readonly uri: string;
  readonly type?: string | null | undefined;
  readonly base64?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
  readonly fileSize?: number | null | undefined;
  readonly fileName?: string | null | undefined;
}

export interface BuildMobileImageAttachmentsInput {
  readonly existingCount: number;
  readonly assets: ReadonlyArray<PickedImageAsset>;
  readonly now: Date;
  readonly makeId: () => string;
}

export interface BuildMobileImageAttachmentsResult {
  readonly attachments: MobileImageAttachment[];
  readonly rejectedForSize: number;
}

export type AttachmentPermissionKind = "camera" | "photo-library";

export interface AttachmentPermissionStatus {
  readonly granted: boolean;
  readonly canAskAgain?: boolean | null | undefined;
}

export interface AttachmentPermissionCopy {
  readonly title: string;
  readonly message: string;
  readonly settingsLabel: string | null;
}

export function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function toUploadChatAttachments(
  images: ReadonlyArray<MobileImageAttachment>,
): UploadChatAttachment[] {
  return images.map((image) => ({
    type: "image",
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    dataUrl: image.dataUrl,
  }));
}

export function queuedComposerImageToMobileImageAttachment(
  image: QueuedComposerImageAttachment,
): MobileImageAttachment {
  return {
    id: image.id,
    type: "image",
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    dataUrl: image.dataUrl,
    previewUri: image.dataUrl,
  };
}

export function attachmentPermissionCopy(
  kind: AttachmentPermissionKind,
  permission: AttachmentPermissionStatus,
): AttachmentPermissionCopy {
  const isCamera = kind === "camera";
  if (!permission.granted && permission.canAskAgain === false) {
    return {
      title: isCamera ? "Camera access blocked" : "Photo access blocked",
      message: isCamera
        ? "Enable camera access in Settings to attach photos from this device."
        : "Enable photo library access in Settings to attach saved images from this device.",
      settingsLabel: "Open Settings",
    };
  }

  return {
    title: isCamera ? "Camera access required" : "Photo access required",
    message: isCamera
      ? "Allow camera access to attach a photo."
      : "Allow photo library access to attach saved images.",
    settingsLabel: null,
  };
}

export function buildMobileImageAttachmentsFromAssets({
  assets,
  existingCount,
  makeId,
  now,
}: BuildMobileImageAttachmentsInput): BuildMobileImageAttachmentsResult {
  const remainingSlots = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingCount);
  const attachments: MobileImageAttachment[] = [];
  let rejectedForSize = 0;

  for (const asset of assets) {
    if (attachments.length >= remainingSlots) {
      break;
    }
    if (asset.type && asset.type !== "image") {
      continue;
    }
    if (!asset.base64) {
      continue;
    }

    const mimeType = asset.mimeType?.startsWith("image/") ? asset.mimeType : "image/jpeg";
    const sizeBytes = asset.fileSize ?? estimateBase64Bytes(asset.base64);
    if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      rejectedForSize += 1;
      continue;
    }

    const name =
      asset.fileName ??
      `library-image-${now.toISOString().replace(/[:.]/g, "-")}.${mimeType.split("/")[1] ?? "jpg"}`;
    attachments.push({
      id: makeId(),
      type: "image",
      name,
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${asset.base64}`,
      previewUri: asset.uri,
    });
  }

  return {
    attachments,
    rejectedForSize,
  };
}
