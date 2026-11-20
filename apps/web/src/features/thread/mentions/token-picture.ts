import type { Addressee, DeviceContextItem } from "@ace/protocol";
import type { ComposerToken } from "@ace/ui-core";
import { parseSpadeAvatar } from "@ace/ui-core/spade-chat";
import type { MentionPicture } from "./mention-mark.tsx";

/*
 * A chip's picture from what it names (ADR 0198), so the composer, a draft read back and a sent
 * message all draw the same one from the same facts.
 */

export function addresseePicture(to: Addressee): MentionPicture {
  if (to.kind === "agent") return { kind: "agent", provider: to.provider };
  if (to.kind === "bot") return { kind: "bot", avatar: parseSpadeAvatar(to.avatar, to.id) };
  return {
    kind: "club",
    members: to.faces.map((face) => ({
      agent: face.id,
      avatar: parseSpadeAvatar(face.avatar, face.id),
      away: false,
    })),
  };
}

export function devicePicture(device: DeviceContextItem): MentionPicture {
  return { kind: "device", device: device.kind, model: device.model, os: device.os };
}

/** The picture of a reference chip; undefined keeps the chip's own glyph. */
export function tokenPicture(token: ComposerToken): MentionPicture | undefined {
  if (token.addressee) return addresseePicture(token.addressee);
  if (token.device) return devicePicture(token.device);
  if (token.file) return { kind: "file", path: token.file.path };
  return undefined;
}
