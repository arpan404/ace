import type { LookupFunction, TcpNetConnectOpts } from "node:net";

/** Pin both loopback families; /etc/hosts and DNS cannot redirect an upstream. */
const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
  if (options.all)
    callback(null, [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  else if (options.family === 6) callback(null, "::1", 6);
  else callback(null, "127.0.0.1", 4);
};

export function loopbackConnection(port: number): TcpNetConnectOpts {
  return { host: "localhost", port, lookup: loopbackLookup, autoSelectFamily: true };
}
