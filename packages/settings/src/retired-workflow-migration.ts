/** Remove retired workflow settings on the next successful read, retaining unrelated keys. */
export function retiredWorkflowKeys(settings: object): string[] {
  return Object.keys(settings).filter((key) => key === "offshift" || key.startsWith("offshift."));
}
