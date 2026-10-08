import type { DeviceScope } from "@ace/protocol";

const labels: Record<DeviceScope, string> = {
  read: "View only",
  operate: "View and act",
  admin: "Administrator",
  projects: "Projects",
  accounts: "Accounts",
  desktop: "Desktop",
};
export const deviceAccessOptions = (["operate", "read", "admin"] as const).map((value) => ({
  value,
  label: labels[value],
}));
/** List the grant actually recorded by the host, including independent advanced scopes. */
export function deviceScopeLabels(scopes: readonly DeviceScope[]): string {
  const access = scopes.includes("admin")
    ? "admin"
    : scopes.includes("operate")
      ? "operate"
      : scopes.includes("read")
        ? "read"
        : undefined;
  const granted = [
    ...(access ? [labels[access]] : []),
    ...scopes
      .filter((scope) => !["read", "operate", "admin"].includes(scope))
      .map((scope) => labels[scope]),
  ];
  return granted.length ? granted.join(", ") : "No access";
}
