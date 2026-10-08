import { DeviceSettings } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { useDevices } from "./use-devices.ts";

export type DeviceAction = "Install app…" | "Open URL…" | "Open app…" | "Device settings…";

export function DeviceActionDialog(props: {
  action: DeviceAction;
  devices: ReturnType<typeof useDevices>;
  close(): void;
}) {
  const [value, setValue] = useState("");
  const [appearance, setAppearance] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState("");
  const settings = props.action === "Device settings…";
  const label = settings
    ? "Locale"
    : props.action === "Install app…"
      ? "App package path"
      : props.action === "Open app…"
        ? "App identifier"
        : "URL";
  const submit = () => {
    if (settings) {
      const parsed = DeviceSettings.safeParse({
        ...(appearance ? { appearance } : {}),
        ...(value ? { locale: value } : {}),
        ...(latitude || longitude
          ? {
              location: {
                latitude: latitude ? Number(latitude) : NaN,
                longitude: longitude ? Number(longitude) : NaN,
              },
            }
          : {}),
      });
      if (!parsed.success) {
        setError("Check the locale and location. Enter both latitude and longitude.");
        return;
      }
      props.devices.configure(parsed.data);
    } else if (props.action === "Install app…") props.devices.install(value);
    else if (props.action === "Open app…") props.devices.openApp(value);
    else {
      try {
        if (!URL.canParse(value)) throw new Error("Invalid URL");
      } catch {
        setError("Enter a complete URL, such as https://example.com.");
        return;
      }
      props.devices.openUrl(value);
    }
    props.close();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.close()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.action.replace("…", "")}</DialogTitle>
            <DialogDescription>
              {settings
                ? "Change the device's appearance, language or simulated location."
                : props.action === "Install app…"
                  ? "Enter the path on this machine to an .app or .apk build."
                  : "Open it on this device."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">
            {settings && (
              <Select
                label="Appearance"
                value={appearance}
                options={[
                  { value: "", label: "Keep current appearance" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
                onValueChange={setAppearance}
              />
            )}
            <label className="text-sm">
              {label}
              <Input
                aria-label={label}
                value={value}
                placeholder={settings ? "en-US" : undefined}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            {settings && (
              <div className="flex gap-2">
                <label className="min-w-0 text-sm">
                  Latitude
                  <Input
                    aria-label="Latitude"
                    type="number"
                    step="any"
                    value={latitude}
                    onChange={(event) => setLatitude(event.target.value)}
                  />
                </label>
                <label className="min-w-0 text-sm">
                  Longitude
                  <Input
                    aria-label="Longitude"
                    type="number"
                    step="any"
                    value={longitude}
                    onChange={(event) => setLongitude(event.target.value)}
                  />
                </label>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-status-failed">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={props.close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!settings && !value.trim()}>
              {settings ? "Save changes" : props.action.replace("…", "")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
