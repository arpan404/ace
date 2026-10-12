import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

export const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

/** Git launches askpass as an executable path, not a command with arguments. */
export async function executableAskpass(directory: string, name: string) {
  const marker = join(directory, `${name}-executed`);
  const path = join(directory, `${name}.sh`);
  await writeFile(path, `#!/bin/sh\nprintf executed > ${quote(marker)}\nprintf 'test-value\\n'\n`, {
    mode: 0o755,
  });
  return { marker, path };
}

export async function challengeRemote() {
  let requests = 0;
  let authenticated = false;
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization) {
      authenticated = true;
      response.writeHead(403);
    } else response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    requests: () => requests,
    authenticated: () => authenticated,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function helper(repo: string, name: string, fields: string = "") {
  const marker = join(dirname(repo), `${name}-executed`);
  const script = join(dirname(repo), `${name}.cjs`);
  await writeFile(
    script,
    `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');
    process.stdin.resume();
    process.stdin.on('end', () => {
      if (process.argv.at(-1) === 'get') process.stdout.write(${JSON.stringify(fields)});
    });
  `,
  );
  return { marker, command: `${quote(process.execPath)} ${quote(script)}` };
}
