import { Helper, type HelperOptions } from "./helper.ts";
type Handlers = Pick<HelperOptions, "onFrame" | "onFailure">;
/** Windows has one process for the host lifetime and one active capture lease. */
export class HelperOwner {
  readonly persistent: boolean;
  private readonly options: Omit<HelperOptions, "onFrame" | "onFailure">;
  private host: Promise<Helper> | undefined;
  private handlers: Handlers | undefined;
  constructor(options: Omit<HelperOptions, "onFrame" | "onFailure">) {
    this.options = options;
    this.persistent = (options.platform ?? process.platform) === "win32";
  }
  async open(handlers?: Handlers): Promise<Helper> {
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
    if (this.persistent) await helper.request({ op: "stop" }).catch(() => {});
    else await helper.close();
  }
  async close(): Promise<void> {
    await (await this.host)?.close();
    this.host = undefined;
    this.handlers = undefined;
  }
}
