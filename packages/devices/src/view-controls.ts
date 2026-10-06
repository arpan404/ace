/// <reference lib="dom" />
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import {
  DeviceSettings,
  type DeviceInput,
  type DeviceOperation,
  type DeviceState,
} from "@ace/protocol/devices";
const recording = z.object({ id: z.string().min(1).max(256) });
export interface DeviceControlContext {
  document: Document;
  deviceId(): string;
  state(): DeviceState | undefined;
  ready(): boolean;
  enabled(): boolean;
  canInput(): boolean;
  threadId(): string | undefined;
  run(operation: DeviceOperation): Promise<unknown>;
  button(
    parent: HTMLElement,
    title: string,
    action: () => void | Promise<void>,
    allowed: () => boolean,
  ): HTMLButtonElement;
  started(deviceId: string): void;
  stopped(): void;
  downloadArtifact(id: string): void | Promise<void>;
}
/** Explicit user commands acquire control; reconnection never calls this path. */
export function addDeviceControls(parent: HTMLElement, context: DeviceControlContext) {
  const { document: doc, button, run } = context;
  const ready = context.ready;
  const controlled = async (operation: DeviceOperation) => {
    if (!("deviceId" in operation)) throw new Error("Device operation required");
    await run({ op: "controller", deviceId: operation.deviceId, controller: "human" });
    return run(operation);
  };
  const field = (name: string, maxLength: number, type = "text") => {
    const input = doc.createElement("input");
    input.type = type;
    input.maxLength = maxLength;
    input.placeholder = name;
    input.setAttribute("aria-label", name);
    parent.append(input);
    return input;
  };
  button(
    parent,
    "Boot",
    async () => {
      await controlled({ op: "boot", deviceId: context.deviceId() });
    },
    ready,
  );
  button(
    parent,
    "Shut down",
    async () => {
      await controlled({ op: "shutdown", deviceId: context.deviceId() });
      context.stopped();
    },
    ready,
  );
  button(
    parent,
    "Start live view",
    async () => {
      const deviceId = context.deviceId();
      await run({ op: "start", deviceId, fps: 60 });
      await run({ op: "subscribe", deviceId });
      context.started(deviceId);
    },
    () => ready() && context.enabled(),
  );
  button(
    parent,
    "Refresh screenshot",
    async () => {
      await run({ op: "screenshot", deviceId: context.deviceId() });
    },
    () => ready() && context.state()?.lifecycle === "live",
  );
  button(
    parent,
    "Stop live view",
    async () => {
      await run({ op: "stop", deviceId: context.deviceId() });
      context.stopped();
    },
    ready,
  );
  for (const allowed of [true, false])
    button(
      parent,
      allowed ? "Approve current thread" : "Revoke approval",
      async () => {
        await run({
          op: "approve",
          deviceId: context.deviceId(),
          threadId: ThreadId.parse(context.threadId()),
          allowed,
        });
      },
      () => ready() && !!context.threadId(),
    );
  button(
    parent,
    "Take control",
    async () => {
      await run({ op: "controller", deviceId: context.deviceId(), controller: "human" });
    },
    ready,
  );
  button(
    parent,
    "Release control",
    async () => {
      await run({ op: "controller", deviceId: context.deviceId(), controller: "none" });
    },
    () => ready() && context.state()?.controller === "human",
  );
  const agents = doc.createElement("select");
  agents.setAttribute("aria-label", "Agent to control device");
  parent.append(agents);
  button(
    parent,
    "Give agent control",
    async () => {
      await run({
        op: "controller",
        deviceId: context.deviceId(),
        controller: "agent",
        threadId: ThreadId.parse(context.threadId()),
        agentId: AgentId.parse(agents.value),
      });
    },
    () =>
      ready() &&
      context.state()?.approved === true &&
      context.state()?.threadId === context.threadId() &&
      !!agents.value,
  );
  const input = async (value: DeviceInput) => {
    if (context.canInput()) await run({ op: "input", deviceId: context.deviceId(), input: value });
  };
  for (const key of ["home", "back", "rotate"] as const)
    button(
      parent,
      key.slice(0, 1).toUpperCase() + key.slice(1),
      async () => {
        await input({ kind: "key", key });
      },
      context.canInput,
    );
  const text = field("Text to type on device", 4096);
  button(
    parent,
    "Type text",
    async () => {
      await input({ kind: "type", text: text.value });
      text.value = "";
    },
    context.canInput,
  );
  const path = field("App path on host (.app, .ipa, .apk)", 4096);
  button(
    parent,
    "Install app",
    async () => {
      await controlled({ op: "install", deviceId: context.deviceId(), path: path.value });
    },
    ready,
  );
  const app = field("Bundle or package ID", 256);
  button(
    parent,
    "Open app",
    async () => {
      await controlled({ op: "open_app", deviceId: context.deviceId(), appId: app.value });
    },
    ready,
  );
  const url = field("URL or deep link", 4096);
  button(
    parent,
    "Open URL",
    async () => {
      await controlled({ op: "open_url", deviceId: context.deviceId(), url: url.value });
    },
    ready,
  );
  const appearance = doc.createElement("select");
  appearance.setAttribute("aria-label", "Appearance");
  for (const value of ["", "light", "dark"]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = value || "Keep appearance";
    appearance.append(option);
  }
  parent.append(appearance);
  const latitude = field("Latitude", 32, "number");
  latitude.step = "any";
  const longitude = field("Longitude", 32, "number");
  longitude.step = "any";
  const locale = field("Locale", 32);
  button(
    parent,
    "Apply device settings",
    async () => {
      const settings = DeviceSettings.parse({
        ...(appearance.value ? { appearance: appearance.value } : {}),
        ...(locale.value ? { locale: locale.value } : {}),
        ...(latitude.value || longitude.value
          ? {
              location: {
                latitude: latitude.value ? Number(latitude.value) : NaN,
                longitude: longitude.value ? Number(longitude.value) : NaN,
              },
            }
          : {}),
      });
      await controlled({ op: "configure", deviceId: context.deviceId(), settings });
    },
    ready,
  );
  for (const op of ["logs.start", "logs.stop"] as const)
    button(
      parent,
      op === "logs.start" ? "Start logs" : "Stop logs",
      async () => {
        await run({ op, deviceId: context.deviceId() });
      },
      ready,
    );
  button(
    parent,
    "Start recording",
    async () => {
      await run({ op: "record.start", deviceId: context.deviceId() });
    },
    () => ready() && context.state()?.approved === true,
  );
  button(
    parent,
    "Stop and download recording",
    async () => {
      const artifact = recording.parse(
        await run({ op: "record.stop", deviceId: context.deviceId() }),
      );
      await context.downloadArtifact(artifact.id);
    },
    ready,
  );
  return {
    agents,
    input,
    refresh() {
      text.disabled = !context.canInput();
    },
  };
}
