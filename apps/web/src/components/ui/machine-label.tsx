import type { MachineIcon, MachineIconKind } from "@ace/protocol";
import {
  CloudIcon,
  CpuIcon,
  DesktopIcon,
  DesktopTowerIcon,
  DeviceMobileIcon,
  HardDrivesIcon,
  LaptopIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/** The curated machine marks, in the order a picker offers them. */
export const machineIcons: readonly { kind: MachineIconKind; label: string; glyph: Icon }[] = [
  { kind: "laptop", label: "Laptop", glyph: LaptopIcon },
  { kind: "desktop", label: "Desktop", glyph: DesktopTowerIcon },
  { kind: "monitor", label: "Monitor", glyph: DesktopIcon },
  { kind: "server", label: "Server", glyph: HardDrivesIcon },
  { kind: "cloud", label: "Cloud", glyph: CloudIcon },
  { kind: "cpu", label: "Board", glyph: CpuIcon },
  { kind: "terminal", label: "Terminal", glyph: TerminalWindowIcon },
  { kind: "phone", label: "Phone", glyph: DeviceMobileIcon },
];
const glyphs = new Map(machineIcons.map((entry) => [entry.kind, entry]));
const colors = {
  default: "currentColor",
  blue: "var(--project-8)",
  green: "var(--project-5)",
  purple: "var(--project-10)",
  orange: "var(--project-2)",
};

/**
 * The mark a machine shows before anyone picks one: this machine a laptop, another a server,
 * so "This Mac" and a remote box never share a glyph by default.
 */
export function defaultMachineIcon(primary: boolean): MachineIcon {
  return { kind: primary ? "laptop" : "server" };
}

export function MachineMark(props: {
  icon?: MachineIcon | undefined;
  /** Whether the machine is this window's own; picks the default mark when none is set. */
  primary?: boolean | undefined;
}) {
  const icon = props.icon ?? defaultMachineIcon(props.primary ?? true);
  const entry = glyphs.get(icon.kind) ?? machineIcons[0];
  const Glyph = entry?.glyph ?? LaptopIcon;
  return (
    <span
      role="img"
      aria-label={`${entry?.kind ?? "laptop"} machine icon`}
      className="inline-flex shrink-0 items-center"
      style={{ color: colors[icon.color ?? "default"] }}
    >
      <Glyph aria-hidden size={14} />
    </span>
  );
}

/** Every machine name uses the same chosen mark and truncates within its row. */
export function MachineLabel(props: {
  name: string;
  icon?: MachineIcon | undefined;
  primary?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}>
      <MachineMark icon={props.icon} primary={props.primary} />
      <span className="truncate">{props.name}</span>
    </span>
  );
}
