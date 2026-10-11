/** Read-only reconciliation shares the same resource lock as mutations. */
export class ForgeWriteFlights {
  private active = new Map<string, string>();
  has(resource: string): boolean {
    return this.active.has(resource);
  }
  hasOperation(id: string): boolean {
    return [...this.active.values()].includes(id);
  }
  acquire(resource: string, id: string): boolean {
    if (this.active.has(resource) || this.active.size >= 16) return false;
    this.active.set(resource, id);
    return true;
  }
  release(resource: string): void {
    this.active.delete(resource);
  }
}
