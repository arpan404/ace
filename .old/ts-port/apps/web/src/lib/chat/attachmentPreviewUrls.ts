import { resolveServerUrl } from "../utils";

export function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

export function toAttachmentPreviewUrl(rawUrl: string, connectionUrl?: string): string {
  if (!rawUrl.startsWith("/")) {
    return rawUrl;
  }

  try {
    let connectionToken: string | null = null;
    const resolveBaseUrl = (): URL => {
      if (connectionUrl) {
        const parsedConnectionUrl = new URL(connectionUrl);
        connectionToken = parsedConnectionUrl.searchParams.get("token");
        const protocol =
          parsedConnectionUrl.protocol === "wss:"
            ? "https:"
            : parsedConnectionUrl.protocol === "ws:"
              ? "http:"
              : parsedConnectionUrl.protocol;
        return new URL(`${protocol}//${parsedConnectionUrl.host}/`);
      }
      return new URL(resolveServerUrl({ pathname: "/" }));
    };
    const resolvedUrl = new URL(rawUrl, resolveBaseUrl());
    if (connectionToken && !resolvedUrl.searchParams.has("token")) {
      resolvedUrl.searchParams.set("token", connectionToken);
    }
    resolvedUrl.protocol =
      resolvedUrl.protocol === "wss:"
        ? "https:"
        : resolvedUrl.protocol === "ws:"
          ? "http:"
          : resolvedUrl.protocol;
    return resolvedUrl.toString();
  } catch {
    return rawUrl;
  }
}

export function resolveAttachmentPreviewUrl(attachmentId: string, connectionUrl?: string): string {
  return toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachmentId), connectionUrl);
}
