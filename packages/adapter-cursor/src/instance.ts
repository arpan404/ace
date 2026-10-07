import { join, isAbsolute } from "node:path";
import { z } from "zod";

export const CursorInstance = z.strictObject({
  id: z.string().min(1).max(256),
  homeDir: z.string().min(1).max(4096).refine(isAbsolute),
});
export type CursorInstance = z.infer<typeof CursorInstance>;
export function cursorInstanceHome(dataDir: string, id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid Cursor instance ID");
  return join(dataDir, "instances", id);
}
/** One identity/home owner for the SDK default, including pre-accounts checkpoints. */
export function defaultCursorInstance(dataDir: string): CursorInstance {
  return CursorInstance.parse({
    id: "cursor-sdk-default",
    homeDir: cursorInstanceHome(dataDir, "cursor-sdk-default"),
  });
}
/** The accounts owner calls this only for its selected cursor-sdk backend. */
export function cursorSdkEnvironment(
  input: CursorInstance,
  launch: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const instance = CursorInstance.parse(input);
  const home = join(instance.homeDir, "user");
  return {
    ...launch,
    HOME: home,
    USERPROFILE: home,
    // SDK auth is consumed by the SDK in the inherited environment, never IPC.
    CURSOR_API_KEY: launch.CURSOR_API_KEY,
    CURSOR_AUTH_TOKEN: undefined,
    CURSOR_CONFIG_DIR: undefined,
    CURSOR_DATA_DIR: undefined,
    CURSOR_BACKEND_URL: undefined,
    CURSOR_WEBSITE_URL: undefined,
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
  };
}
