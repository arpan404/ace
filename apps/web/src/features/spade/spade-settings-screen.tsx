import { Navigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { SettingsBody } from "@/features/settings/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";

/** Settings › Spade's pages. */
export type SpadeSettingsPage = "general" | "models" | "search" | "apps" | "security";

const pages = {
  general: {
    title: "Spade",
    body: lazy(() =>
      import("./spade-settings.tsx").then((module) => ({ default: module.SpadeSettings })),
    ),
  },
  models: {
    title: "Models",
    body: lazy(() =>
      import("./spade-settings-models.tsx").then((module) => ({
        default: module.SpadeModelsSettings,
      })),
    ),
  },
  search: {
    title: "Web search",
    body: lazy(() =>
      import("./spade-search-settings.tsx").then((module) => ({ default: module.SearchSettings })),
    ),
  },
  apps: {
    title: "Apps",
    body: lazy(() =>
      import("./spade-settings-apps.tsx").then((module) => ({ default: module.SpadeAppsSettings })),
    ),
  },
  security: {
    title: "Security",
    body: lazy(() =>
      import("./spade-settings-security.tsx").then((module) => ({
        default: module.SpadeSecuritySettings,
      })),
    ),
  },
} as const;

/**
 * One of Settings › Spade's pages, framed like every Settings page, its body loaded on first use.
 * Hidden on this machine (ADR 0139): no Spade settings.
 */
export function SpadeSettingsScreen(props: { page: SpadeSettingsPage }) {
  const shown = useSpadeShown();
  if (shown === false) return <Navigate to="/settings" replace />;
  if (shown === undefined) return null;
  const { title, body: Body } = pages[props.page];
  return (
    <SettingsBody page={title}>
      <Suspense fallback={null}>
        <Body />
      </Suspense>
    </SettingsBody>
  );
}
