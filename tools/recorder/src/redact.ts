import { homedir, hostname, userInfo } from "node:os";
import { createRedactor as sharedRedactor, type RedactionContext } from "@ace/redaction";
export type { RedactionContext } from "@ace/redaction";
export function createRedactor(
  ctx: RedactionContext,
  literalTextFields: readonly string[] = [],
): (line: string) => string {
  return sharedRedactor(
    {
      home: homedir(),
      host: hostname(),
      username: userInfo().username,
      ...ctx,
    },
    ["text", "delta", ...literalTextFields],
  );
}
