import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { BrowserService, UserChromeBackend } from "@ace/browser";
import { hostRegistry, installedNativeHosts, uninstallNativeHost } from "./install.ts";
import { windowsHostKeys } from "./native-hosts.ts";
import { connectedBrowser, until } from "./my-chrome-test-support.ts";

/*
 * Use my Chrome on Windows, end to end in the person's own installed browsers: the host is
 * registered in HKCU the way the daemon registers it, the browser starts it through cmd.exe,
 * an agent drives a tab, and uninstalling leaves no registration behind.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => {});
}, 60_000);

const installed = async (path: string) =>
  access(path).then(
    () => path,
    () => undefined,
  );
const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
  (root): root is string => Boolean(root),
);
const browsers =
  process.platform === "win32"
    ? [
        {
          name: "Chrome",
          path: (
            await Promise.all(
              programFiles.map((root) =>
                installed(join(root, "Google/Chrome/Application/chrome.exe")),
              ),
            )
          ).find(Boolean),
        },
        {
          name: "Edge",
          path: (
            await Promise.all(
              programFiles.map((root) =>
                installed(join(root, "Microsoft/Edge/Application/msedge.exe")),
              ),
            )
          ).find(Boolean),
        },
      ]
    : [];

async function fixtureSite() {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Agent page</title><body>
      <button onclick="document.getElementById('out').textContent='Clicked'">Press me</button>
      <div id="out" role="status" aria-label="Result"></div></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const Snapshot = z.object({
  nodes: z.array(z.object({ ref: z.string().optional(), name: z.string() })),
});

describe.runIf(process.platform === "win32")("Use my Chrome on Windows", () => {
  for (const browser of browsers)
    test.runIf(browser.path)(
      `Windows: an agent drives a tab in the person's ${browser.name} through the registered host, and uninstalling unregisters it`,
      async () => {
        const connected = await connectedBrowser(browser.path ?? "", cleanups);
        const site = await fixtureSite();
        const service = new BrowserService({
          dataDir: join(connected.root, "service"),
          headlessBackend: new UserChromeBackend(connected.hub, process.platform),
          backendPreference: () => "headless",
        });
        cleanups.push(() => service.close());
        const state = await service.open({ threadId: "thread", workspaceId: "workspace" });
        expect(state.backend).toBe("user");
        await service.execute("thread", { action: "navigate", url: `${site}/agent` });
        const button = Snapshot.parse(
          await service.execute("thread", { action: "snapshot" }),
        ).nodes.find((node) => node.name === "Press me" && node.ref)?.ref;
        await service.execute("thread", { action: "click", ref: button });
        expect(
          await service.execute("thread", {
            action: "evaluate",
            expression: "document.getElementById('out').textContent",
          }),
        ).toBe("Clicked");
        const shot = z
          .object({ path: z.string() })
          .parse(await service.execute("thread", { action: "screenshot" }));
        expect((await readFile(shot.path)).subarray(0, 4)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );
        const [connection] = connected.hub.connections();
        expect(connection?.tabs).toEqual([
          expect.objectContaining({ access: "agent", attached: true, url: `${site}/agent` }),
        ]);
        await service.closeThread("thread", { kind: "human", connectionId: "test" });
        await until(
          async () => !(await connected.chrome.targets()).some((t) => t.url === `${site}/agent`),
          "the agent tab to close",
        );

        // Uninstall: every browser's HKCU key, the manifest and the launcher go.
        const env = { LOCALAPPDATA: join(connected.root, "local") };
        const options = {
          platform: "win32" as const,
          home: connected.root,
          dataDir: join(connected.root, "ace"),
          env,
        };
        expect((await installedNativeHosts(options)).map((host) => host.browser)).toEqual([
          "Chrome",
          "Edge",
          "Chromium",
        ]);
        await uninstallNativeHost(options);
        expect(await installedNativeHosts(options)).toEqual([]);
        expect(
          await hostRegistry.read(windowsHostKeys(connected.root, env).map((target) => target.key)),
        ).toEqual([undefined, undefined, undefined]);
        // The only data directory's launcher folder, and the empty host folder above it, are gone.
        await expect(access(join(env.LOCALAPPDATA, "ace", "native-hosts"))).rejects.toThrow();
      },
      180_000,
    );
});
