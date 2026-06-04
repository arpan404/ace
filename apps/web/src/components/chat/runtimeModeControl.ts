import type { RuntimeMode } from "@ace/contracts";

export function nextRuntimeMode(mode: RuntimeMode): RuntimeMode {
  switch (mode) {
    case "approval-required":
      return "full-access";
    case "full-access":
    default:
      return "approval-required";
  }
}

export const RUNTIME_MODE_META: Record<
  RuntimeMode,
  { label: string; title: string; textClassName: string; iconClassName: string }
> = {
  "approval-required": {
    label: "Supervised",
    title: "Supervised - click to switch to Full access",
    textClassName:
      "text-emerald-600 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  "full-access": {
    label: "Full access",
    title: "Full access - click to switch to Supervised",
    textClassName:
      "text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300",
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
};
