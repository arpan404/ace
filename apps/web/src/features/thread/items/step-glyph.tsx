import type { Item, ToolSurface } from "@ace/protocol";
import { exploreAction, displayCommand } from "@ace/ui-core";
import type { ToolMark } from "@ace/ui-core/ace-tools";
import {
  BrainIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  DeviceMobileIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  NoteIcon,
  NotePencilIcon,
  PlugIcon,
  RobotIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useToolIcon } from "@/lib/tool-icons.ts";

/*
 * A work-log row's icon: what the step did, as a Phosphor glyph, or for browser and computer-use
 * steps the real favicon of the site or icon of the app, as the daemon resolved them. A failed
 * step's glyph takes the failure tone; an image icon can't, so it fades.
 */

const markGlyphs: Record<Extract<ToolMark, { kind: "glyph" }>["glyph"], PhosphorIcon> = {
  screen: MonitorIcon,
  browser: GlobeIcon,
  agent: RobotIcon,
  thread: ChatsCircleIcon,
  pr: GitPullRequestIcon,
  ace: NoteIcon,
};

/** The glyph for what an item did. */
export function stepGlyph(item: Item | undefined, mark?: ToolMark): PhosphorIcon {
  if (mark?.kind === "device") return DeviceMobileIcon;
  if (mark?.kind === "glyph") return markGlyphs[mark.glyph];
  if (item?.type === "reasoning") return BrainIcon;
  if (item?.type === "notice") return NoteIcon;
  if (item?.type !== "tool_call") return WrenchIcon;
  const detail = item.call.detail;
  switch (detail.kind) {
    case "file.read":
      return FileTextIcon;
    case "search":
      return MagnifyingGlassIcon;
    case "shell": {
      const explored = exploreAction(displayCommand(detail).command);
      return explored === "search"
        ? MagnifyingGlassIcon
        : explored === "list"
          ? FolderSimpleIcon
          : explored === "read"
            ? FileTextIcon
            : TerminalIcon;
    }
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
    case "notebook":
      return NotePencilIcon;
    case "web.search":
    case "web.fetch":
    case "browser":
      return GlobeIcon;
    case "todo":
    case "plan":
      return ListChecksIcon;
    case "ask_user":
      return ChatCircleIcon;
    case "agent.spawn":
    case "agent.message":
      return RobotIcon;
    case "image":
      return ImageIcon;
    case "mcp":
      return PlugIcon;
    default:
      return WrenchIcon;
  }
}

/** The surface's own icon (favicon or app icon), or its glyph until or unless there is one. */
function SurfaceIcon(props: {
  threadId: string;
  itemId: string;
  surface: ToolSurface;
  fallback: PhosphorIcon;
  failed: boolean;
}) {
  const image = useToolIcon(props.threadId, props.itemId, props.surface.iconRef);
  if (!image)
    return (
      <Icon
        icon={
          props.surface.kind === "computer" && !props.surface.icon ? MonitorIcon : props.fallback
        }
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
        fallback={glyph}
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
