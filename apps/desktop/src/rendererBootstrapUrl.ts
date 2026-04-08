import {
  DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM,
  DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM,
} from "@ace/contracts";

export function appendDesktopBootstrapWsUrl(
  rendererUrl: string,
  backendWsUrl: string,
  isDevelopmentBuild: boolean,
): string {
  const parsedUrl = new URL(rendererUrl);
  parsedUrl.searchParams.set(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM, backendWsUrl);
  parsedUrl.searchParams.set(
    DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM,
    isDevelopmentBuild ? "1" : "0",
  );
  return parsedUrl.toString();
}
