import type { Item, ToolCall, ToolSurface } from "@ace/protocol";

/*
 * Which surface a tool step drove (a web site, a native app) and the icon identity that stands
 * for it, read from the call alone. A browser step that names no URL acted on the site the same
 * agent last opened, so the site carries forward through a turn's steps. Pure.
 */

/** A web host name: letters, digits, dots and hyphens (no IP-literal brackets, no `_`). */
const hostName = /^[a-z0-9.-]{1,253}$/;

/**
 * `https://github.com` for an http(s) URL with a plain host name; never a path, query or
 * userinfo, and undefined for anything `SiteOrigin` would refuse.
 */
export function siteOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!/^https?:$/.test(parsed.protocol) || !hostName.test(host)) return undefined;
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" && found ? found : undefined;
}

/** ace and providers name browser and computer-use tools with these words. */
const browserTool = /(^|[^a-z])browser([^a-z]|$)/i;
const screenTool = /(^|[^a-z])(screen|computer)[_.-]/i;

function toolName(call: ToolCall): string | undefined {
  if (call.detail.kind === "mcp") return call.detail.tool;
  if (call.detail.kind === "custom" || call.detail.kind === "browser") return call.title;
  return undefined;
}

function argumentsOf(call: ToolCall): unknown {
  return call.detail.kind === "mcp" ? call.detail.arguments : undefined;
}

/**
 * The surface of one call. `carried` is the site the same agent's last browser step was on, for
 * a browser step that names none.
 */
export function toolSurface(call: ToolCall, carried?: string): ToolSurface | undefined {
  const target = call.result?.target;
  if (target?.bundleId && target.bundleId.length <= 1024)
    return {
      kind: "computer",
      icon: { kind: "app", identity: target.bundleId, name: target.displayName },
    };
  if (call.detail.kind === "web.fetch") {
    const origin = siteOrigin(call.detail.url);
    return origin ? { kind: "browser", icon: { kind: "site", origin } } : undefined;
  }
  const name = toolName(call);
  const args = argumentsOf(call);
  if (name && screenTool.test(name)) {
    const bundleId = field(args, "bundleId");
    return bundleId && bundleId.length <= 1024
      ? { kind: "computer", icon: { kind: "app", identity: bundleId } }
      : { kind: "computer" };
  }
  if (call.detail.kind === "browser" || (name && browserTool.test(name))) {
    const origin = siteOrigin(field(args, "url")) ?? carried;
    return origin ? { kind: "browser", icon: { kind: "site", origin } } : { kind: "browser" };
  }
  return undefined;
}

/**
 * Each tool step's surface, carrying each agent's site forward in order. `carried` seeds the site
 * each agent was on before the first item (an earlier page of the same turn).
 */
export function toolSurfaces(
  items: readonly Item[],
  carried?: ReadonlyMap<string, string>,
): Map<string, ToolSurface> {
  const surfaces = new Map<string, ToolSurface>();
  const sites = new Map<string, string>(carried);
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const agent = item.agentId ?? "";
    const surface = toolSurface(item.call, sites.get(agent));
    if (!surface) continue;
    surfaces.set(item.id, surface);
    if (surface.icon?.kind === "site") sites.set(agent, surface.icon.origin);
  }
  return surfaces;
}
