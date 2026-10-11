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
  WrenchIcon,
  FlowArrowIcon,
} from "@phosphor-icons/react";
import { Icon } from "./icon.tsx";

export type MentionKind = CatalogKind | "file" | "thread";
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
/** The same quiet, inline reference in the input and the sent message. */
export function MentionChip(props: {
  name: string;
  kind: MentionKind;
  detail?: string | undefined;
}) {
  return (
    <span
      title={props.detail}
      className="inline-flex max-w-full items-baseline gap-1 align-baseline font-medium text-link"
    >
      <MentionIcon kind={props.kind} />
      <span className="truncate">{props.name}</span>
    </span>
  );
}
