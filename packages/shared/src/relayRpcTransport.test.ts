import { Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  encodeRpcProtocolMessage,
  formatRelayTransportErrorMessage,
  reviveRpcProtocolMessage,
} from "./relayRpcTransport";

describe("relayRpcTransport RPC serialization", () => {
  it("formats object-shaped relay errors without falling back to [object Object]", () => {
    expect(
      formatRelayTransportErrorMessage({
        code: 1006,
        reason: "socket closed",
      }),
    ).toBe('{"code":1006,"reason":"socket closed"}');
  });

  it("prefers embedded message fields when formatting relay errors", () => {
    expect(
      formatRelayTransportErrorMessage({
        message: "relay route closed",
        code: 1006,
      }),
    ).toBe("relay route closed");
  });

  it("serializes bigint request ids as strings", () => {
    const encoded = encodeRpcProtocolMessage({
      _tag: "Request",
      id: 42n,
      tag: "server.getConfig",
      payload: {},
    });

    expect(JSON.parse(encoded)).toEqual({
      _tag: "Request",
      id: "42",
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
  });

  it("normalizes request headers into the websocket json shape", () => {
    const encoded = encodeRpcProtocolMessage({
      _tag: "Request",
      id: 7n,
      tag: "server.getConfig",
      payload: {},
      headers: {},
    });

    expect(JSON.parse(encoded)).toEqual({
      _tag: "Request",
      id: "7",
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
  });

  it("revives top-level rpc ids without touching payload ids", () => {
    const revived = reviveRpcProtocolMessage({
      _tag: "Exit",
      requestId: "7",
      exit: {
        _tag: "Success",
        value: {
          id: "workspace-thread",
        },
      },
    }) as {
      requestId: bigint;
      exit: {
        value: {
          id: string;
        };
      };
    };

    expect(revived.requestId).toBe(7n);
    expect(revived.exit.value.id).toBe("workspace-thread");
  });

  it("revives encoded exits into Effect exit values", () => {
    const revived = reviveRpcProtocolMessage({
      _tag: "Exit",
      requestId: "9",
      exit: {
        _tag: "Success",
        value: {
          cwd: "/tmp/project",
        },
      },
    }) as {
      exit: ReturnType<typeof Exit.succeed>;
    };

    expect(Exit.isExit(revived.exit)).toBe(true);
    expect(Exit.isSuccess(revived.exit)).toBe(true);
    if (Exit.isSuccess(revived.exit)) {
      expect(revived.exit.value).toEqual({
        cwd: "/tmp/project",
      });
    }
  });
});
