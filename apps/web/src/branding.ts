import { DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM } from "@ace/contracts";

export const APP_BASE_NAME = "ace";
export const APP_DISPLAY_NAME = APP_BASE_NAME;

function hasDesktopDevelopmentQueryFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    new URLSearchParams(window.location.search).get(DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM) === "1"
  );
}

function isDesktopDevelopmentBuild(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (hasDesktopDevelopmentQueryFlag()) {
    return true;
  }

  try {
    return window.desktopBridge?.getIsDevelopmentBuild?.() === true;
  } catch {
    return false;
  }
}

export const IS_DEV_BUILD =
  import.meta.env.DEV || import.meta.env.MODE === "development" || isDesktopDevelopmentBuild();
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
