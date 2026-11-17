import type { ScriptRule } from "./rule.ts";
import { scriptOperand, type ScriptView } from "./script-view.ts";

/*
 * The `scripts` check's rules (ADR 0173 §8): what a skill script, a plugin's hook or server
 * command, or a recipe's bundled script does that no entry should. Each rule reads the shell
 * reader's commands where the script is shell, and token patterns over the normalised text
 * otherwise. Every pattern is linear: no nested quantifiers, lines read are capped.
 */

type Hit = { line?: number; message: string };
type Command = ScriptView["commands"][number];

/** The longest line a pattern reads; past it the obfuscation rules already speak. */
const lineCap = 20_000;

const shells = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "fish",
  "python",
  "python2",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "osascript",
  "deno",
  "bun",
  "pwsh",
  "powershell",
  "lua",
  "tclsh",
  "source",
  ".",
  "eval",
]);
const fetchers = new Set([
  "curl",
  "wget",
  "fetch",
  "aria2c",
  "http",
  "https",
  "lwp-download",
  "lwp-request",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
]);

const program = (command: Command): string =>
  (command.words[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
const pipedProgram = (command: Command): string =>
  (command.pipedInto ?? "").split("/").pop()?.toLowerCase() ?? "";
const at = (line: number | undefined, message: string): Hit =>
  line === undefined ? { message } : { line, message };

/** Each line of the view with its number, capped. */
function* lines(view: ScriptView): Generator<[number, string]> {
  for (const [index, text] of view.lines.entries())
    yield [index + 1, text.length > lineCap ? text.slice(0, lineCap) : text];
}

/** Lines matching any pattern, once each. */
function matching(view: ScriptView, patterns: readonly RegExp[], message: string): Hit[] {
  const hits: Hit[] = [];
  for (const [line, text] of lines(view))
    if (patterns.some((pattern) => pattern.test(text))) hits.push(at(line, message));
  return hits;
}

const isShell = (view: ScriptView) => view.language === "shell";

/* ---------------------------------------------------------------- download and run */

const fetchThenRun: readonly RegExp[] = [
  // Another language's fetch handed straight to its own evaluator.
  /\bexec\s*\(\s*(?:urllib\.request\.)?urlopen\s*\(/i,
  /\bexec\s*\(\s*requests\.get\s*\(/i,
  /\bexec\s*\(\s*(?:urllib2|httpx|urllib\.request)\b/i,
  /\b(?:eval|Function)\s*\(\s*(?:await\s+)?\(?\s*(?:await\s+)?fetch\s*\(/,
  /\bnew\s+Function\s*\([^)\n]{0,200}\bfetch\s*\(/,
  /\b(?:iex|invoke-expression)\b[^\n]{0,200}\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b[^\n]{0,200}\|\s*(?:iex|invoke-expression)\b/i,
  /\beval\s*\(\s*(?:open|URI\.open|Net::HTTP\.get)\s*\(/,
  /\beval\s*\(\s*(?:get|LWP::Simple::get)\s*\(/,
  /\bdo\s+shell\s+script\s+"[^"\n]{0,200}\b(?:curl|wget)\b[^"\n]{0,200}\|\s*(?:ba|z)?sh\b/i,
];

/** `./x` and `x` name the same file. */
const pathKey = (word: string): string => word.replace(/^(?:\.\/)+/, "");

/**
 * Whether `command` runs a file in `files`: as its program (`./x`), as the script a shell or
 * interpreter runs past its options (`sh -eu x`, `source x`, `. x`, `python3 -u x`), as a shell's
 * input (`sh < x`), or by making it executable (`chmod +x x`).
 */
function runsFile(command: Command, files: ReadonlySet<string>): boolean {
  if (files.size === 0) return false;
  const name = program(command);
  const words = command.words;
  if (files.has(pathKey(words[0] ?? ""))) return true;
  if (shells.has(name)) {
    const operand = scriptOperand(words) ?? words[1];
    if (operand !== undefined && files.has(pathKey(operand))) return true;
    if (command.readsFrom.some((path) => files.has(pathKey(path)))) return true;
  }
  return name === "chmod" && words.slice(1).some((word) => files.has(pathKey(word)));
}

/** Shells that read a process substitution as their script: `bash -e <(…)`, `source <(…)`. */
const shellReadsSubstitution = String.raw`(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|source|\.)(?:\s+[-+]\S+){0,8}\s+<\(\s*(?:sudo\s+)?`;

const downloadExec: ScriptRule = {
  kind: "script",
  id: "download-exec",
  check: "scripts",
  level: "block",
  find(view) {
    const hits: Hit[] = [];
    const message = `${view.path} downloads code and runs it`;
    const fetched = new Set<string>();
    for (const command of view.commands) {
      const name = program(command);
      // A fetch piped into a shell or interpreter: `curl … | sh`, `curl … | xargs sh`.
      if (fetchers.has(name) && shells.has(pipedProgram(command)))
        hits.push(at(command.line, message));
      // Running what was fetched: `sh -eu x.sh`, `source x.sh`, `./x.sh`, `chmod +x x.sh`.
      if (runsFile(command, fetched)) hits.push(at(command.line, message));
      if (fetchers.has(name)) {
        // What it saves to, so running that file later counts too.
        const words = command.words;
        for (const [index, word] of words.entries())
          if ((word === "-o" || word === "--output" || word === "-O") && words[index + 1])
            fetched.add(pathKey(words[index + 1] ?? ""));
        for (const target of command.writesTo) fetched.add(pathKey(target));
      }
    }
    if (!isShell(view)) hits.push(...matching(view, fetchThenRun, message));
    // `sh -c "$(curl …)"`, `eval "$(wget …)"` and `bash <(curl …)` read as text too: the reader
    // can't read a process substitution and may nest the others past its depth.
    hits.push(
      ...matching(
        view,
        [
          // A multi-call applet (`busybox sh -c "$(busybox wget …)"`) reads as the applet.
          /\b(?:eval|source|(?:ba|z|da|k|a)?sh\s+-c)\s+["']?\$\(\s*(?:(?:busybox|toybox)\s+)?(?:curl|wget)\b/i,
          new RegExp(`${shellReadsSubstitution}(?:curl|wget|fetch|aria2c|iwr|irm)\\b`, "i"),
        ],
        message,
      ),
    );
    return hits;
  },
};

/* ---------------------------------------------------------------- decode and run */

const decoders = (command: Command): boolean => {
  const name = program(command);
  const flags = command.words.slice(1);
  if (name === "base64" || name === "gbase64")
    return flags.some((flag) => flag === "-d" || flag === "--decode" || flag === "-D");
  if (name === "xxd") return flags.includes("-r");
  if (name === "openssl") return flags.includes("-d") || flags.includes("base64");
  if (name === "uudecode" || name === "rev" || name === "gunzip" || name === "zcat") return true;
  if (name === "printf" || name === "echo")
    return command.words.some((word) => (word.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length >= 8);
  return false;
};

const decodeThenRun: readonly RegExp[] = [
  /\bexec\s*\(\s*(?:base64\.b64decode|codecs\.decode|bytes\.fromhex|zlib\.decompress|marshal\.loads|binascii\.(?:a2b_base64|unhexlify))\s*\(/,
  /\b(?:eval|exec)\s*\(\s*compile\s*\(\s*(?:base64|codecs|zlib)\./,
  /\b(?:eval|Function)\s*\(\s*(?:atob|unescape|decodeURIComponent)\s*\(/,
  /\b(?:eval|Function)\s*\(\s*Buffer\.from\s*\([^)\n]{0,4000}["'](?:base64|hex)["']/,
  /\bnew\s+Function\s*\(\s*(?:atob|Buffer\.from)\s*\(/,
  /\b(?:eval|Function)\s*\(\s*String\.fromCharCode\s*\(/,
  /\bpowershell(?:\.exe)?\b[^\n]{0,80}\s-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i,
  /\[System\.Convert\]::FromBase64String\([^\n]{0,4000}\b(?:iex|invoke-expression)\b/i,
  /\b(?:iex|invoke-expression)\b[^\n]{0,200}FromBase64String/i,
  /\beval\s*\(\s*(?:Base64\.decode64|\[[^\]\n]{0,200}\]\.pack)\s*\(/,
  /\beval\s*\(\s*(?:base64_decode|gzinflate|str_rot13|hex2bin)\s*\(/,
];

const decodeExec: ScriptRule = {
  kind: "script",
  id: "decode-exec",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} decodes hidden code and runs it`;
    const hits: Hit[] = [];
    const decoded = new Set<string>();
    for (const command of view.commands) {
      if (decoders(command) && shells.has(pipedProgram(command)))
        hits.push(at(command.line, message));
      // Running what was decoded to a file: `base64 -d > x; sh -e x`.
      if (runsFile(command, decoded)) hits.push(at(command.line, message));
      if (decoders(command)) for (const target of command.writesTo) decoded.add(pathKey(target));
    }
    hits.push(
      ...matching(
        view,
        [
          ...decodeThenRun,
          new RegExp(
            `${shellReadsSubstitution}(?:[^)|\\n]{0,400}\\|\\s*)?(?:(?:g?base64)\\s+(?:-d|--decode|-D)|xxd\\s+-r)\\b`,
            "i",
          ),
          /\beval\b[^\n]{0,400}\bbase64\s+(?:-d|--decode|-D)\b/i,
          /\$\(\s*(?:echo|printf)\b[^\n)]{0,4000}\|\s*base64\s+(?:-d|--decode|-D)\s*\)\s*$/i,
        ],
        message,
      ),
    );
    return hits;
  },
};

/* ---------------------------------------------------------------- persistence */

const persistPaths: readonly RegExp[] = [
  /Library\/Launch(?:Agents|Daemons)\b/i,
  /\/etc\/cron(?:tab|\.d|\.daily|\.hourly|\.weekly|\.monthly)?\b/,
  /\/var\/spool\/cron\b/,
  /(?:^|[\s"'=/~])\.(?:bashrc|bash_profile|bash_login|zshrc|zprofile|zshenv|zlogin|profile|kshrc|cshrc|tcshrc)\b/,
  /\.config\/fish\/config\.fish\b/,
  /\.config\/systemd\/user\b|\/etc\/systemd\/system\b|\/lib\/systemd\/system\b/,
  /\.config\/autostart\b/,
  /\/etc\/(?:rc\.local|init\.d|profile\.d)\b/,
  /CurrentVersion\\+Run(?:Once)?\b/i,
  /Start Menu\\+Programs\\+Startup/i,
  /\.ssh\/authorized_keys\b/,
];
const writers = new Set([
  "cp",
  "mv",
  "tee",
  "ln",
  "install",
  "rsync",
  "ditto",
  "cat",
  "echo",
  "printf",
  "sed",
]);

const persistence: ScriptRule = {
  kind: "script",
  id: "persistence",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} makes itself start again later, outside ace`;
    const hits: Hit[] = [];
    for (const command of view.commands) {
      const name = program(command);
      const words = command.words;
      const anyPath = (list: readonly string[]) =>
        list.some((word) => persistPaths.some((pattern) => pattern.test(word)));
      if (
        (name === "launchctl" &&
          /^(?:load|bootstrap|enable|submit|kickstart)$/.test(words[1] ?? "")) ||
        (name === "crontab" && words.length > 1 && !words.includes("-l")) ||
        (name === "systemctl" && words.includes("enable")) ||
        (name === "schtasks" && words.some((word) => /^[/-]create$/i.test(word))) ||
        (name === "reg" && /^add$/i.test(words[1] ?? "") && anyPath(words)) ||
        anyPath(command.writesTo) ||
        (writers.has(name) && anyPath(words.slice(1)) && (name !== "sed" || words.includes("-i")))
      )
        hits.push(at(command.line, message));
    }
    hits.push(
      ...matching(
        view,
        [
          /\bmake\s+(?:new\s+)?login\s+item\b/i,
          /\bSMLoginItemSetEnabled\b|\bSMAppService\b[^\n]{0,80}\bregister\b/,
          /\bAutoLaunchedApplicationDictionary\b/,
          /\bNew-ItemProperty\b[^\n]{0,200}CurrentVersion\\+Run/i,
          /\bRegister-ScheduledTask\b/i,
        ],
        message,
      ),
    );
    if (!isShell(view))
      for (const [line, text] of lines(view))
        if (
          persistPaths.some((pattern) => pattern.test(text)) &&
          /\b(?:open\s*\([^\n]{0,300}["'][aw]b?\+?["']|write(?:File|FileSync|_text)?\s*\(|append(?:File|FileSync)?\s*\(|copyfile|shutil\.copy|fs\.copy|File\.write|Set-Content|Add-Content|Out-File)/.test(
            text,
          )
        )
          hits.push(at(line, message));
    return hits;
  },
};

/* ---------------------------------------------------------------- credentials */

const secretPaths: readonly RegExp[] = [
  /~?\/?\.ssh\/(?:id_[a-z0-9]+|identity|known_hosts|config)\b/,
  /\.aws\/(?:credentials|config)\b/,
  /\.config\/gcloud\b/,
  /\.azure\/(?:accessTokens|msal_token_cache|azureProfile)/,
  /\.kube\/config\b/,
  /\.docker\/config\.json\b/,
  /(?:^|[\s"'/~])\.(?:npmrc|netrc|pgpass|git-credentials|pypirc)\b/,
  /Library\/Keychains\b|login\.keychain(?:-db)?\b/,
  /\bLogin\\? Data\b|\bWeb\\? Data\b|\bkey4\.db\b|\blogins\.json\b|\bcookies\.sqlite\b/,
  /Application\\? Support\/(?:Google\/Chrome|BraveSoftware|Microsoft\\? Edge|Firefox|Arc)\b/i,
  /\.mozilla\/firefox\b|\.config\/(?:google-chrome|chromium|BraveSoftware)\b/,
  /\bwallet\.dat\b|Application\\? Support\/(?:Exodus|Electrum|atomic)\b/i,
  /\bnkbihfbeogaeaoehlefnkodbefgpgknn\b/,
  /Telegram Desktop\/tdata\b|\btdata\/(?:key_data|D877F783D5D3EF8C)/i,
];
const credentialCommands: readonly RegExp[] = [
  /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain|export|find-certificate\s+-p)\b/,
  /\bgh\s+auth\s+token\b/,
  /\baws\s+configure\s+get\s+\S*secret/i,
  /\bgcloud\s+auth\s+(?:print-access-token|print-identity-token)\b/,
  /\baz\s+account\s+get-access-token\b/,
  /\bop\s+(?:read|item\s+get)\b/,
  /\bbw\s+get\s+(?:password|item)\b/,
  /\bkeyring\.get_password\s*\(/,
  /\bSecKeychainFindGenericPassword\b|\bkSecReturnData\b/,
  /\bCryptUnprotectData\b|\bvaultcmd\b/i,
];

const credentialAccess: ScriptRule = {
  kind: "script",
  id: "credential-access",
  check: "scripts",
  level: "block",
  find(view) {
    return [
      ...matching(view, secretPaths, `${view.path} reads where your keys and passwords are kept`),
      ...matching(view, credentialCommands, `${view.path} asks for a stored password or token`),
    ];
  },
};

const readsEnvFile: ScriptRule = {
  kind: "script",
  id: "reads-env-file",
  check: "scripts",
  level: "warn",
  find(view) {
    return matching(
      view,
      [
        /\b(?:cat|less|more|head|tail|source|\.)\s(?:[^\n|;&]{0,80}[\s/"'])?\.env(?:\.[a-z]+)?\b/,
        /\b(?:open|readFile(?:Sync)?|read_text|File\.read)\s*\([^)\n]{0,120}["'][^"'\n]{0,80}\.env["']/,
      ],
      `${view.path} reads a .env file, where keys are often kept`,
    );
  },
};

/* ---------------------------------------------------------------- sending data out */

const sendsFile = (command: Command): boolean => {
  const name = program(command);
  const words = command.words;
  if (name === "curl")
    return words.some(
      (word, index) =>
        ((word === "-d" ||
          word === "--data" ||
          word === "--data-binary" ||
          word === "--data-raw" ||
          word === "--data-urlencode" ||
          word === "-F" ||
          word === "--form") &&
          /@/.test(words[index + 1] ?? "")) ||
        word === "-T" ||
        word === "--upload-file" ||
        /^-d@|^--data(?:-binary)?=@/.test(word),
    );
  if (name === "wget") return words.some((word) => /^--(?:post-file|body-file)\b/.test(word));
  if (name === "nc" || name === "ncat" || name === "netcat" || name === "socat")
    return command.readsFrom.length > 0;
  return false;
};
const sendsEnv = (command: Command): boolean =>
  fetchers.has(program(command)) &&
  command.words.some(
    (word) =>
      /\$\(\s*(?:env|printenv|set|cat\s)/.test(word) ||
      /\$\{?[A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)/.test(word),
  );

const exfiltration: ScriptRule = {
  kind: "script",
  id: "exfiltration",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} sends your files or settings to another computer`;
    const hits: Hit[] = [];
    for (const command of view.commands) {
      const name = program(command);
      if (sendsFile(command) || sendsEnv(command)) hits.push(at(command.line, message));
      // `env | curl …`, `cat ~/.ssh/id_rsa | nc …`.
      if (
        (name === "env" ||
          name === "printenv" ||
          name === "set" ||
          name === "cat" ||
          name === "tar" ||
          name === "zip") &&
        (fetchers.has(pipedProgram(command)) ||
          ["nc", "ncat", "netcat", "socat"].includes(pipedProgram(command)))
      )
        hits.push(at(command.line, message));
      if (
        (name === "nslookup" || name === "dig" || name === "host") &&
        command.words.some((word) => word.includes("$("))
      )
        hits.push(at(command.line, message));
    }
    if (!isShell(view))
      hits.push(
        ...matching(
          view,
          [
            /\brequests\.(?:post|put)\s*\([^\n]{0,400}\b(?:files\s*=|data\s*=\s*open\s*\(|os\.environ)/,
            /\b(?:fetch|axios(?:\.post|\.put)?|got\.post|https?\.request)\s*\([^\n]{0,400}\b(?:process\.env|readFileSync|os\.homedir\(\))/,
            /\bJSON\.stringify\s*\(\s*process\.env\s*\)[^\n]{0,400}\b(?:fetch|axios|request|send)\b/,
            /\b(?:urlopen|urllib\.request\.Request)\s*\([^\n]{0,400}\b(?:os\.environ|open\s*\()/,
            /\bInvoke-(?:WebRequest|RestMethod)\b[^\n]{0,400}-(?:InFile|Body)\s+[^\n]{0,200}(?:\$env:|Get-Content|Get-ChildItem\s+env:)/i,
          ],
          message,
        ),
      );
    return hits;
  },
};

/* ---------------------------------------------------------------- mining */

const mining: ScriptRule = {
  kind: "script",
  id: "crypto-mining",
  check: "scripts",
  level: "block",
  find(view) {
    return matching(
      view,
      [
        /\b(?:xmrig|xmr-stak|cpuminer|minerd|cgminer|bfgminer|ethminer|nbminer|t-rex|lolminer|phoenixminer|nanominer|srbminer|teamredminer|ccminer)\b/i,
        /\bstratum\+(?:tcp|ssl|tls):\/\//i,
        /--donate-level\b|--cpu-max-threads-hint\b/,
        /\bcryptonight\b|\brandomx\b[^\n]{0,80}\bminer\b/i,
        /\b(?:supportxmr|minexmr|nanopool|f2pool|2miners|moneroocean|hashvault|herominers|c3pool|unmineable|nicehash)\.(?:com|org|net|pro|me|io)\b/i,
        /\bcoin-?hive\b|\bcryptoloot\b|\bcoinimp\b/i,
      ],
      `${view.path} mines cryptocurrency on your computer`,
    );
  },
};

/* ---------------------------------------------------------------- remote shells */

const reverseShell: ScriptRule = {
  kind: "script",
  id: "reverse-shell",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} hands a shell on your computer to another one`;
    const hits = matching(
      view,
      [
        /\/dev\/(?:tcp|udp)\/[^\s/]+\/\d+/,
        /\b(?:nc|ncat|netcat)\b[^\n|;&]{0,120}\s-(?:[a-z]*e|c)\s+\S*(?:sh|cmd|powershell)\b/i,
        /\bmkfifo\b[^\n]{0,200}\b(?:nc|ncat|netcat|telnet)\b/,
        /\bsocat\b[^\n]{0,200}\b(?:exec|system):[^\n]{0,200}\btcp/i,
        /\bsocat\b[^\n]{0,200}\btcp[^\n]{0,200}\b(?:exec|system):/i,
        /\btelnet\b[^\n]{0,120}\|\s*\/bin\/(?:ba)?sh\b[^\n]{0,120}\|\s*telnet\b/,
        /\bNet\.Sockets\.TCPClient\b[^\n]{0,600}\bGetStream\b/i,
        /\bfsockopen\s*\([^\n]{0,300}\b(?:exec|shell_exec|system|passthru|proc_open)\s*\(/,
        /\bTCPSocket\.(?:new|open)\b[^\n]{0,300}\b(?:exec|spawn|system)\b/,
      ],
      message,
    );
    // A socket and its streams wired to a shell, anywhere in one file.
    const text = view.text.length > 1_000_000 ? view.text.slice(0, 1_000_000) : view.text;
    const socket =
      /\bsocket\.socket\s*\(|\bsocket\s*\(\s*(?:S|AF_INET)|\bnet\.(?:connect|Socket)\b|\bnew\s+net\.Socket\b/.test(
        text,
      );
    const wired =
      /\bos\.dup2\s*\(|\bpty\.spawn\s*\(|\.pipe\s*\(\s*(?:sh|shell|proc)\.stdin\b|child_process[^\n]{0,200}\b(?:\/bin\/sh|cmd\.exe)/.test(
        text,
      );
    if (socket && wired && hits.length === 0) hits.push({ message });
    return hits;
  },
};

/* ---------------------------------------------------------------- privilege */

const privilege: ScriptRule = {
  kind: "script",
  id: "privilege-escalation",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} asks for administrator rights`;
    const hits: Hit[] = [];
    for (const command of view.commands) {
      const name = program(command);
      const words = command.words;
      if (
        name === "sudo" ||
        name === "doas" ||
        name === "pkexec" ||
        name === "visudo" ||
        name === "setcap" ||
        (name === "su" &&
          (words.length === 1 ||
            words.some(
              (word) => word === "-" || word === "root" || word === "-c" || word === "-l",
            ))) ||
        (name === "chmod" &&
          words
            .slice(1)
            .some((word) => /^(?:[ugoa]*\+[rwx]*s|[0-7]?[2467][0-7]{3})$/.test(word))) ||
        ((name === "chown" || name === "chgrp") &&
          words.slice(1).some((word) => /^root(?::|$)|^0(?::|$)/.test(word))) ||
        (name === "dscl" && words.some((word) => /admin/.test(word))) ||
        command.writesTo.some((target) => /\/etc\/sudoers/.test(target))
      )
        hits.push(at(command.line, message));
    }
    hits.push(
      ...matching(
        view,
        [
          /\bwith\s+administrator\s+privileges\b/i,
          /\bAuthorizationExecuteWithPrivileges\b/,
          /\/etc\/sudoers(?:\.d)?\b[^\n]{0,80}(?:>>|tee|write|open)|(?:>>|tee\s+-a)\s*\/etc\/sudoers/,
          /\bStart-Process\b[^\n]{0,200}-Verb\s+RunAs\b/i,
          /\bsubprocess\.[a-z_]+\s*\(\s*\[\s*["']sudo["']/,
          /\b(?:exec|spawn|execSync|spawnSync)\s*\(\s*["']sudo\b/,
        ],
        message,
      ),
    );
    return hits;
  },
};

/* ---------------------------------------------------------------- security tools */

const disablesSecurity: ScriptRule = {
  kind: "script",
  id: "disables-security",
  check: "scripts",
  level: "block",
  find(view) {
    return matching(
      view,
      [
        /\bspctl\s+--(?:master-disable|global-disable|disable)\b/,
        /\bcsrutil\s+(?:disable|authenticated-root\s+disable)\b/,
        /\bxattr\s+(?:-[a-z]*d[a-z]*\s+com\.apple\.quarantine|-[a-z]*c[a-z]*\b)/,
        /\bLSQuarantine\b/,
        /\btccutil\s+reset\b|\bTCC\.db\b/,
        /\bsetenforce\s+0\b|\bufw\s+disable\b|\biptables\s+-F\b/,
        /\bsystemctl\s+(?:stop|disable|mask)\s+(?:firewalld|apparmor|auditd|clamav|ufw)\b/,
        /\bSet-MpPreference\b[^\n]{0,200}-Disable|\bAdd-MpPreference\b[^\n]{0,200}-Exclusion/i,
        /\bnetsh\s+advfirewall\s+set\b[^\n]{0,80}\bstate\s+off\b/i,
        /\b(?:killall|pkill|kill\s+-9)\b[^\n]{0,80}\b(?:Little\s?Snitch|LuLu|BlockBlock|KnockKnock|XProtect|MRT|osquery|falcon|SentinelOne|CbDefense|santa)\b/i,
        /\blaunchctl\s+(?:unload|bootout|disable)\b[^\n]{0,200}\bcom\.apple\.(?:XProtect|MRT|ManagedClient|security|syspolicy)/i,
        /\bdefaults\s+write\s+com\.apple\.(?:security|LaunchServices|alf|syspolicy)/i,
        /\bsocketfilterfw\b[^\n]{0,80}--setglobalstate\s+off\b/,
      ],
      `${view.path} turns off a security protection`,
    );
  },
};

const coversTracks: ScriptRule = {
  kind: "script",
  id: "covers-tracks",
  check: "scripts",
  level: "warn",
  find(view) {
    return matching(
      view,
      [
        /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\bHISTFILE=\/dev\/null\b|\blog\s+erase\b/,
        /\bshred\b[^\n]{0,80}\$0\b|\brm\s+-[a-z]*f[a-z]*\s+["']?\$0\b/,
      ],
      `${view.path} erases its own traces`,
    );
  },
};

/* ---------------------------------------------------------------- hiding what it does */

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

const decoderWords =
  /\b(?:b64decode|atob|base64\s+(?:-d|--decode|-D)|FromBase64String|Buffer\.from|decode64|base64_decode|unhexlify|fromhex)\b/;

const obfuscation: ScriptRule = {
  kind: "script",
  id: "obfuscated",
  check: "scripts",
  level: "warn",
  find(view) {
    const hits: Hit[] = [];
    const text = view.text.length > 1_000_000 ? view.text.slice(0, 1_000_000) : view.text;
    const hexIdentifiers = (text.match(/\b_0x[a-f0-9]{4,6}\b/g) ?? []).length;
    for (const [line, value] of lines(view)) {
      if (
        /[A-Za-z0-9+/]{1000}/.test(value) ||
        /(?:\\x[0-9a-fA-F]{2}){60}|[0-9a-f]{600}/.test(value)
      )
        hits.push(at(line, `${view.path} line ${line} holds a long encoded blob`));
      else if (value.length >= 400 && entropy(value) >= 5.2)
        hits.push(at(line, `${view.path} line ${line} reads as scrambled text`));
      if ((value.match(/\d{2,3}\s*,/g) ?? []).length >= 40 && /fromCharCode/.test(value))
        hits.push(at(line, `${view.path} line ${line} builds text from character codes`));
    }
    if (hexIdentifiers >= 20)
      hits.push({ message: `${view.path} has its names scrambled by an obfuscator` });
    const longest = view.lines.reduce((top, value) => Math.max(top, value.length), 0);
    if (view.language !== "text" && longest > 5000 && view.lines.length <= 3)
      hits.push({ message: `${view.path} is packed onto one line` });
    for (const command of view.commands)
      if (
        (command.words[0] ?? "").startsWith("$") &&
        !/^\$\{[A-Z_]*ROOT\}\//.test(command.words[0] ?? "")
      )
        hits.push(at(command.line, `${view.path} runs a program named by a variable`));
    if (view.unreadable)
      hits.push({ message: `${view.path} can't be read for sure, so ace can't say what it runs` });
    return hits;
  },
};

const packed: ScriptRule = {
  kind: "script",
  id: "packed-code",
  check: "scripts",
  level: "block",
  find(view) {
    const message = `${view.path} hides its code behind a packer`;
    const hits = matching(
      view,
      [
        /\beval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)/,
        /(?:\[\]\+|\(!\[\]\+\[\]\)|!!\[\]\+){12}/,
      ],
      message,
    );
    // A long encoded blob in a file that also decodes: the blob is code waiting to run.
    const text = view.text.length > 1_000_000 ? view.text.slice(0, 1_000_000) : view.text;
    if (
      /[A-Za-z0-9+/]{1000}/.test(text) &&
      decoderWords.test(text) &&
      /\b(?:eval|exec|Function|iex|invoke-expression|sh|bash)\b/i.test(text)
    )
      hits.push({ message: `${view.path} decodes a long hidden blob and runs it` });
    return hits;
  },
};

const selfModifying: ScriptRule = {
  kind: "script",
  id: "self-modifying",
  check: "scripts",
  level: "warn",
  find(view) {
    return matching(
      view,
      [
        /(?:>>?|tee\s+(?:-a\s+)?|sed\s+-i[^\n]{0,40})\s*["']?\$(?:0|\{0\}|BASH_SOURCE)\b/,
        /\bopen\s*\(\s*__file__\s*,\s*["'][wa]/,
        /\bwriteFile(?:Sync)?\s*\(\s*(?:__filename|fileURLToPath\s*\(\s*import\.meta\.url)/,
        /\b(?:Set|Add)-Content\b[^\n]{0,80}\$PSCommandPath\b/i,
      ],
      `${view.path} rewrites itself as it runs`,
    );
  },
};

/** Talking to the network at all: shown, and holds a new publisher's version (§9). */
const networkNote: ScriptRule = {
  kind: "script",
  id: "network",
  check: "scripts",
  level: "note",
  strict: true,
  find(view) {
    const fetches = view.commands.filter((command) => fetchers.has(program(command)));
    return fetches.length > 0 ? [{ message: `${view.path} reaches the internet` }] : [];
  },
};

export const scriptRules: ScriptRule[] = [
  downloadExec,
  decodeExec,
  persistence,
  credentialAccess,
  readsEnvFile,
  exfiltration,
  mining,
  reverseShell,
  privilege,
  disablesSecurity,
  coversTracks,
  obfuscation,
  packed,
  selfModifying,
  networkNote,
];
