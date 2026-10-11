import { z } from "zod";

const RpcFailure = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
});

/** Interpret only a failed session/load request, never initialization or fresh opening. */
export function resumeLoadFailure(
  error: unknown,
): { code: "resume_unavailable" | "resume_unsupported"; detail: string } | undefined {
  let detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let code: string | number | undefined;
  try {
    // JsonRpcPeer retains the wire error as JSON in Error.message.
    const parsed = RpcFailure.safeParse(JSON.parse(detail));
    if (parsed.success) {
      code = parsed.data.code;
      detail = parsed.data.message ?? detail;
    }
  } catch {
    // Plain provider messages remain eligible for the narrow missing-conversation match.
  }
  if (code === -32601 || code === "resume_unsupported")
    return { code: "resume_unsupported", detail };
  if (
    [
      "resume_unavailable",
      "session_not_found",
      "thread_not_found",
      "conversation_not_found",
    ].includes(String(code)) ||
    /^No conversation found\b/i.test(detail)
  )
    return { code: "resume_unavailable", detail };
  return undefined;
}
