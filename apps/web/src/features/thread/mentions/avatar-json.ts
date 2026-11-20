import { SpadeFaceJson } from "@ace/protocol";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";

/** Avatars travel as Spade stored them, so a reply's face matches the picker's. */
export function avatarJson(avatar: SpadeAvatar): SpadeFaceJson | undefined {
  const value =
    avatar.kind === "character"
      ? avatar.raw
      : avatar.kind === "image"
        ? { kind: "image", sha256: avatar.sha256 }
        : { kind: "spade" };
  const parsed = SpadeFaceJson.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
