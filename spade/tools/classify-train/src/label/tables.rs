//! The labeller's tables: what a program, and its subcommand, does. Written for measuring, from
//! what each tool documents; a program missing here is `Unsure`.

use spade_core::effect::Effect::*;

use super::Label;

/// The tables: what a program (and its subcommand) does.
pub(super) fn table(
    program: &str,
    positional: &[&str],
    args: &[&str],
    has: &dyn Fn(&[&str]) -> bool,
) -> Label {
    let sub = positional.first().copied().unwrap_or("");
    let sub2 = positional.get(1).copied().unwrap_or("");
    let sure = Label::Sure;
    if args
        .iter()
        .any(|a| matches!(*a, "--version" | "-V" | "--help" | "-h"))
        && args.len() == 1
    {
        return sure(Read);
    }
    match program {
        // Reading.
        "ls" | "cat" | "head" | "tail" | "less" | "more" | "wc" | "stat" | "file" | "grep"
        | "egrep" | "fgrep" | "rg" | "ag" | "ack" | "fd" | "tree" | "du" | "df" | "pwd"
        | "echo" | "printf" | "which" | "type" | "whereis" | "date" | "uname" | "id" | "whoami"
        | "hostname" | "jq" | "yq" | "sort" | "uniq" | "cut" | "tr" | "diff" | "cmp" | "comm"
        | "column" | "nl" | "od" | "xxd" | "hexdump" | "strings" | "basename" | "dirname"
        | "realpath" | "readlink" | "sha256sum" | "sha1sum" | "md5sum" | "shasum" | "cksum"
        | "b2sum" | "true" | "false" | "test" | "[" | "sleep" | "seq" | "ps" | "pgrep" | "lsof"
        | "free" | "uptime" | "nproc" | "lscpu" | "lsblk" | "printenv" | "locale" | "tac"
        | "rev" | "fold" | "fmt" | "expand" | "paste" | "join" | "bat" | "exa" | "eza" | "wait"
        | "command" | "time" | "timeout" | "getconf" | "ldd" | "nm" | "objdump" | "readelf"
        | "size" | "tokei" | "cloc" | "pstree" | "w" | "who" | "last" | "groups" | "tty"
        | "stty" | "cal" | "factor" | "expr" | "bc" | "numfmt" | "look" | "tput" | "dmesg"
        | "journalctl" | "lsmod" | "lspci" | "lsusb" | "ip" | "ss" | "netstat" | "env" | "set"
        | "export" | "unset" | "read" | "exit" | "return" | "shift" | "local" | "declare"
        | "trap" | "jobs" | "hash" | "ulimit" | "umask" | "getent" | "mimetype" | "identify"
        | "ffprobe" | "pdfinfo" | "pdftotext" | "fc-list" | "xdg-mime" | "awk" | "gawk"
        | "mawk" | "cd" | "pushd" | "popd" | "watch" | "md5" | "csvlook" | "csvstat"
        | "xmllint" | "tidy" | "glow" | "delta" | "difft" | "colordiff" | "vimdiff" | "hexyl"
        | "fzf" => {
            if program == "awk"
                && args
                    .iter()
                    .any(|a| a.contains("system(") || a.contains('|'))
            {
                return Label::Unsure;
            }
            if program == "ip"
                && !matches!(sub, "a" | "addr" | "address" | "r" | "route" | "link" | "")
            {
                return sure(Network);
            }
            if program == "journalctl" && has(&["--vacuum-size", "--vacuum-time", "--rotate"]) {
                return sure(Network);
            }
            if program == "dmesg" && has(&["-c", "-C"]) {
                return sure(Network);
            }
            sure(Read)
        }
        "sed" | "perl" if has(&["-i"]) => sure(WriteLocal),
        "sed" => sure(Read),
        "find" => {
            if has(&["-delete", "-fprint", "-fls"]) {
                sure(WriteLocal)
            } else if has(&["-exec", "-execdir", "-ok", "-okdir"]) {
                Label::Unsure
            } else {
                sure(Read)
            }
        }
        // Changing files in the folder.
        "touch" | "mkdir" | "cp" | "mv" | "rm" | "rmdir" | "ln" | "tee" | "truncate" | "chmod"
        | "tar" | "zip" | "unzip" | "gzip" | "gunzip" | "xz" | "unxz" | "bzip2" | "zstd" | "7z"
        | "patch" | "install" | "split" | "csplit" | "shred" | "dd" | "mktemp" | "rsync"
        | "convert" | "magick" | "ffmpeg" | "pandoc" | "prettier" | "eslint" | "oxlint"
        | "oxfmt" | "biome" | "black" | "ruff" | "isort" | "rustfmt" | "gofmt" | "clang-format"
        | "shellcheck" | "shfmt" | "tsc" | "esbuild" | "vite" | "vitest" | "jest" | "mocha"
        | "pytest" | "tox" | "nox" | "mypy" | "pyright" | "rustc" | "gcc" | "g++" | "cc"
        | "clang" | "clang++" | "ld" | "javac" | "java" | "kotlinc" | "swiftc" | "zig" | "nim"
        | "ghc" | "cabal" | "stack" | "cmake" | "ninja" | "meson" | "make" | "gmake" | "just"
        | "task" | "bazel" | "buck" | "mvn" | "gradle" | "gradlew" | "ant" | "sbt" | "lein"
        | "mix" | "elixir" | "erl" | "rebar3" | "dotnet" | "qmake" | "qmake6" | "makepkg"
        | "pkg-config" | "protoc" | "sqlite3" | "duckdb" | "wasm-pack" | "trunk" | "turbo"
        | "nx" | "lerna" | "playwright" | "cypress" | "storybook" | "tailwindcss" | "postcss"
        | "sass" | "webpack" | "rollup" | "parcel" | "swc" | "deno" | "go" | "cargo" | "rustup"
        | "npm" | "npx" | "pnpm" | "pnpx" | "yarn" | "bun" | "bunx" | "pip" | "pip3" | "uv"
        | "uvx" | "poetry" | "pipenv" | "conda" | "mamba" | "gem" | "bundle" | "composer"
        | "flutter" | "dart" | "swift" | "xcodebuild" | "docker" | "podman" | "git" | "gh"
        | "glab" | "jj" | "hg" | "svn" => dev(program, sub, sub2, args, has),
        // Interpreters: the code they run decides; Spade's rules show it to the reviewer.
        "python" | "python3" | "node" | "ruby" | "php" | "lua" | "sh" | "bash" | "zsh" | "dash"
        | "fish" | "pwsh" | "powershell" | "tclsh" | "Rscript" | "julia" => {
            if args.is_empty() {
                Label::Unsure
            } else if has(&["--version", "-V"]) {
                sure(Read)
            } else if program.starts_with("python") && sub == "-m" {
                dev(
                    match positional.get(1).copied().unwrap_or("") {
                        "pip" => "pip",
                        "pytest" => "pytest",
                        "venv" | "http.server" | "json.tool" | "unittest" | "compileall" => "make",
                        _ => return Label::Unsure,
                    },
                    positional.get(2).copied().unwrap_or(""),
                    "",
                    args,
                    has,
                )
            } else {
                Label::Unsure
            }
        }
        // Network, and changes outside the bot.
        "curl" | "wget" | "http" | "https" | "xh" | "httpie" | "aria2c" => {
            let sends = has(&[
                "-d",
                "--data",
                "--data-raw",
                "--data-binary",
                "--data-urlencode",
                "--json",
                "-F",
                "--form",
                "-T",
                "--upload-file",
                "--post-data",
                "--post-file",
                "--method",
            ]) || args.iter().any(|a| {
                matches!(*a, "POST" | "PUT" | "PATCH" | "DELETE")
                    || a.starts_with("-XPOST")
                    || a.starts_with("-XPUT")
                    || a.starts_with("-XDELETE")
                    || a.starts_with("-XPATCH")
            }) || (matches!(program, "http" | "https" | "xh")
                && (positional
                    .iter()
                    .any(|a| a.contains('=') || a.contains(":="))
                    || matches!(sub, "POST" | "PUT" | "PATCH" | "DELETE")));
            let auth = args.iter().any(|a| {
                let a = a.to_ascii_lowercase();
                a.starts_with("authorization:") || a.contains("bearer ") || a.contains("token ")
            }) || has(&["-u", "--user", "--oauth2-bearer"]);
            if sends {
                sure(Network)
            } else if auth {
                // Its own sign-in: what it reads may be the person's private data.
                Label::Unsure
            } else if program == "wget" && !has(&["-O", "-qO-", "--spider", "-q"])
                || has(&[
                    "-o",
                    "--output",
                    "-O",
                    "--remote-name",
                    "-OL",
                    "-LO",
                    "-sSLO",
                ])
            {
                sure(WriteLocal)
            } else {
                sure(Read)
            }
        }
        "ssh" | "scp" | "sftp" | "ftp" | "telnet" | "nc" | "ncat" | "netcat" | "socat" | "mosh"
        | "rclone" | "s3cmd" | "gsutil" | "aws" | "gcloud" | "az" | "doctl" | "heroku" | "fly"
        | "flyctl" | "vercel" | "netlify" | "wrangler" | "firebase" | "supabase" | "railway"
        | "render" | "pulumi" | "terraform" | "tofu" | "kubectl" | "helm" | "kubectx"
        | "minikube" | "ansible" | "ansible-playbook" | "nmap" | "ping" | "traceroute" | "dig"
        | "nslookup" | "host" | "whois" | "mtr" => ops(program, sub, sub2, has),
        "kill"
        | "pkill"
        | "killall"
        | "systemctl"
        | "service"
        | "launchctl"
        | "reboot"
        | "shutdown"
        | "poweroff"
        | "halt"
        | "mount"
        | "umount"
        | "chown"
        | "chgrp"
        | "useradd"
        | "userdel"
        | "groupadd"
        | "crontab"
        | "at"
        | "apt"
        | "apt-get"
        | "dpkg"
        | "yum"
        | "dnf"
        | "pacman"
        | "yay"
        | "paru"
        | "brew"
        | "port"
        | "snap"
        | "flatpak"
        | "nix-env"
        | "defaults"
        | "diskutil"
        | "pmset"
        | "scutil"
        | "networksetup"
        | "nmcli"
        | "iptables"
        | "ufw"
        | "sysctl"
        | "modprobe"
        | "insmod"
        | "hdiutil"
        | "mkfs"
        | "fdisk"
        | "parted"
        | "swapon"
        | "xdg-settings"
        | "gsettings"
        | "dconf"
        | "update-alternatives"
        | "ldconfig"
        | "nohup"
        | "disown"
        | "setsid"
        | "hyprctl"
        | "omarchy" => system(program, sub, args),
        "osascript" | "xdotool" | "ydotool" | "wtype" | "cliclick" | "automator" | "shortcuts"
        | "open" | "xdg-open" | "notify-send" | "say" | "afplay" | "wl-copy" | "pbcopy"
        | "xclip" | "xsel" | "screencapture" | "grim" | "import" => {
            if matches!(program, "shortcuts") && matches!(sub, "list" | "view") {
                sure(Read)
            } else {
                sure(Drive)
            }
        }
        "mail" | "mailx" | "sendmail" | "mutt" | "neomutt" | "msmtp" | "swaks" | "himalaya"
        | "signal-cli" | "telegram-send" | "slack" | "twurl" | "toot" => sure(SendAsPerson),
        "stripe" => match sub {
            "listen" | "logs" | "events" | "get" | "status" | "version" | "open" => sure(Read),
            _ if positional
                .iter()
                .any(|p| matches!(*p, "list" | "retrieve" | "get")) =>
            {
                sure(Read)
            }
            "login" | "logout" | "config" => sure(ChangeAccess),
            _ => sure(Pay),
        },
        "passwd" | "chpasswd" | "usermod" | "ssh-keygen" | "ssh-add" | "ssh-copy-id" | "gpg"
        | "gpg2" | "certutil" | "keytool" | "htpasswd" | "visudo" => {
            if program.starts_with("gpg") && has(&["--verify", "--list-keys", "-k"]) {
                sure(Read)
            } else {
                sure(ChangeAccess)
            }
        }
        "security" | "op" | "pass" | "vault" | "bw" | "lpass" | "keepassxc-cli" | "secret-tool"
        | "aws-vault" | "doppler" | "infisical" => sure(Credential),
        _ => Label::Unsure,
    }
}

/// Dev tools: builds, tests, package managers, version control and forges.
fn dev(
    program: &str,
    sub: &str,
    sub2: &str,
    args: &[&str],
    has: &dyn Fn(&[&str]) -> bool,
) -> Label {
    let sure = Label::Sure;
    let global = has(&["-g", "--global", "--system", "--user", "--location=global"]);
    match program {
        "git" => git(sub, sub2, args, has),
        "gh" | "glab" => forge(sub, sub2, args, has),
        "jj" | "hg" | "svn" => match sub {
            "push" | "commit" if program == "svn" && sub == "commit" => sure(Publish),
            "push" => sure(Publish),
            "status" | "st" | "log" | "diff" | "show" | "info" | "cat" | "ls" | "blame"
            | "annotate" | "root" => sure(Read),
            _ => sure(WriteLocal),
        },
        "cargo" => match sub {
            "publish" | "yank" | "owner" => sure(Publish),
            "login" | "logout" => sure(ChangeAccess),
            "install" | "uninstall" => sure(Network),
            "search" | "tree" | "metadata" | "pkgid" | "locate-project" | "verify-project"
            | "version" | "info" | "--version" | "-V" | "--list" => sure(Read),
            _ => sure(WriteLocal),
        },
        "rustup" => match sub {
            "show" | "which" | "--version" | "-V" => sure(Read),
            "component" | "target" | "toolchain" if sub2 == "list" => sure(Read),
            _ => sure(Network),
        },
        "npm" | "pnpm" | "yarn" | "bun" | "npx" | "pnpx" | "bunx" => {
            if global {
                return sure(Network);
            }
            match sub {
                "publish" | "unpublish" | "deprecate" | "dist-tag" => sure(Publish),
                "login" | "logout" | "adduser" | "token" | "owner" | "access" | "team" => {
                    sure(ChangeAccess)
                }
                "whoami" | "view" | "info" | "show" | "ls" | "list" | "outdated" | "audit"
                    if !has(&["fix"]) && sub2 != "fix" =>
                {
                    sure(Read)
                }
                "config" if matches!(sub2, "get" | "list" | "ls") => sure(Read),
                "config" | "link" | "unlink" => sure(Network),
                "why" | "explain" | "search" | "pm" | "root" | "bin" | "prefix" | "doctor" => {
                    sure(Read)
                }
                _ => sure(WriteLocal),
            }
        }
        "pip" | "pip3" | "uv" | "uvx" | "poetry" | "pipenv" | "conda" | "mamba" => {
            if global || has(&["--break-system-packages", "--prefix", "--target", "-t"]) {
                return sure(Network);
            }
            match sub {
                "publish" | "upload" => sure(Publish),
                "list" | "show" | "freeze" | "check" | "tree" | "info" | "search" | "env"
                    if sub2 != "remove" =>
                {
                    sure(Read)
                }
                "tool" if sub2 == "install" => sure(Network),
                "self" | "config" | "cache" if sub2 != "dir" && sub2 != "list" => sure(Network),
                _ => sure(WriteLocal),
            }
        }
        "gem" | "bundle" | "composer" => match sub {
            "push" | "yank" | "owner" | "publish" => sure(Publish),
            "list" | "info" | "show" | "outdated" | "search" | "env" => sure(Read),
            "install" if program == "gem" => sure(Network),
            _ => sure(WriteLocal),
        },
        "go" => match sub {
            "install" => sure(Network),
            "env" if !has(&["-w", "-u"]) => sure(Read),
            "env" => sure(Network),
            "version" | "list" | "doc" | "vet" => sure(Read),
            _ => sure(WriteLocal),
        },
        "docker" | "podman" => match sub {
            "push" => sure(Publish),
            "login" | "logout" => sure(ChangeAccess),
            "ps" | "images" | "logs" | "inspect" | "version" | "info" | "stats" | "top"
            | "history" | "search" | "port" | "diff" => sure(Read),
            "context" | "system" | "swarm" | "network" | "volume" | "secret" | "config"
            | "plugin" | "node" | "service" | "stack" => {
                if matches!(sub2, "ls" | "list" | "inspect" | "df" | "show") {
                    sure(Read)
                } else {
                    sure(Network)
                }
            }
            "compose" if matches!(sub2, "ps" | "logs" | "config" | "ls" | "images" | "top") => {
                sure(Read)
            }
            "compose" if sub2 == "push" => sure(Publish),
            _ => sure(WriteLocal),
        },
        "dotnet" => match sub {
            "nuget" if sub2 == "push" => sure(Publish),
            "tool" if sub2 == "install" && global => sure(Network),
            "--info" | "--list-sdks" | "--version" | "list" => sure(Read),
            _ => sure(WriteLocal),
        },
        "flutter" | "dart" => match sub {
            "pub" if sub2 == "publish" => sure(Publish),
            "doctor" | "devices" | "--version" => sure(Read),
            _ => sure(WriteLocal),
        },
        "sqlite3" | "duckdb" => {
            let sql = args.join(" ").to_ascii_lowercase();
            let writes = [
                "insert", "update", "delete", "drop", "create", "alter", "vacuum", ".backup",
                "attach", "replace", ".import", ".restore", ".save", ".output", ".once", "pragma",
                ".shell", ".system",
            ];
            if sql.contains(".shell") || sql.contains(".system") {
                Label::Unsure
            } else if writes.iter().any(|w| sql.contains(w)) {
                sure(WriteLocal)
            } else {
                sure(Read)
            }
        }
        "make" | "gmake" | "just" | "task" => sure(WriteLocal),
        _ => sure(WriteLocal),
    }
}

fn git(sub: &str, sub2: &str, args: &[&str], has: &dyn Fn(&[&str]) -> bool) -> Label {
    let sure = Label::Sure;
    match sub {
        "push" => sure(Publish),
        "send-email" | "request-pull" | "imap-send" => sure(SendAsPerson),
        "credential" | "credential-store" | "credential-cache" => sure(Credential),
        "config" => {
            if has(&["--global", "--system"]) {
                sure(Network)
            } else if has(&[
                "--get",
                "--list",
                "-l",
                "--get-all",
                "--get-regexp",
                "--show-origin",
            ]) || args.iter().filter(|a| !a.starts_with('-')).count() <= 2
            {
                sure(Read)
            } else {
                sure(WriteLocal)
            }
        }
        "status" | "log" | "diff" | "show" | "blame" | "rev-parse" | "ls-files" | "ls-tree"
        | "describe" | "reflog" | "grep" | "shortlog" | "cat-file" | "rev-list" | "merge-base"
        | "name-rev" | "for-each-ref" | "show-ref" | "whatchanged" | "count-objects"
        | "check-ignore" | "check-attr" | "var" | "version" | "help" | "show-branch"
        | "range-diff" | "cherry" | "ls-remote" | "annotate" | "difftool" | "verify-commit"
        | "verify-tag" | "fsck" | "--version" => sure(Read),
        "branch" => {
            if has(&[
                "-d",
                "-D",
                "--delete",
                "-m",
                "-M",
                "--move",
                "-c",
                "-C",
                "-u",
                "--set-upstream-to",
                "-f",
                "--force",
            ]) || args.iter().filter(|a| !a.starts_with('-')).count() > 1
            {
                sure(WriteLocal)
            } else {
                sure(Read)
            }
        }
        "tag" => {
            if has(&["-l", "--list", "-n", "--contains", "--points-at", "-v"]) || args.len() <= 1 {
                sure(Read)
            } else {
                sure(WriteLocal)
            }
        }
        "stash" if matches!(sub2, "list" | "show") => sure(Read),
        "remote" if matches!(sub2, "" | "-v" | "show" | "get-url") => sure(Read),
        "worktree" if sub2 == "list" => sure(Read),
        "submodule" if matches!(sub2, "" | "status" | "summary" | "foreach") => {
            if sub2 == "foreach" {
                Label::Unsure
            } else {
                sure(Read)
            }
        }
        _ => sure(WriteLocal),
    }
}

fn forge(sub: &str, sub2: &str, args: &[&str], has: &dyn Fn(&[&str]) -> bool) -> Label {
    let sure = Label::Sure;
    let reads = matches!(
        sub2,
        "view" | "list" | "diff" | "checks" | "status" | "ls" | "download" | "watch"
    );
    match sub {
        "auth" => match sub2 {
            "status" => sure(Read),
            "token" => sure(Credential),
            _ => sure(ChangeAccess),
        },
        "secret" | "ssh-key" | "gpg-key" | "variable" => {
            if sub2 == "list" {
                sure(Read)
            } else {
                sure(ChangeAccess)
            }
        }
        "api" => {
            let writes = has(&[
                "-X",
                "--method",
                "-f",
                "-F",
                "--field",
                "--raw-field",
                "--input",
            ]) && !args.contains(&"GET");
            if writes {
                // A call with fields: it changes something, maybe in the person's name.
                Label::Unsure
            } else {
                sure(Read)
            }
        }
        "pr" | "mr" | "issue" | "release" | "run" | "workflow" | "repo" | "gist" | "label"
        | "project" | "cache" | "ruleset" | "codespace" | "search" | "browse" | "status"
        | "org" => {
            if reads || matches!(sub, "search" | "status" | "browse") {
                return sure(Read);
            }
            match (sub, sub2) {
                ("pr" | "mr", "checkout") | ("repo", "clone") | ("repo", "fork")
                    if sub2 != "fork" =>
                {
                    sure(WriteLocal)
                }
                ("pr" | "mr" | "issue", "comment")
                | ("pr" | "mr", "review")
                | ("issue", "create") => sure(SendAsPerson),
                ("repo", "edit" | "delete" | "rename" | "archive") | ("org", _) => {
                    sure(ChangeAccess)
                }
                ("run" | "workflow", "rerun" | "run" | "cancel" | "enable" | "disable") => {
                    sure(Network)
                }
                _ => sure(Publish),
            }
        }
        _ => Label::Unsure,
    }
}

fn ops(program: &str, sub: &str, sub2: &str, has: &dyn Fn(&[&str]) -> bool) -> Label {
    let sure = Label::Sure;
    match program {
        "ping" | "traceroute" | "dig" | "nslookup" | "host" | "whois" | "mtr" => sure(Read),
        "kubectl" | "helm" => match sub {
            "get" | "describe" | "logs" | "top" | "explain" | "version" | "api-resources"
            | "cluster-info" | "list" | "status" | "history" | "show" | "search" | "template"
            | "lint" | "diff" => sure(Read),
            "config" if matches!(sub2, "view" | "get-contexts" | "current-context") => sure(Read),
            "create" if sub2 == "secret" => sure(ChangeAccess),
            "auth" => sure(Read),
            _ => sure(Network),
        },
        "terraform" | "tofu" | "pulumi" => match sub {
            "plan" | "show" | "validate" | "fmt" | "output" | "graph" | "providers" | "version"
            | "preview" | "state"
                if sub2 != "rm" && sub2 != "mv" =>
            {
                sure(Read)
            }
            "init" => sure(WriteLocal),
            _ => sure(Publish),
        },
        "aws" | "gcloud" | "az" | "doctl" => {
            if has(&["--dry-run"]) {
                return sure(Read);
            }
            let verb = sub2;
            if ["list", "describe", "get", "ls", "show", "wait"]
                .iter()
                .any(|v| verb.starts_with(v))
                || matches!(sub, "sts" | "configure" if sub2 == "list" || sub2 == "get-caller-identity")
            {
                sure(Read)
            } else if matches!(sub, "iam" | "secretsmanager" | "kms" | "auth" | "login") {
                sure(ChangeAccess)
            } else if matches!(sub, "ses" | "sns" | "sesv2") {
                sure(SendAsPerson)
            } else {
                sure(Network)
            }
        }
        "vercel" | "netlify" | "wrangler" | "firebase" | "fly" | "flyctl" | "heroku"
        | "railway" | "render" | "supabase" => match sub {
            "ls" | "list" | "logs" | "status" | "whoami" | "info" | "inspect" | "env"
                if sub2 != "add" && sub2 != "rm" && sub2 != "set" =>
            {
                sure(Read)
            }
            "dev" | "init" | "link" | "pull" | "build" => sure(WriteLocal),
            "login" | "logout" | "secrets" | "secret" => sure(ChangeAccess),
            _ => sure(Publish),
        },
        "gsutil" | "rclone" | "s3cmd" => match sub {
            "ls" | "cat" | "du" | "lsd" | "lsl" | "size" | "about" | "check" | "listremotes"
            | "info" => sure(Read),
            _ => sure(Network),
        },
        _ => sure(Network),
    }
}

fn system(program: &str, sub: &str, args: &[&str]) -> Label {
    let sure = Label::Sure;
    match program {
        "systemctl" | "service" | "launchctl" => match sub {
            "status" | "list" | "list-units" | "list-unit-files" | "is-active" | "is-enabled"
            | "show" | "cat" | "print" | "list-timers" | "is-failed" => sure(Read),
            _ => sure(Network),
        },
        "apt" | "apt-get" | "dpkg" | "yum" | "dnf" | "brew" | "port" | "snap" | "flatpak" => {
            match sub {
                "list" | "search" | "show" | "info" | "policy" | "-l" | "-L" | "-s" | "leaves"
                | "deps" | "outdated" | "doctor" | "config" | "--prefix" | "home" => sure(Read),
                _ => sure(Network),
            }
        }
        "pacman" | "yay" | "paru" => {
            let q = args.first().is_some_and(|a| {
                a.starts_with("-Q") || a.starts_with("-Ss") || a.starts_with("-Si")
            });
            if q { sure(Read) } else { sure(Network) }
        }
        "hyprctl" => match sub {
            "clients" | "monitors" | "workspaces" | "activewindow" | "activeworkspace"
            | "devices" | "layers" | "version" | "getoption" | "binds" | "systeminfo"
            | "splash" | "cursorpos" | "instances" | "globalshortcuts" | "-j" => sure(Read),
            "dispatch" => sure(Drive),
            _ => sure(Network),
        },
        "defaults" if matches!(sub, "read" | "domains" | "find" | "read-type") => sure(Read),
        "crontab" if args.contains(&"-l") => sure(Read),
        "gsettings" | "dconf"
            if matches!(
                sub,
                "get"
                    | "list-keys"
                    | "list-schemas"
                    | "read"
                    | "list"
                    | "dump"
                    | "list-recursively"
            ) =>
        {
            sure(Read)
        }
        "nmcli"
            if matches!(sub, "device" | "connection" | "general" | "d" | "c" | "g")
                && args
                    .get(1)
                    .is_none_or(|a| matches!(*a, "status" | "show" | "list")) =>
        {
            sure(Read)
        }
        "pmset" | "scutil" | "diskutil" | "sysctl"
            if matches!(sub, "-g" | "--get" | "list" | "info" | "-a" | "-n") =>
        {
            sure(Read)
        }
        "omarchy" => Label::Unsure,
        "nohup" | "disown" | "setsid" => Label::Unsure,
        _ => sure(Network),
    }
}
