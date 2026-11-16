/**
 * Connection lifetimes survive asynchronous lookups without retaining disconnected owners. One
 * owner's views of a device overlap while a resubscribe is set up beside the view it replaces:
 * the owner's stream request goes only when the last of them ends, so a resubscribe that fails
 * never takes it from the view still running.
 */
export class DeviceStreamOwners {
  private readonly owners = new Map<
    string,
    { active: boolean; subscriptions: Map<string, Set<object>> }
  >();
  scope(owner: string) {
    let scope = this.owners.get(owner);
    if (!scope) {
      scope = { active: true, subscriptions: new Map() };
      this.owners.set(owner, scope);
    }
    const lifetime = scope;
    const guard = () => {
      if (!lifetime.active) throw new Error("Device viewer disconnected");
    };
    return {
      guard,
      subscribe(device: string, release: () => void) {
        guard();
        const token = {};
        let views = lifetime.subscriptions.get(device);
        if (!views) {
          views = new Set();
          lifetime.subscriptions.set(device, views);
        }
        views.add(token);
        const held = views;
        return () => {
          if (!held.delete(token) || held.size > 0) return;
          if (lifetime.subscriptions.get(device) === held) lifetime.subscriptions.delete(device);
          release();
        };
      },
    };
  }
  disconnect(owner: string): void {
    const scope = this.owners.get(owner);
    if (scope) scope.active = false;
    this.owners.delete(owner);
  }
  close(): void {
    for (const owner of this.owners.keys()) this.disconnect(owner);
  }
}
