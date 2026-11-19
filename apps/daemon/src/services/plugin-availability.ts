/**
 * Lets a service follow another that starts later and may start again (ADR 0175): the plugin
 * catalog feeds commands and skills, but plugins start after commands and may only come up on a
 * retry. Each time a new instance is published, the follower attaches to it once; the previous
 * instance's attachment is removed first, and publishing the same instance again does nothing.
 */
export class Availability<T extends object> {
  private current: { value: T; detach: () => void } | undefined;
  private closed = false;
  private readonly follow: (value: T) => () => void;
  constructor(follow: (value: T) => () => void) {
    this.follow = follow;
  }
  publish(value: T): void {
    if (this.closed || this.current?.value === value) return;
    this.current?.detach();
    this.current = undefined;
    this.current = { value, detach: this.follow(value) };
  }
  /** Removes the attachment for good; later publishes are ignored. */
  close(): void {
    this.closed = true;
    this.current?.detach();
    this.current = undefined;
  }
}
