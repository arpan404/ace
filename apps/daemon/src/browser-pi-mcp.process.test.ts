import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { createLogger } from "@ace/diagnostics";
import type { PiPermissionMode } from "@ace/protocol/pi";
import type { Frame } from "@ace/engine-api";
import type { AceMcpConnection } from "@ace/mcp-server";
import { readConfig } from "./config.ts";
import { AdapterRegistry } from "./engine/registry.ts";
import { startPi } from "./services/pi.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, cleanups, invoke } from "./browser-mcp-test-support.ts";

it.each<PiPermissionMode>(["unrestricted", "read_only"])(
  "Pi's own MCP lease offers browser tools only in %s mode and expires with its process",
  async (permissionMode) => {
    const f = await setup("pi");
    const cli = join(f.home, "fake-pi.mjs");
    await writeFile(
      cli,
      `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/browser-mcp-cli.ts", import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
    const resources = new Resources();
    cleanups.push(() => resources.close());
    const log = createLogger({
      now: () => 0,
      redact: (line) => line,
      sink: { async write() {}, async close() {} },
      level: "silent",
    });
    cleanups.push(() => log.close());
    let connection: AceMcpConnection | undefined;
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: f.home }),
      store: f.store,
      now: () => 0,
      id: () => "pi-owned-lease",
      log,
      resources,
      onListen: [],
      services: { mcp: f.mcp },
      options: {
        pi: {
          permissionMode,
          runtime: {
            spawn(options) {
              if (options.env?.ACE_PI_MCP_URL)
                connection = z.object({ url: z.url(), bearer: z.string().min(1) }).parse({
                  url: options.env.ACE_PI_MCP_URL,
                  bearer: options.env.ACE_PI_MCP_BEARER,
                });
              return spawnTextSupervised(options);
            },
          },
        },
      },
    };
    await startPi(context);
    const registry = new AdapterRegistry();
    context.services.pi?.register(registry, {
      installed: true,
      path: cli,
      version: "0.85.1",
      auth: "unknown",
      loginHint: "synthetic",
    });
    // Pi has already been given its daemon lease factory. A generic wrapper lease would
    // reject here because the wrapper has no second lease authority.
    const adapter = withDaemonMcp(
      { store: f.store, services: {}, id: () => "unused" },
      registry.get("pi").adapter,
    );
    const frames: Frame[] = [];
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      env: { ACE_TEST_BROWSER_PROVIDER: "pi", ACE_TEST_BROWSER_URL: "http://localhost:3000/pi" },
      signal: new AbortController().signal,
      onFrame(frame) {
        frames.push(frame);
      },
      onExit() {},
    });
    cleanups.push(() => session.close("shutdown"));
    if (permissionMode === "unrestricted") {
      expect(f.browser.state(f.thread.id)?.url).toBe("http://localhost:3000/pi");
      const response = z.object({
        data: z.object({ mcpProof: z.object({ tools: z.array(z.string()) }) }),
      });
      expect(
        frames.flatMap((frame) => {
          const parsed = response.safeParse(frame.data);
          return parsed.success ? parsed.data.data.mcpProof.tools : [];
        }),
      ).toContain("ace_browser_open");
      if (!connection) throw new Error("Pi did not receive an MCP lease");
      expect(JSON.stringify(frames)).not.toContain(connection.bearer);
    } else {
      expect(() => f.browser.state(f.thread.id)).toThrow("Browser session not open");
      expect(connection).toBeUndefined();
      const response = z.object({ data: z.object({ tools: z.array(z.string()) }) });
      const observed = frames.find((frame) => response.safeParse(frame.data).success);
      expect(response.parse(observed?.data).data.tools).toEqual([]);
    }
    await session.close("shutdown");
    if (connection) expect((await invoke(connection, "ace_browser_open", {})).status).toBe(401);
  },
);
