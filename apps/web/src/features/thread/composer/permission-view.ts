import type { PermissionOption } from "@ace/ui-core";

/** What the approvals menu offers and how it reads; `options` preserves the supported native selectors. */
export interface PermissionMenuView {
  options: readonly PermissionOption[];
  /** The option the menu marks: the one chosen, else the one in effect. */
  value: string | undefined;
  loading: boolean;
  /** Why no mode can be chosen here, e.g. the daemon couldn't report the provider's modes. */
  unavailable?: string | undefined;
  /** Why the mode shown isn't the one asked for: "Cursor can't pause for your approval…". */
  fallback?: string | undefined;
}
