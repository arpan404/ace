/** Connection lifetimes survive asynchronous lookups without retaining disconnected owners. */
export class DeviceStreamOwners {
  private readonly owners = new Map<
    string,
    { active: boolean; subscriptions: Map<string, object> }
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
        lifetime.subscriptions.set(device, token);
        return () => {
          if (lifetime.subscriptions.get(device) !== token) return;
          lifetime.subscriptions.delete(device);
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
