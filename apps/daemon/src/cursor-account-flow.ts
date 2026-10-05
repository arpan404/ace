import { z } from "zod";
import { AccountId, AccountDirectory } from "@ace/protocol/accounts";
import type { createCursorAccountDriver } from "@ace/adapter-cursor";

type Driver = Pick<ReturnType<typeof createCursorAccountDriver>, "login" | "logout">;
/** PTY entry boundary. Key-bearing SDK returns are never serialized into this terminal. */
export async function runCursorAccountFlow(
  args: unknown,
  options: {
    driver: Driver;
    signal: AbortSignal;
    output(text: string): void;
    error(text: string): void;
  },
): Promise<0 | 1> {
  try {
    const [id, homeDir, action] = z
      .tuple([AccountId, AccountDirectory, z.enum(["login", "logout"])])
      .parse(args);
    const instance = { id, homeDir };
    if (action === "login")
      await options.driver.login(instance, options.signal, (url) => options.output(`${url}\r\n`));
    else await options.driver.logout(instance, options.signal);
    options.output("Cursor SDK authentication flow completed.\r\n");
    return 0;
  } catch {
    options.error("Cursor SDK authentication flow failed.\r\n");
    return 1;
  }
}
