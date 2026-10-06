import { spawnSupervised, type probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";

/** Model adb's persistent stdin at the SDK boundary, executing effects before acknowledgements. */
export function deviceInputProcess(execute: typeof probeOutput): typeof spawnSupervised {
  return (options) => {
    if (options.name !== "device-input") return spawnSupervised(options);
    const serial = options.args?.[1];
    if (!serial) throw new Error("Missing fake device input transport");
    const child = spawnSupervised({
      command: process.execPath,
      args: [
        "-e",
        `
        let marker, status;
        function finish() {
          if (marker && status !== undefined) {
            console.log(marker + status); marker = undefined; status = undefined;
          }
        }
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          if (line.startsWith('status:')) { status = Number(line.slice(7)); finish(); }
          else if (line.startsWith('printf')) { marker = /ACE_INPUT_\\d+:/.exec(line)?.[0]; finish(); }
          else console.log(JSON.stringify({ command: line }));
        });
        `,
      ],
      env: {},
      name: "fake-adb-input",
    });
    child.stdout.on("line", (line: string) => {
      if (!line.startsWith('{"command":')) return;
      const { command } = z.object({ command: z.string() }).parse(JSON.parse(line));
      void execute(options.command, ["-s", serial, "shell", command], { env: options.env }).then(
        (result) => child.stdin.write(`status:${result.code ?? 1}\n`),
        () => child.stdin.write("status:1\n"),
      );
    });
    return child;
  };
}
