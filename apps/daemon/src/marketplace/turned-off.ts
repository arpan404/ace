/**
 * The marketplace is turned off in Settings › Beta (`beta.marketplace`). Thrown where work starts,
 * before each network fetch and before each install step, so an install under way is undone;
 * every layer passes it through untouched rather than taking it for its own failure.
 */
export class TurnedOff extends Error {
  override name = "TurnedOff";
  readonly code = "unavailable";
  constructor() {
    super("The marketplace is turned off. Turn it on in Settings › Beta.");
  }
}
