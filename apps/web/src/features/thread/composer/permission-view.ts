import type { AccessMode } from "@ace/protocol";
import type { AccessChoice } from "@ace/ui-core";

/** What the access menu offers: only the modes the provider genuinely supports. */
export interface PermissionMenuView {
  choices: readonly AccessChoice[];
  /** The mode the menu marks: the one chosen, else the one in effect. */
  value: AccessMode | undefined;
  loading: boolean;
  /** Why no mode can be chosen here, e.g. the daemon couldn't report the provider's modes. */
  unavailable?: string | undefined;
}
