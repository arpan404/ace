import { ScreenStopError } from "./stop-error.ts";
import { Helper, HelperCommandError, type HelperOptions } from "./helper.ts";
/** One process owns a host. Concurrent inspections share its bounded request map. */
export class HelperHost {
  private opening: Promise<Helper> | undefined;
  private epoch = 0;
  private closing: Promise<void> | undefined;
  private readonly options: HelperOptions;
  constructor(options: HelperOptions) {
    this.options = options;
  }
  open(): Promise<Helper> {
    if (this.closing) return this.closing.then(() => this.open());
    if (!this.opening) {
      const epoch = this.epoch;
      this.opening = Helper.open({
        ...this.options,
        onFailure: (error) => {
          if (epoch === this.epoch) {
            // Keep the owned process reachable until close confirms its death.
            void this.close();
            this.options.onFailure(error);
          }
        },
      })
        .then(async (helper) => {
          try {
            await helper.negotiate();
            if (epoch !== this.epoch) throw new Error("Helper opening cancelled");
            return helper;
          } catch (error) {
            await helper.close();
            throw error;
          }
        })
        .catch((error: unknown) => {
          if (epoch === this.epoch) this.opening = undefined;
          throw error;
        });
    }
    return this.opening;
  }
  async stopCapture(helper: import("./helper-session.ts").HelperPort): Promise<void> {
    if (!helper.capabilities) {
      await this.close();
      return;
    }
    try {
      await helper.request({ op: "stop" });
    } catch (error) {
      if (
        helper.capabilities?.background &&
        error instanceof HelperCommandError &&
        error.code === "target_gone"
      )
        return;
      try {
        await this.close();
      } catch (terminationError) {
        throw new ScreenStopError([error, terminationError], false);
      }
      this.options.onFailure(
        error instanceof Error ? error : new Error("Screen capture stop failed"),
      );
      throw new ScreenStopError([error], true);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const opening = this.opening;
    this.opening = undefined;
    this.epoch++;
    const closed = opening
      ? opening.then(
          (helper) => helper.close(),
          () => {},
        )
      : Promise.resolve();
    this.closing = closed.finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
