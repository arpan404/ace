import type { ToolMark } from "@ace/ui-core/ace-tools";
import {
  ChatsCircleIcon,
  DeviceMobileIcon,
  GlobeIcon,
  MonitorIcon,
  NoteIcon,
  RobotIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useAppIcon } from "@/lib/app-icons.ts";

const glyphs: Record<Extract<ToolMark, { kind: "glyph" }>["glyph"], PhosphorIcon> = {
  screen: MonitorIcon,
  browser: GlobeIcon,
  agent: RobotIcon,
  thread: ChatsCircleIcon,
  ace: NoteIcon,
};

/**
 * What an ace step acted on, at a step row's glyph size: the app's own icon (from the OS in the
 * desktop app, else its letter), a site's letter, a device, or the tool's glyph.
 */
export function ToolMarkIcon(props: { mark: ToolMark; fallback?: "group" | "row" }) {
  const { mark } = props;
  switch (mark.kind) {
    case "app":
      return (
        <AppIcon bundleId={mark.bundleId} name={mark.name} fallback={props.fallback ?? "group"} />
      );
    case "site":
      return props.fallback === "row" ? (
        <GlobeIcon aria-hidden size={14} />
      ) : (
        <LetterTile text={mark.host} />
      );
    case "device":
      return <DeviceMobileIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />;
    default: {
      const Glyph = glyphs[mark.glyph];
      return <Glyph aria-hidden size={14} className="shrink-0 text-subtle-foreground" />;
    }
  }
}

function AppIcon(props: { bundleId: string; name: string; fallback: "group" | "row" }) {
  const icon = useAppIcon(props.bundleId);
  if (!icon)
    return props.fallback === "row" ? (
      <MonitorIcon aria-hidden size={14} />
    ) : (
      <LetterTile text={props.name} />
    );
  return (
    <img
      src={icon}
      alt=""
      data-app-icon={props.bundleId}
      width={14}
      height={14}
      className="size-3.5 shrink-0"
      draggable={false}
    />
  );
}

/** A quiet tile with the name's first letter, where there is no icon to show. */
function LetterTile(props: { text: string }) {
  return (
    <span
      aria-hidden
      className="grid size-3.5 shrink-0 place-items-center rounded-sm bg-foreground/8 text-2xs font-semibold text-foreground"
    >
      {props.text.charAt(0).toUpperCase()}
    </span>
  );
}
