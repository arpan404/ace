import { SlashIcon } from "@/components/slash-icon.tsx";
import type { CatalogKind } from "@ace/protocol";
import {
  BookOpenIcon,
  CommandIcon,
  FileIcon,
  FolderIcon,
  LightbulbIcon,
  PaperclipIcon,
  PlugIcon,
  RobotIcon,
  TargetIcon,
  ChatCircleIcon,
  GlobeSimpleIcon,
  WrenchIcon,
  FlowArrowIcon,
} from "@ace/icons";
import { kindGlyph } from "./attachment-face.tsx";
import { describeFile } from "./attachment-kind.ts";
import { Icon } from "./icon.tsx";
import { appIconCandidates } from "@ace/ui-core";
import { AppMark, useKnownApp } from "./ui/app-mark.tsx";

export type MentionKind = CatalogKind | "file" | "thread" | "tab";
const icons = {
  skill: BookOpenIcon,
  command: SlashIcon,
  plugin: PlugIcon,
  agent: RobotIcon,
  workflow: FlowArrowIcon,
  "mcp-tool": WrenchIcon,
  builtin: CommandIcon,
  file: FileIcon,
  thread: ChatCircleIcon,
  tab: GlobeSimpleIcon,
};
export const addIcons = {
  attach: PaperclipIcon,
  attachments: PaperclipIcon,
  files: FileIcon,
  project: FolderIcon,
  plan: LightbulbIcon,
  goal: TargetIcon,
};
export function MentionIcon(props: { kind: MentionKind; action?: string | undefined }) {
  const icon =
    props.action && props.action in addIcons
      ? Object.entries(addIcons).find(([key]) => key === props.action)?.[1]
      : undefined;
  return (
    <Icon
      icon={icon ?? icons[props.kind]}
      size={14}
      className="self-center shrink-0 text-muted-foreground"
    />
  );
}
/** An app's chip: its brand mark once one matches its name, else its kind's glyph. */
function AppIcon(props: { candidates: readonly string[]; name: string; kind: MentionKind }) {
  const app = useKnownApp(props.candidates);
  return app ? (
    <AppMark
      catalogue={app}
      name={props.name}
      size="inline"
      className="size-3.5 self-center bg-transparent shadow-none"
    />
  ) : (
    <MentionIcon kind={props.kind} />
  );
}

/** The same quiet, inline reference in the input and the sent message. */
export function MentionChip(props: {
  name: string;
  kind: MentionKind;
  detail?: string | undefined;
  /** The mention's icon: `app:…` draws the app's own mark (ADR 0194). */
  icon?: string | undefined;
}) {
  const candidates = appIconCandidates(props.icon);
  return (
    <span
      title={props.detail}
      data-mention-chip=""
      className="inline-flex max-w-full items-baseline gap-1 align-baseline font-medium text-link"
    >
      {candidates ? (
        <AppIcon candidates={candidates} name={props.name} kind={props.kind} />
      ) : (
        <MentionIcon kind={props.kind} />
      )}
      <span className="truncate">{props.name}</span>
    </span>
  );
}

/** Where a file was added in the message being written: its kind's glyph and its name. */
export function FileMarkerChip(props: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 align-baseline font-medium text-link">
      <Icon
        icon={kindGlyph(describeFile({ name: props.name }).kind)}
        size={14}
        className="self-center shrink-0 text-muted-foreground"
      />
      <span className="truncate">{props.name}</span>
    </span>
  );
}
