/** Thrown by sources when the connected daemon cannot serve a feature yet. */
export class UnavailableError extends Error {
  constructor(feature: string) {
    super(`${feature} isn't available from this daemon yet.`);
    this.name = "UnavailableError";
  }
}
