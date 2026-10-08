import type { DeviceScope } from "@ace/protocol";

const labels: Record<DeviceScope, string> = {
  read: "Read",
  operate: "Operate",
  admin: "Administrator",
  projects: "Projects",
  accounts: "Accounts",
  desktop: "Desktop",
};
/** List the grant actually recorded by the host, including independent advanced scopes. */
export function deviceScopeLabels(scopes: readonly DeviceScope[]): string {
  return scopes.map((scope) => labels[scope]).join(", ");
}
