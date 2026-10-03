import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { DevicesService, DevicePlatform } from "@ace/devices";
import { ScreenManager } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DeviceOperation } from "@ace/protocol/devices";
import { ThreadId } from "@ace/protocol";
import { startDaemon, readConfig, stubHandler } from "../index.ts";
export async function providerFeatures(directory: string, executablePath: string) {
  const screenJournal = join(directory, "screen-input.jsonl");
  const deviceJournal = join(directory, "device-input.jsonl");
  await Promise.all([writeFile(screenJournal, ""), writeFile(deviceJournal, "")]);
  const sdk = join(directory, "sdk");
  for (const relative of ["platform-tools/adb", "emulator/emulator"]) {
    const executable = join(sdk, relative);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(
      executable,
      `#!${process.execPath}\n${
        relative.includes("emulator/")
          ? 'console.log("Pixel");'
          : `import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2); const command = args.join(" ");
if (command === "devices -l") console.log("List of devices attached\\nemulator-5554 device model:Pixel");
else if (command.endsWith("emu avd name")) console.log("Pixel\\nOK");
else if (command.includes("input")) await appendFile(${JSON.stringify(deviceJournal)}, JSON.stringify(args)+"\\n");`
      }\n`,
    );
    await chmod(executable, 0o755);
  }
  let sequence = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./mcp-screen-helper.ts", import.meta.url).pathname],
    env: { ACE_FEATURE_SCREEN_JOURNAL: screenJournal },
    platform: "darwin",
    nextId: () => `screen-${++sequence}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  const platform = new DevicePlatform({
    platform: "linux",
    home: directory,
    env: { ANDROID_HOME: sdk },
  });
  const devices = new DevicesService({
    platform,
    env: {},
    recordingDirectory: directory,
    publishArtifact: async (artifact) => artifact,
    runtime: {
      now: () => 1,
      id: () => `device-${++sequence}`,
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
  });
  const page = createServer((_request, response) =>
    response.end(
      '<!doctype html><label>Name <input aria-label="Name"></label><button onclick="document.getElementById(\'result\').textContent=document.querySelector(\'input\').value">Save</button><p id="result"></p>',
    ),
  );
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const address = page.address();
  if (!address || typeof address === "string") throw new Error("Missing local browser URL");
  const browserUrl = `http://127.0.0.1:${address.port}`;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const close = async () => {
    await daemon?.close();
    await devices.close();
    await screen.close();
    page.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      page.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    daemon = await startDaemon({
      config: readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      handler: stubHandler(),
      screen,
      devices,
      browser: { executablePath, evaluatePolicy: () => true },
    });
    const host = daemon;
    return {
      daemon: host,
      browserUrl,
      deviceId: "android:Pixel",
      close,
      async approve(threadId: string) {
        const thread = host.store.getThread(ThreadId.parse(threadId));
        if (!thread) throw new Error("Missing feature thread");
        await host.browser.open({ threadId, workspaceId: thread.workspaceId });
        await screen.enable(true);
        await screen.approve("com.example.test", true);
        const state = await screen.start({
          kind: "window",
          windowId: 1,
          bundleId: "com.example.test",
        });
        screen.delegateAgent(state.sessionId, { threadId, agentId: "root" });
        const human = { kind: "human", owner: "owner" } as const;
        await devices.request(DeviceOperation.parse({ op: "enable", enabled: true }), human);
        await devices.request(
          DeviceOperation.parse({
            op: "approve",
            deviceId: "android:Pixel",
            threadId,
            allowed: true,
          }),
          human,
        );
        await devices.request(
          DeviceOperation.parse({
            op: "controller",
            deviceId: "android:Pixel",
            controller: "agent",
            threadId,
            agentId: "root",
          }),
          human,
        );
      },
      async effects(threadId: string) {
        return {
          browser: await host.browser.execute(threadId, {
            action: "evaluate",
            expression: "document.getElementById('result').textContent",
          }),
          screen: await readFile(screenJournal, "utf8"),
          device: await readFile(deviceJournal, "utf8"),
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
