/**
 * Settings the daemon handles on their own when written (canonical folders, the read-only
 * downloads default, host identity, and remote access, which may restart listeners). A batch
 * (`settings.setMany`) never includes them. Portable: no Node imports.
 */
export function setOnItsOwn(key: string): boolean {
  return (
    key === "projects.roots" ||
    key.startsWith("browser.download") ||
    key.startsWith("host.") ||
    key.startsWith("remote.")
  );
}
