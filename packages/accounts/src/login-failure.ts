/**
 * A sign-in or sign-out failure whose message ace authored itself. Clients may show it verbatim;
 * provider output and exception text never go here, because either may carry credentials.
 */
export class ProviderLoginFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderLoginFailure";
  }
}
