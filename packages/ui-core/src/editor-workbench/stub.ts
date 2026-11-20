/** Placeholder body for an export whose rules land in a later commit of this workstream. */
export function notYet(name: string): never {
  throw new Error(`editor-workbench: ${name} is not built yet`);
}
