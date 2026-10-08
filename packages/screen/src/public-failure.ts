import { z } from "zod";
import { PublicToolCode, PublicToolError } from "@ace/mcp-server";
const safeMessages = new Set([
  "Text destination changed",
  "Focus changed during human input; the human's desktop was retained",
  "Background action changed focus or cursor; restoration attempted",
  "Cannot classify text destination",
  "Cannot inspect focused text destination",
  "Secure text requires session consent",
  "Secure fields require session consent",
  "Accessibility permission denied",
  "Screen Recording permission denied",
  "Screen Recording permission revoked",
  "macOS permission denied",
  "macOS permission denied or target unavailable",
  "Approved window target required",
  "Approved controllable target required",
  "Approved installed application required",
  "Application approval required",
  "Window is not approved",
]);
const permission = z.enum(["screenRecording", "accessibility"]);
/** Only reviewed literal helper messages are safe, even when a backend supplies a known code. */
export function screenPublicFailure(
  error: unknown,
  permissionHint?: "screenRecording" | "accessibility",
): unknown {
  if (!(error instanceof Error) || !("code" in error)) return error;
  const mapping = {
    denied: "screen_approval_denied",
    timeout: "screen_approval_timeout",
    read_only: "screen_read_only",
  } as const;
  const source = typeof error.code === "string" ? error.code : "";
  const code = PublicToolCode.safeParse(Reflect.get(mapping, source) ?? source);
  if (!code.success) return error;
  const explicit = permission.safeParse("permission" in error ? error.permission : undefined);
  const inferred = error.message.startsWith("Screen Recording permission")
    ? "screenRecording"
    : error.message === "Accessibility permission denied"
      ? "accessibility"
      : undefined;
  return new PublicToolError(
    code.data,
    explicit.success ? explicit.data : (inferred ?? permissionHint),
    "phase" in error ? error.phase : undefined,
    "candidates" in error ? error.candidates : undefined,
    safeMessages.has(error.message) ? error.message : undefined,
  );
}
