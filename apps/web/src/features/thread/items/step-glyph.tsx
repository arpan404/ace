import type { Item, ToolSurface } from "@ace/protocol";
import { stepGlyphKind, type StepGlyphKind } from "@ace/ui-core";
import type { ToolMark } from "@ace/ui-core/ace-tools";
import {
  BrainIcon,
  ChatCircleIcon,
  DeviceMobileIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NoteIcon,
  NotePencilIcon,
  PlugIcon,
  RobotIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { AceToolIcon, BrowserUseIcon, ComputerUseIcon } from "@/components/ace-icons.tsx";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useToolIcon } from "@/lib/tool-icons.ts";

/*
 * A work-log row's icon: what the step did, as a Phosphor glyph, or for browser and computer-use
 * steps the real favicon of the site or icon of the app, as the daemon resolved them. ace's own
 * tools that act on ace itself (agents, threads, pull requests, notes) show the ace mark. A failed
 * step's glyph takes the failure tone; an image icon can't, so it fades.
 */

const glyphIcons: Record<StepGlyphKind, PhosphorIcon> = {
  device: DeviceMobileIcon,
  computer: ComputerUseIcon,
  browser: BrowserUseIcon,
  ace: AceToolIcon,
  think: BrainIcon,
  note: NoteIcon,
  read: FileTextIcon,
  search: MagnifyingGlassIcon,
  list: FolderSimpleIcon,
  command: TerminalIcon,
  edit: NotePencilIcon,
  web: GlobeIcon,
  plan: ListChecksIcon,
  question: ChatCircleIcon,
  agent: RobotIcon,
  image: ImageIcon,
  tool: PlugIcon,
  other: WrenchIcon,
};

/** The glyph for what an item did. */
export function stepGlyph(item: Item | undefined, mark?: ToolMark): PhosphorIcon {
  return glyphIcons[stepGlyphKind(item, mark)];
}

/**
 * The surface's own icon (favicon or app icon), or until or unless there is one, the browser-use
 * or computer-use glyph: never a generic tool's.
 */
function SurfaceIcon(props: {
  threadId: string;
  itemId: string;
  surface: ToolSurface;
  failed: boolean;
}) {
  const image = useToolIcon(props.threadId, props.itemId, props.surface.iconRef);
  if (!image)
    return (
      <Icon
        icon={props.surface.kind === "computer" ? ComputerUseIcon : BrowserUseIcon}
        size={16}
        className={props.failed ? "text-status-failed" : "text-subtle-foreground"}
      />
    );
  return (
    <img
      src={image}
      alt=""
      width={16}
      height={16}
      draggable={false}
      className={cn(
        "size-4 shrink-0 rounded-sm object-contain",
        // Sites draw their favicons for light tabs; a dark one needs a light plate to show.
        props.surface.kind === "browser" && "dark:bg-foreground dark:p-px",
        props.failed && "opacity-60 grayscale",
      )}
    />
  );
}

export function StepGlyph(props: {
  threadId: string;
  item: Item | undefined;
  surface?: ToolSurface | undefined;
  mark?: ToolMark | undefined;
  /** In flight: the row's words shimmer; the icon stays what the step does. */
  running: boolean;
  failed: boolean;
}) {
  const glyph = stepGlyph(props.item, props.mark);
  const surface =
    props.surface ??
    (props.mark?.kind === "app"
      ? { kind: "computer" as const, icon: { kind: "app" as const, identity: props.mark.bundleId } }
      : props.mark?.kind === "site"
        ? {
            kind: "browser" as const,
            icon: { kind: "site" as const, origin: `https://${props.mark.host}` },
          }
        : undefined);
  if (surface && props.item)
    return (
      <SurfaceIcon
        threadId={props.threadId}
        itemId={props.item.id}
        surface={surface}
        failed={props.failed}
      />
    );
  return (
    <Icon
      icon={glyph}
      size={16}
      className={props.failed ? "text-status-failed" : "text-subtle-foreground"}
    />
  );
}
