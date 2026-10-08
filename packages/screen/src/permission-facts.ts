import { ScreenPermissions } from "@ace/protocol";
/** Permission notifications fence late inspection replies. One inspection serves concurrent starts. */
export class PermissionFacts {
  private cached: ScreenPermissions | undefined;
  private inspection: Promise<ScreenPermissions> | undefined;
  private revision = 0;
  version(): number {
    return this.revision;
  }
  changed(permissions: ScreenPermissions): void {
    this.revision++;
    this.cached = permissions;
  }
  invalidate(): void {
    this.revision++;
    this.cached = undefined;
  }
  inspected(version: number, raw: unknown): void {
    const permissions = ScreenPermissions.parse(raw);
    if (version === this.revision) this.cached = permissions;
  }
  read(inspect: () => Promise<unknown>): Promise<ScreenPermissions> {
    if (this.cached) return Promise.resolve(this.cached);
    this.inspection ??= inspect()
      .then((raw) => this.cached ?? ScreenPermissions.parse(raw))
      .finally(() => {
        this.inspection = undefined;
      });
    return this.inspection;
  }
}
