import { spawn } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.ACE_LOCAL_DESKTOP_RUN = "1";

const child = spawn(resolveElectronPath(), ["dist-electron/main.js"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
