/** Stable provider projection identity for portable components and MCP servers. */
export function projectionName(plugin: string, component: string): string {
  return `ace-${plugin}__${component}`;
}
