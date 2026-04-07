import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";

export function appendDesktopBootstrapWsUrl(rendererUrl: string, backendWsUrl: string): string {
  const parsedUrl = new URL(rendererUrl);
  parsedUrl.searchParams.set(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM, backendWsUrl);
  return parsedUrl.toString();
}
