/** The default renderer session may reach only daemon origins explicitly selected in the UI. */
export class DaemonNetwork {
  private origins = new Set<string>();

  authorize(input: string): void {
    const url = new URL(input);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !["wss:", "https:", ...(local ? ["ws:", "http:"] : [])].includes(url.protocol)
    )
      throw new Error("Choose a trusted HTTPS or WSS daemon, or a local loopback daemon");
    url.protocol =
      url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    if (!this.origins.has(url.origin) && this.origins.size >= 128)
      throw new Error("Too many daemon origins selected. Restart ace to clear them.");
    this.origins.add(url.origin);
  }

  allows(input: string, resourceType: string): boolean {
    let url;
    try {
      url = new URL(input);
    } catch {
      return false;
    }
    if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) return true;
    if (resourceType === "image" && url.origin === "https://cdn.agentclientprotocol.com")
      return true;
    if (
      ["http:", "ws:"].includes(url.protocol) &&
      (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        /^[a-z0-9-]+\.preview\.localhost$/.test(url.hostname))
    )
      return true;
    url.protocol =
      url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    return this.origins.has(url.origin);
  }
}
