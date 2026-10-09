export function loginSuccessMessage(input: {
  name: string;
  action?: "login" | "logout" | undefined;
  service?: string | undefined;
  account?: string | undefined;
}): string {
  if (input.service)
    return `${input.service} is ${input.action === "logout" ? "disconnected" : "connected"}`;
  return input.action === "logout"
    ? `Signed out of ${input.name}`
    : `Signed in to ${input.name}${input.account ? ` · ${input.account}` : ""}`;
}
