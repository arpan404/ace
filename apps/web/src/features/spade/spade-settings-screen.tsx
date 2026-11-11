import { lazy, Suspense } from "react";
import { SettingsBody } from "@/features/settings/index.ts";

const SpadeSettings = lazy(() =>
  import("./spade-settings.tsx").then((module) => ({ default: module.SpadeSettings })),
);

/** Settings › Spade: framed like every Settings page, its body loaded on first use. */
export function SpadeSettingsScreen() {
  return (
    <SettingsBody page="Spade">
      <Suspense fallback={null}>
        <SpadeSettings />
      </Suspense>
    </SettingsBody>
  );
}
