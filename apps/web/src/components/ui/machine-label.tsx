import type { MachineIcon } from "@ace/protocol";
import {
  CloudIcon,
  DesktopTowerIcon,
  LaptopIcon,
  DeviceMobileIcon,
  HardDrivesIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

const shapes = {
  laptop: LaptopIcon,
  desktop: DesktopTowerIcon,
  server: HardDrivesIcon,
  cloud: CloudIcon,
  phone: DeviceMobileIcon,
};
const colors = {
  default: "currentColor",
  blue: "var(--project-8)",
  green: "var(--project-5)",
  purple: "var(--project-10)",
  orange: "var(--project-2)",
};

const defaultIcon: MachineIcon = { kind: "laptop" };

export function MachineMark({ icon = defaultIcon }: { icon?: MachineIcon | undefined }) {
  const Glyph = icon.kind === "emoji" ? undefined : shapes[icon.kind];
  return (
    <span
      role="img"
      aria-label={`${icon.kind === "emoji" ? (icon.emoji ?? "Emoji") : icon.kind} machine icon`}
      className="inline-flex shrink-0 items-center"
      style={{ color: colors[icon.color ?? "default"] }}
    >
      {Glyph ? <Glyph aria-hidden size={14} /> : <span aria-hidden>{icon.emoji ?? "💻"}</span>}
    </span>
  );
}

/** Every machine name uses the same chosen mark and truncates within its row. */
export function MachineLabel(props: {
  name: string;
  icon?: MachineIcon | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}>
      <MachineMark icon={props.icon} />
      <span className="truncate">{props.name}</span>
    </span>
  );
}
