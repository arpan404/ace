import { Helper, type HelperOptions } from "./helper.ts";
type Handlers = Pick<HelperOptions, "onFrame" | "onFailure">;
/** Windows has one process for the host lifetime and one active capture lease. */
export class HelperOwner {
  readonly persistent: boolean;
  private readonly options: Omit<HelperOptions, "onFrame" | "onFailure">;
  private closed = false;
  private generation = 0;
  readonly nextGeneration = (): number => ++this.generation;
  private host: Promise<Helper> | undefined;
  private handlers: Handlers | undefined;
  constructor(options: Omit<HelperOptions, "onFrame" | "onFailure">) {
    this.options = options;
    this.persistent = (options.platform ?? process.platform) === "win32";
  }
  async open(handlers?: Handlers): Promise<Helper> {
    if (this.closed) throw new Error("Screen helper owner is closed");
    if (!this.persistent)
      return Helper.open({
        ...this.options,
        onFrame: handlers?.onFrame ?? (() => {}),
        onFailure: handlers?.onFailure ?? (() => {}),
      });
    if (handlers) this.handlers = handlers;
    this.host ??= Helper.open({
      ...this.options,
      onFrame: (frame) => this.handlers?.onFrame(frame),
      onFailure: (error) => {
        this.host = undefined;
        this.handlers?.onFailure(error);
      },
    }).catch((error: unknown) => {
      this.host = undefined;
      throw error;
    });
    return this.host;
  }
  async release(helper: Helper): Promise<void> {
    if (!this.persistent) await helper.close();
  }
  async stop(helper: Helper): Promise<void> {
    if (this.persistent) {
      try {
        await helper.request({ op: "stop" });
      } catch (error) {
        await helper.close();
        if ((await this.host?.catch(() => undefined)) === helper) this.host = undefined;
        throw error;
      }
    } else await helper.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    const host = this.host;
    this.host = undefined;
    this.handlers = undefined;
    await (await host)?.close();
  }
}
