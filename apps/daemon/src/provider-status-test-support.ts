import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { nodeBinary } from "@ace/provider-kit/testing";

export async function fakeCli(
  root: string,
  name: string,
  version: string,
  auth: string,
  args: string,
  authExit = 0,
) {
  return nodeBinary(
    root,
    name,
    `
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args !== '--version' && args !== ${JSON.stringify(args)}) { process.stderr.write('UNSAFE COMMAND'); process.exit(90); }
fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, ${JSON.stringify(name)} + ':' + args + '\\n');
const output = args === '--version' ? ${JSON.stringify(version)} : fs.readFileSync(${JSON.stringify(join(root, `${name}-auth`))}, 'utf8');
process.stdout.write(output);
process.exit(args === '--version' ? 0 : ${authExit});
`,
  ).then(async (path) => {
    await writeFile(join(root, `${name}-auth`), auth);
    return path;
  });
}
