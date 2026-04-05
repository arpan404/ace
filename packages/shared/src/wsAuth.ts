const WS_AUTH_PROTOCOL_PREFIX = "ace-auth.";

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bufferCtor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  const base64 = bufferCtor
    ? bufferCtor.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): string | undefined {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    const bufferCtor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
    const bytes = bufferCtor
      ? new Uint8Array(bufferCtor.from(padded, "base64"))
      : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export function buildWebSocketAuthProtocol(authToken: string): string {
  return `${WS_AUTH_PROTOCOL_PREFIX}${encodeBase64Url(authToken)}`;
}

export function extractWebSocketAuthTokenFromProtocolHeader(
  header: string | null | undefined,
): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const entry of header.split(",")) {
    const protocol = entry.trim();
    if (!protocol.startsWith(WS_AUTH_PROTOCOL_PREFIX)) {
      continue;
    }

    const encodedToken = protocol.slice(WS_AUTH_PROTOCOL_PREFIX.length);
    if (encodedToken.length === 0) {
      continue;
    }

    const decodedToken = decodeBase64Url(encodedToken);
    if (decodedToken && decodedToken.length > 0) {
      return decodedToken;
    }
  }

  return undefined;
}

export function resolveWebSocketAuthConnection(
  target: string,
  options?: { readonly baseUrl?: string },
): { readonly url: string; readonly protocols?: ReadonlyArray<string> } {
  const parsed = options?.baseUrl ? new URL(target, options.baseUrl) : new URL(target);
  const authToken = parsed.searchParams.get("token")?.trim() ?? "";

  if (authToken.length > 0) {
    parsed.searchParams.delete("token");
  }

  return {
    url: parsed.toString(),
    ...(authToken.length > 0 ? { protocols: [buildWebSocketAuthProtocol(authToken)] } : {}),
  };
}
