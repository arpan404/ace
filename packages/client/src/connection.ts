import { parseCredential } from "./credentials.ts";
import { retryDelay, disconnectDecision, networkDecision } from "./lifecycle.ts";
import { fitsUtf8 } from "./bounds.ts";
import { ClientMessage, ServerMessage, type ServerMessage as Message } from "@ace/protocol";
import {
  ClientError,
  type ClientOptions,
  type ConnectionState,
  type Limits,
  type Transport,
} from "./types.ts";

export class Connection {
  state: ConnectionState = "offline";
  error: ClientError | undefined;
  private options: ClientOptions;
  private limits: Limits;
  private received: (message: Message) => void;
  private changed: () => void;
  private disconnected: () => void;
  private transport: Transport | undefined;
  private epoch = 0;
  private attempt = 0;
  private online = true;
  private active = false;
  private cancel: (() => void) | undefined;
  private heartbeat: (() => void) | undefined;
  private awaitingPong = false;
  constructor(
    options: ClientOptions,
    limits: Limits,
    received: (message: Message) => void,
    changed: () => void,
    disconnected: () => void,
  ) {
    this.options = options;
    this.limits = limits;
    this.received = received;
    this.changed = changed;
    this.disconnected = disconnected;
  }
  start(): void {
    if (this.active || this.state === "fatal") return;
    this.active = true;
    this.connect();
  }
  stop(): void {
    this.active = false;
    this.cleanup();
    this.setState("offline");
    this.disconnected();
  }
  networkOnline(online: boolean): void {
    const decision = networkDecision(this.state, this.active, this.online, online);
    this.online = online;
    if (decision === "offline") {
      this.cleanup();
      this.setState("offline");
      this.disconnected();
    } else if (decision === "connect") this.connect();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.changed();
  }
  private cleanup(): void {
    this.epoch++;
    this.cancel?.();
    this.cancel = undefined;
    this.heartbeat?.();
    this.heartbeat = undefined;
    const transport = this.transport;
    this.transport = undefined;
    try {
      transport?.close();
    } catch {
      /* The epoch already excludes late callbacks. */
    }
  }
  fail(error: ClientError): void {
    this.error = error;
    this.cleanup();
    this.setState("fatal");
    this.disconnected();
  }
  private lost(code: number): void {
    const decision = disconnectDecision(this.active, this.online, code);
    if (decision === "fatal") {
      this.fail(new ClientError(code === 4002 ? "protocol" : code === 1009 ? "limit" : "auth"));
      return;
    }
    this.cleanup();
    this.disconnected();
    if (decision === "offline") {
      this.setState("offline");
      return;
    }
    this.setState("reconnecting");
    let delay: number;
    try {
      delay = retryDelay(
        this.attempt++,
        this.limits.retryBaseMs,
        this.limits.retryCapMs,
        this.options.random(),
      );
    } catch {
      this.fail(new ClientError("protocol"));
      return;
    }
    this.cancel = this.options.scheduler.set(delay, () => this.connect());
  }
  private connect(): void {
    this.cleanup();
    if (!this.online) {
      this.setState("offline");
      return;
    }
    this.setState(this.attempt ? "reconnecting" : "connecting");
    const epoch = this.epoch;
    this.cancel = this.options.scheduler.set(this.limits.requestMs, () => this.lost(1006));
    try {
      const transport = this.options.transport();
      this.transport = transport;
      transport.open({
        open: () => {
          if (epoch !== this.epoch) return;
          void Promise.resolve()
            .then(() => this.options.credential())
            .then((credential) => {
              if (epoch === this.epoch)
                this.send({
                  type: "hello",
                  protocolVersion: 1,
                  deviceId: this.options.deviceId,
                  ...parseCredential(credential),
                });
            })
            .catch((error: unknown) => {
              if (epoch !== this.epoch) return;
              if (error instanceof ClientError && error.code === "offline") this.lost(1006);
              else this.fail(new ClientError("auth"));
            });
        },
        close: (code) => {
          if (epoch === this.epoch) this.lost(code);
        },
        message: (text) => {
          if (epoch !== this.epoch) return;
          try {
            if (!fitsUtf8(text, this.limits.frameBytes)) throw new ClientError("limit");
            const message = ServerMessage.parse(JSON.parse(text));
            if (message.type === "error" && message.code === "unauthorized") {
              this.fail(new ClientError("auth"));
              return;
            }
            if (this.state !== "ready") {
              if (message.type !== "welcome") throw new ClientError("protocol");
              this.cancel?.();
              this.cancel = undefined;
              this.attempt = 0;
              this.awaitingPong = false;
              this.state = "ready";
              this.tick();
              this.received(message);
              this.changed();
              return;
            } else if (message.type === "welcome") throw new ClientError("protocol");
            if (message.type === "pong") this.awaitingPong = false;
            this.received(message);
          } catch (error) {
            this.fail(error instanceof ClientError ? error : new ClientError("protocol"));
          }
        },
      });
    } catch {
      this.lost(1006);
    }
  }
  private tick(): void {
    if (this.state !== "ready") return;
    this.heartbeat = this.options.scheduler.set(this.limits.heartbeatMs, () => {
      if (this.awaitingPong) {
        this.lost(1006);
        return;
      }
      this.awaitingPong = true;
      this.send({ type: "ping" });
      if (this.state === "ready") this.tick();
    });
  }
  send(message: ClientMessage): boolean {
    if (!this.transport) return false;
    try {
      const text = JSON.stringify(ClientMessage.parse(message));
      if (!fitsUtf8(text, this.limits.sendBytes)) throw new ClientError("limit");
      this.transport.send(text);
      return true;
    } catch (error) {
      if (error instanceof ClientError) this.fail(error);
      else this.lost(1006);
      return false;
    }
  }
}
