import type { AccessMode, PermissionMode } from "@ace/protocol";
import type { AccessDefaults } from "./permissions.ts";

/** ace's first-run access, used until the person chooses one on this daemon. */
export const firstRunAccess: AccessMode = "auto-review";

/**
 * What a thread without its own choice runs (ADR 0075): its project's default, else this
 * daemon's default (the person's last choice or their Settings value), else the first-run mode.
 */
export function accessDefaults(input: {
  project?: AccessMode | undefined;
  daemon?: AccessMode | undefined;
  custom?: PermissionMode | undefined;
}): AccessDefaults {
  return {
    access: input.project ?? input.daemon ?? firstRunAccess,
    ...(input.custom ? { custom: input.custom } : {}),
  };
}
