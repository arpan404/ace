#!/usr/bin/env node
import { runAccountsCommand } from "./commands-cli.ts";
await runAccountsCommand(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    "Account command failed. Check arguments, provider installation and CLI login.\n",
  );
  process.exitCode = 1;
});
