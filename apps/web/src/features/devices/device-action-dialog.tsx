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
import { Input } from "@/components/ui/input.tsx";
import type { useDevices } from "./use-devices.ts";

export type DeviceAction =
  | "Install app…"
  | "Open URL…"
  | "Open app…"
  | "Location…"
  | "Language and region…";

const descriptions: Record<DeviceAction, string> = {
  "Install app…": "Enter the path on this machine to an .app or .apk build.",
  "Open URL…": "Open it on this device.",
  "Open app…": "Open an installed app by its bundle or package identifier.",
  "Location…": "Set where the device thinks it is.",
  "Language and region…": "Change the device's language and region, such as en-US or fr-FR.",
};

/** Install, open, or set the location or language of the device, from its ⋯ menu. */
export function DeviceActionDialog(props: {
  action: DeviceAction;
  devices: ReturnType<typeof useDevices>;
  close(): void;
}) {
  const [value, setValue] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState("");
  const { action } = props;
  const location = action === "Location…";
  const label =
    action === "Install app…"
      ? "App package path"
      : action === "Open app…"
        ? "App identifier"
        : action === "Language and region…"
          ? "Locale"
          : "URL";
  const title = action.replace("…", "");
  const submit = () => {
    if (location) {
      const parsed = DeviceSettings.safeParse({
        location: {
          latitude: latitude ? Number(latitude) : NaN,
          longitude: longitude ? Number(longitude) : NaN,
        },
      });
      if (!parsed.success) {
        setError("Enter both latitude and longitude, between -90 and 90 and -180 and 180.");
        return;
      }
      props.devices.configure(parsed.data);
    } else if (action === "Language and region…") {
      const parsed = DeviceSettings.safeParse({ locale: value.trim() });
      if (!parsed.success) {
        setError("Enter a locale such as en-US or fr-FR.");
        return;
      }
      props.devices.configure(parsed.data);
    } else if (action === "Install app…") props.devices.install(value);
    else if (action === "Open app…") props.devices.openApp(value);
    else {
      if (!URL.canParse(value)) {
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
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{descriptions[action]}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">
            {location ? (
              <div className="flex gap-2">
                <label className="min-w-0 flex-1 text-sm">
                  Latitude
                  <Input
                    aria-label="Latitude"
                    type="number"
                    step="any"
                    value={latitude}
                    onChange={(event) => setLatitude(event.target.value)}
                  />
                </label>
                <label className="min-w-0 flex-1 text-sm">
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
            ) : (
              <label className="text-sm">
                {label}
                <Input
                  aria-label={label}
                  value={value}
                  placeholder={action === "Language and region…" ? "en-US" : undefined}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-status-failed">
                {error}
              </p>
            )}
          </div>
          <DialogFooter submitHint>
            <Button variant="ghost" type="button" onClick={props.close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!location && !value.trim()}>
              {location
                ? "Set location"
                : action === "Language and region…"
                  ? "Set language"
                  : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
