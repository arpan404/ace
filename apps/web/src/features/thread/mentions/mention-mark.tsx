import type { CatalogEntry, ProviderKind } from "@ace/protocol";
import { catalogMark, type PickerDeviceKind } from "@ace/ui-core";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import {
  BrowserIcon,
  ChatCircleIcon,
  DesktopTowerIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  FolderIcon,
  GlobeSimpleIcon,
  HardDrivesIcon,
  LaptopIcon,
} from "@ace/icons";
import { kindGlyph } from "@/components/attachment-face.tsx";
import { describeFile } from "@/components/attachment-kind.ts";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { MentionIcon } from "@/components/mention-chip.tsx";
import { AppMark, useKnownApp } from "@/components/ui/app-mark.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { deviceGlyphs } from "@/features/devices/index.ts";
import { GroupFaces, SpadeFace } from "@/features/spade/index.ts";

/*
 * The picture of everything `@` can name (ADR 0194), the same in the picker's rows and in the
 * chip it leaves, in the composer and in the sent message: an agent its provider's mark, a bot
 * its face, a club its members' faces, a machine or device its kind's glyph, an app its brand
 * mark, a file its kind's glyph. Bare marks in the text colour, never on a tinted tile.
 */

export type MentionPicture =
  | { kind: "agent"; provider?: ProviderKind | undefined }
  | { kind: "bot"; avatar: SpadeAvatar }
  | { kind: "club"; members: readonly { agent: string; avatar: SpadeAvatar; away: boolean }[] }
  | {
      kind: "device";
      device: PickerDeviceKind;
      model?: string | undefined;
      os?: string | undefined;
    }
  | { kind: "catalog"; entry: Pick<CatalogEntry, "kind" | "name" | "source" | "invocation"> }
  | { kind: "file"; path: string }
  | { kind: "tab"; favicon?: string | undefined }
  | { kind: "thread" };

const machineGlyphs: Partial<Record<PickerDeviceKind, IconGlyph>> = {
  laptop: LaptopIcon,
  desktop: DesktopTowerIcon,
  server: HardDrivesIcon,
  phone: DeviceMobileIcon,
  tablet: DeviceTabletIcon,
  browser: BrowserIcon,
};

function deviceGlyph(picture: Extract<MentionPicture, { kind: "device" }>): IconGlyph {
  if (picture.device === "simulator")
    return /ipad/i.test(picture.model ?? "") ? deviceGlyphs.ipad : deviceGlyphs.iphone;
  if (picture.device === "emulator")
    return /tablet/i.test(picture.model ?? "")
      ? deviceGlyphs["android-tablet"]
      : deviceGlyphs["android-phone"];
  return machineGlyphs[picture.device] ?? LaptopIcon;
}

const glyph = (icon: IconGlyph, size: 14 | 16) => (
  <Icon icon={icon} size={size} className="shrink-0 self-center text-muted-foreground" />
);

/** A catalog entry's picture: an app's brand mark when one matches, else its kind's. */
function CatalogPicture(props: { entry: MentionPicture & { kind: "catalog" }; size: 14 | 16 }) {
  const mark = catalogMark(props.entry.entry);
  const app = useKnownApp(mark.kind === "app" ? mark.candidates : []);
  if (mark.kind === "app" && app)
    return (
      <AppMark
        catalogue={app}
        name={props.entry.entry.name}
        size="inline"
        className="bg-transparent shadow-none"
      />
    );
  if (mark.kind === "provider")
    return <ProviderIcon provider={mark.provider} size={props.size} decorative />;
  return <MentionIcon kind={props.entry.entry.kind} />;
}

export function MentionMark(props: { picture: MentionPicture; size?: 14 | 16 | undefined }) {
  const size = props.size ?? 16;
  const { picture } = props;
  switch (picture.kind) {
    case "agent":
      return picture.provider ? (
        <ProviderIcon provider={picture.provider} size={size} decorative />
      ) : (
        glyph(ChatCircleIcon, size)
      );
    case "bot":
      return <SpadeFace avatar={picture.avatar} size={size} />;
    case "club":
      return <GroupFaces members={picture.members} size={size} />;
    case "device":
      return glyph(deviceGlyph(picture), size);
    case "catalog":
      return <CatalogPicture entry={picture} size={size} />;
    case "file":
      return glyph(
        picture.path.endsWith("/")
          ? FolderIcon
          : kindGlyph(describeFile({ name: picture.path }).kind),
        size,
      );
    case "tab":
      return picture.favicon ? (
        <img
          src={picture.favicon}
          alt=""
          aria-hidden
          draggable={false}
          className="shrink-0 self-center rounded-xs"
          style={{ width: size, height: size }}
        />
      ) : (
        glyph(GlobeSimpleIcon, size)
      );
    case "thread":
      return glyph(ChatCircleIcon, size);
  }
}
