import { findExecutable } from "@ace/provider-kit/discovery";
import { isAbsolute, delimiter, resolve } from "node:path";
import { z } from "zod";
import type { PluginProjection } from "./types.ts";
import { jsonSize } from "./review-pages.ts";

const field = z.string().max(8192);
const namedValue = z.strictObject({ name: z.string().min(1).max(128), value: field });
const serverName = z.string().min(1).max(256);
const server = z.union([
  z.strictObject({
    name: serverName,
    command: field.min(1),
    args: z.array(field).max(128),
    env: z.array(namedValue).max(256),
  }),
  z.strictObject({
    name: serverName,
    type: z.enum(["http", "sse"]),
    url: z.url().max(8192),
    headers: z.array(namedValue).max(256),
  }),
]);
const paramsSchema = z.strictObject({
  cwd: field.min(1).refine(isAbsolute, "ACP cwd must be absolute"),
  mcpServers: z.array(server).max(256).default([]),
});
const resultSchema = z.object({ sessionId: z.string().min(1).max(256) }).passthrough();
export type AcpExecutableResolver = (
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<string | undefined>;
async function systemExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string) {
  const path = env.PATH ?? process.env.PATH ?? "";
  const directories = path.split(delimiter);
  if (path.length > 32768 || directories.length > 256)
    throw new Error("Executable PATH exceeds limit");
  return findExecutable(
    command.includes("/") || command.includes("\\") ? resolve(cwd, command) : command,
    { PATH: directories.map((directory) => resolve(cwd, directory)).join(delimiter) },
  );
}
export interface AcpSessionTransport {
  request(method: string, params: unknown): Promise<unknown>;
}
/** After the adapter initializes/authenticates ACP, create its session with plugin overrides. */
export async function newPluginAcpSession(
  config: PluginProjection["sessionConfig"],
  transport: AcpSessionTransport,
  input: unknown,
  executable: AcpExecutableResolver = systemExecutable,
) {
  const params = paramsSchema.parse(input);
  const plugins = z
    .array(server)
    .max(256)
    .parse(config.mcpServers ?? []);
  const request = paramsSchema.parse({ ...params, mcpServers: [...params.mcpServers, ...plugins] });
  const names = new Set<string>();
  for (const entry of request.mcpServers) {
    if (names.has(entry.name)) throw new Error("ACP MCP name collision");
    names.add(entry.name);
    if ("command" in entry) {
      const resolved = await executable(
        entry.command,
        Object.fromEntries(entry.env.map((value) => [value.name, value.value])),
        request.cwd,
      );
      if (!resolved || !isAbsolute(resolved))
        throw new Error(`ACP executable unavailable: ${entry.command}`);
      entry.command = resolved;
    }
  }
  jsonSize(request, 512 * 1024, "ACP session config exceeds byte limit");
  return resultSchema.parse(await transport.request("session/new", request));
}
