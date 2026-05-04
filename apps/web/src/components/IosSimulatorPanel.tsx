import type { IosSimulatorBridgeOperation } from "@ace/contracts";
import { LoaderCircleIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface SimulatorDevice {
  readonly isAvailable?: boolean;
  readonly name: string;
  readonly runtime: string;
  readonly state: string;
  readonly udid: string;
}

interface SimulatorOperationState {
  readonly message: string | null;
  readonly screenshotUrl: string | null;
}

function normalizeDeviceList(value: unknown): SimulatorDevice[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.runtime !== "string" ||
      typeof record.state !== "string" ||
      typeof record.udid !== "string"
    ) {
      return [];
    }
    return [
      {
        name: record.name,
        runtime: record.runtime,
        state: record.state,
        udid: record.udid,
        ...(typeof record.isAvailable === "boolean" ? { isAvailable: record.isAvailable } : {}),
      } satisfies SimulatorDevice,
    ];
  });
}

function describeSimulatorResult(
  operation: IosSimulatorBridgeOperation,
  result: Record<string, unknown>,
): string {
  switch (operation) {
    case "ios_simulator_list_devices":
      return `Loaded ${typeof result.total === "number" ? result.total : 0} simulator device${result.total === 1 ? "" : "s"}.`;
    case "ios_simulator_boot":
      return `Booted simulator ${typeof result.deviceId === "string" ? result.deviceId : ""}.`;
    case "ios_simulator_shutdown":
      return `Shut down simulator ${typeof result.deviceId === "string" ? result.deviceId : ""}.`;
    case "ios_simulator_open_url":
      return `Opened ${typeof result.url === "string" ? result.url : "URL"} in the selected simulator.`;
    case "ios_simulator_launch_app":
      return `Launched ${typeof result.bundleId === "string" ? result.bundleId : "app"} on the selected simulator.`;
    case "ios_simulator_terminate_app":
      return `Terminated ${typeof result.bundleId === "string" ? result.bundleId : "app"} on the selected simulator.`;
    case "ios_simulator_screenshot":
      return "Captured simulator screenshot.";
  }
}

export function IosSimulatorPanel() {
  const [devices, setDevices] = useState<SimulatorDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [appBundleId, setAppBundleId] = useState("");
  const [openUrlValue, setOpenUrlValue] = useState("https://example.com");
  const [busyOperation, setBusyOperation] = useState<IosSimulatorBridgeOperation | null>(null);
  const [operationState, setOperationState] = useState<SimulatorOperationState>({
    message: null,
    screenshotUrl: null,
  });

  const loadDevices = async (preferredDeviceId?: string) => {
    setBusyOperation("ios_simulator_list_devices");
    try {
      const result = await ensureNativeApi().browser.runSimulatorOperation({
        operation: "ios_simulator_list_devices",
        args: {},
      });
      const nextDevices = normalizeDeviceList(result.devices);
      setDevices(nextDevices);
      setSelectedDeviceId((current) => {
        const candidate = preferredDeviceId ?? current;
        if (candidate && nextDevices.some((device) => device.udid === candidate)) {
          return candidate;
        }
        return (
          nextDevices.find((device) => device.state === "Booted")?.udid ??
          nextDevices[0]?.udid ??
          ""
        );
      });
      setOperationState((current) => ({
        ...current,
        message: describeSimulatorResult("ios_simulator_list_devices", result),
      }));
    } catch (error) {
      setOperationState((current) => ({
        ...current,
        message:
          error instanceof Error && error.message
            ? error.message
            : "Failed to load simulator devices.",
      }));
    } finally {
      setBusyOperation(null);
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  const runOperation = async (
    operation: IosSimulatorBridgeOperation,
    args: Record<string, unknown>,
  ) => {
    setBusyOperation(operation);
    try {
      const result = await ensureNativeApi().browser.runSimulatorOperation({
        operation,
        args,
      });
      setOperationState({
        message: describeSimulatorResult(operation, result),
        screenshotUrl: typeof result.imageDataUrl === "string" ? result.imageDataUrl : null,
      });
      if (
        operation === "ios_simulator_boot" ||
        operation === "ios_simulator_shutdown" ||
        operation === "ios_simulator_launch_app" ||
        operation === "ios_simulator_terminate_app"
      ) {
        await loadDevices(selectedDeviceId);
      }
    } catch (error) {
      setOperationState((current) => ({
        ...current,
        message:
          error instanceof Error && error.message ? error.message : "Simulator operation failed.",
      }));
    } finally {
      setBusyOperation(null);
    }
  };

  const selectedDevice = devices.find((device) => device.udid === selectedDeviceId) ?? null;
  const controlsDisabled = selectedDeviceId.length === 0 || busyOperation !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <SmartphoneIcon className="size-4" />
              <span>iOS Simulator</span>
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              Native simulator control is separate from the embedded browser surface.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busyOperation !== null}
            onClick={() => void loadDevices(selectedDeviceId)}
          >
            {busyOperation === "ios_simulator_list_devices" ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            Refresh
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Devices
            </div>
            <div className="space-y-2">
              {devices.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-3 py-4 text-muted-foreground text-sm">
                  No simulator devices found.
                </div>
              ) : (
                devices.map((device) => {
                  const active = device.udid === selectedDeviceId;
                  return (
                    <button
                      key={device.udid}
                      type="button"
                      className={cn(
                        "w-full rounded-2xl border px-3 py-3 text-left transition-colors",
                        active
                          ? "border-foreground/20 bg-accent text-foreground"
                          : "border-border/70 bg-card/40 hover:bg-accent/50",
                      )}
                      onClick={() => setSelectedDeviceId(device.udid)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-sm">{device.name}</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {device.runtime}
                          </div>
                        </div>
                        <div
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
                            device.state === "Booted"
                              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {device.state}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/70 bg-card/40 p-4">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Selected Device
              </div>
              <div className="mt-2 text-sm text-foreground">
                {selectedDevice ? selectedDevice.name : "No simulator selected"}
              </div>
              <div className="mt-1 text-muted-foreground text-xs">
                {selectedDevice ? selectedDevice.udid : "Choose a simulator to control it."}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() =>
                    void runOperation("ios_simulator_boot", { deviceId: selectedDeviceId })
                  }
                >
                  Boot
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() =>
                    void runOperation("ios_simulator_shutdown", { deviceId: selectedDeviceId })
                  }
                >
                  Shutdown
                </Button>
                <Button
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() =>
                    void runOperation("ios_simulator_screenshot", { deviceId: selectedDeviceId })
                  }
                >
                  Screenshot
                </Button>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-card/40 p-4">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Browser URL
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  nativeInput
                  value={openUrlValue}
                  onChange={(event) => setOpenUrlValue(event.currentTarget.value)}
                  placeholder="https://example.com"
                />
                <Button
                  size="sm"
                  disabled={controlsDisabled || openUrlValue.trim().length === 0}
                  onClick={() =>
                    void runOperation("ios_simulator_open_url", {
                      deviceId: selectedDeviceId,
                      url: openUrlValue.trim(),
                    })
                  }
                >
                  Open
                </Button>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-card/40 p-4">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                App Control
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  nativeInput
                  value={appBundleId}
                  onChange={(event) => setAppBundleId(event.currentTarget.value)}
                  placeholder="com.example.app"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={controlsDisabled || appBundleId.trim().length === 0}
                  onClick={() =>
                    void runOperation("ios_simulator_launch_app", {
                      deviceId: selectedDeviceId,
                      bundleId: appBundleId.trim(),
                    })
                  }
                >
                  Launch
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={controlsDisabled || appBundleId.trim().length === 0}
                  onClick={() =>
                    void runOperation("ios_simulator_terminate_app", {
                      deviceId: selectedDeviceId,
                      bundleId: appBundleId.trim(),
                    })
                  }
                >
                  Stop
                </Button>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-card/40 p-4">
              <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Output
              </div>
              <p className="mt-2 text-sm text-foreground">
                {operationState.message ?? "Run a simulator action to inspect output here."}
              </p>
              {operationState.screenshotUrl ? (
                <img
                  src={operationState.screenshotUrl}
                  alt="Latest iOS simulator screenshot"
                  className="mt-3 max-h-[28rem] w-full rounded-xl border border-border/70 object-contain"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
