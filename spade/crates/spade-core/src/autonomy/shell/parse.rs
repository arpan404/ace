//! Reading a shell command into simple commands: words, redirects, pipes, `$(...)`, `sh -c`
//! strings, and the wrappers that run another command (`env`, `xargs`, `find -exec`, `sudo`…),
//! each unwrapped to what it runs. Anything it can't read for sure is [`Unreadable`].

use super::super::secrets::basename;

/// One simple command: its words (wrappers taken off) and where its output is written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Simple {
    pub words: Vec<String>,
    pub writes_to: Vec<String>,
    /// Files its input comes from (`< file`).
    pub reads_from: Vec<String>,
    /// Its input is the previous command's output.
    pub piped: bool,
    /// How many subshells `( … )` deep it is: a `cd` inside one ends with it.
    pub group: usize,
    /// The folder it starts in, when a wrapper changed it (`env -C dir`).
    pub dir: Option<String>,
}

impl Simple {
    /// A command this one runs, in the same subshell and folder.
    fn child(&self, words: Vec<String>) -> Self {
        Self {
            words,
            group: self.group,
            dir: self.dir.clone(),
            ..Self::default()
        }
    }
}

/// Commands read from a string `parent` runs (`sh -c`, `su -c`, `watch`, `env -S`): in its
/// subshell and folder.
fn adopt(inner: Vec<Simple>, parent: &Simple) -> Vec<Simple> {
    inner
        .into_iter()
        .map(|mut command| {
            command.group += parent.group;
            if command.dir.is_none() {
                command.dir = parent.dir.clone();
            }
            command
        })
        .collect()
}

/// Deepest nesting of `sh -c` and `$(...)` read before giving up.
pub(super) const DEEPEST: usize = 4;

pub(super) struct Unreadable;

pub(super) fn parse(text: &str, depth: usize) -> Result<Vec<Simple>, Unreadable> {
    if depth > DEEPEST {
        return Err(Unreadable);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Simple> = Vec::new();
    let mut nested: Vec<Simple> = Vec::new();
    let mut current = Simple::default();
    let mut group = 0usize;
    let mut word = String::new();
    let mut in_word = false;
    let mut target = false;
    let mut input = false;
    let mut i = 0;
    let end_word = |word: &mut String,
                    in_word: &mut bool,
                    target: &mut bool,
                    input: &mut bool,
                    current: &mut Simple| {
        if !*in_word {
            return;
        }
        let taken = std::mem::take(word);
        if *target {
            current.writes_to.push(taken);
            *target = false;
        } else if *input {
            current.reads_from.push(taken);
            *input = false;
        } else {
            current.words.push(taken);
        }
        *in_word = false;
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => end_word(
                &mut word,
                &mut in_word,
                &mut target,
                &mut input,
                &mut current,
            ),
            '\n' | ';' | '&' | '|' | '(' | ')' => {
                if c == '&' && chars.get(i + 1) == Some(&'>') {
                    // `&>file`: both streams to a file.
                    end_word(
                        &mut word,
                        &mut in_word,
                        &mut target,
                        &mut input,
                        &mut current,
                    );
                    i += 1;
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    target = true;
                    i += 1;
                    continue;
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                if target {
                    return Err(Unreadable);
                }
                let piped = c == '|' && chars.get(i + 1) != Some(&'|');
                if matches!(c, '&' | '|') && chars.get(i + 1) == Some(&c) {
                    i += 1;
                }
                out.push(std::mem::take(&mut current));
                match c {
                    '(' => group += 1,
                    ')' => group = group.saturating_sub(1),
                    _ => {}
                }
                current.piped = piped;
                current.group = group;
            }
            '\'' => {
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(Unreadable),
                        Some('\'') => break,
                        Some(&ch) => word.push(ch),
                    }
                    i += 1;
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None | Some('`') => return Err(Unreadable),
                        Some('"') => break,
                        Some('\\') => {
                            i += 1;
                            word.push(*chars.get(i).ok_or(Unreadable)?);
                        }
                        Some('$') if chars.get(i + 1) == Some(&'(') => {
                            let (inner, next) = substitution(&chars, i)?;
                            nested.extend(parse(&inner, depth + 1)?);
                            word.push_str("$SUB");
                            i = next;
                            continue;
                        }
                        Some(&ch) => word.push(ch),
                    }
                    i += 1;
                }
            }
            '`' => return Err(Unreadable),
            '\\' => {
                in_word = true;
                i += 1;
                if let Some(&ch) = chars.get(i)
                    && ch != '\n'
                {
                    word.push(ch);
                }
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                let (inner, next) = substitution(&chars, i)?;
                nested.extend(parse(&inner, depth + 1)?);
                in_word = true;
                word.push_str("$SUB");
                i = next;
                continue;
            }
            '<' => {
                // A here-document or here-string carries text Spade doesn't read as a command.
                if matches!(chars.get(i + 1), Some('<') | Some('(')) {
                    return Err(Unreadable);
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                input = true;
            }
            '>' => {
                // `2>file`, `1>>file`: the number is the stream, not a word.
                if in_word && word.chars().all(|d| d.is_ascii_digit()) {
                    word.clear();
                    in_word = false;
                }
                end_word(
                    &mut word,
                    &mut in_word,
                    &mut target,
                    &mut input,
                    &mut current,
                );
                if chars.get(i + 1) == Some(&'(') {
                    return Err(Unreadable);
                }
                if chars.get(i + 1) == Some(&'>') || chars.get(i + 1) == Some(&'|') {
                    i += 1;
                }
                if chars.get(i + 1) == Some(&'&') {
                    // `>&2`: to another stream.
                    i += 2;
                    while chars
                        .get(i)
                        .is_some_and(|d| d.is_ascii_digit() || *d == '-')
                    {
                        i += 1;
                    }
                    continue;
                }
                target = true;
            }
            '#' if !in_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            _ => {
                in_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_word(
        &mut word,
        &mut in_word,
        &mut target,
        &mut input,
        &mut current,
    );
    if target {
        return Err(Unreadable);
    }
    out.push(current);
    let mut simple: Vec<Simple> = Vec::new();
    for command in out
        .into_iter()
        .filter(|c| !c.words.is_empty() || !c.writes_to.is_empty())
    {
        simple.extend(unwrap(command, depth)?);
    }
    simple.extend(nested);
    Ok(simple)
}

/// The text inside `$(...)` starting at `start` (the `$`), and the index after its `)`.
fn substitution(chars: &[char], start: usize) -> Result<(String, usize), Unreadable> {
    if chars.get(start + 2) == Some(&'(') {
        // `$((...))` is arithmetic; nothing runs, but it isn't worth reading.
        return Err(Unreadable);
    }
    let mut depth = 0;
    let mut quote: Option<char> = None;
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => {
                depth -= 1;
                if depth == 0 {
                    let inner: String = chars[start + 2..i].iter().collect();
                    return Ok((inner, i + 1));
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(Unreadable)
}

/// Programs that run the command after them, with their flags that take a value.
const WRAPPERS: &[(&str, &[&str])] = &[
    ("env", &["-u", "-C", "--unset", "--chdir"]),
    ("command", &[]),
    ("builtin", &[]),
    ("exec", &["-a"]),
    ("nohup", &[]),
    ("time", &["-f", "-o", "--format", "--output"]),
    ("nice", &["-n", "--adjustment"]),
    ("ionice", &["-c", "-n", "-p", "--class", "--classdata"]),
    ("stdbuf", &["-i", "-o", "-e"]),
    ("timeout", &["-s", "-k", "--signal", "--kill-after"]),
    ("caffeinate", &["-t", "-w"]),
    (
        "xargs",
        &[
            "-I",
            "-n",
            "-P",
            "-L",
            "-d",
            "-E",
            "-s",
            "-a",
            "--max-args",
            "--max-procs",
            "--delimiter",
            "--arg-file",
        ],
    ),
    ("setsid", &[]),
    ("unbuffer", &[]),
    ("chronic", &[]),
    ("torsocks", &[]),
    ("proxychains", &["-f"]),
    ("proxychains4", &["-f"]),
    ("strace", &["-o", "-e", "-p", "-s", "-u"]),
    ("ltrace", &["-o", "-e", "-p", "-s", "-u"]),
    ("chrt", &[]),
    ("taskset", &[]),
    ("doppler", &[]),
];

/// Programs that run the command after them with other rights: kept, so the effect check sees
/// them, and unwrapped, so what they run is checked too. With their flags that take a value.
const ELEVATE: &[(&str, &[&str])] = &[
    (
        "sudo",
        &[
            "-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group",
        ],
    ),
    ("doas", &["-u", "-C"]),
    ("pkexec", &["--user"]),
    ("runuser", &["-u", "-g", "-G", "--user", "--group"]),
    ("su", &["-s", "-g", "-G", "--shell", "--group"]),
    ("runas", &["/user"]),
];

pub(super) const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"];
const INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "ash",
    "mksh",
    "python",
    "python3",
    "node",
    "deno",
    "bun",
    "perl",
    "ruby",
    "php",
    "lua",
    "osascript",
    "awk",
    "gawk",
    "mawk",
    "nawk",
];

/// Takes off `flags` (and the value of each in `valued`) from the front of `words`, up to the
/// first word that isn't one, and a `--` that ends them.
fn strip_flags(words: &mut Vec<String>, valued: &[&str]) {
    while let Some(word) = words.first() {
        if word == "--" {
            words.remove(0);
            return;
        }
        if !word.starts_with('-') && !is_assignment(word) {
            return;
        }
        let takes = valued.contains(&word.as_str());
        words.remove(0);
        if takes && !words.is_empty() {
            words.remove(0);
        }
    }
}

/// The value given to `flag` (`-c x`, `-cx`, `--flag=x`), if any.
fn value_of(words: &[String], flag: &str) -> Option<String> {
    words.iter().enumerate().find_map(|(at, w)| {
        if w == flag {
            words.get(at + 1).cloned()
        } else if flag.starts_with("--") {
            w.strip_prefix(&format!("{flag}=")).map(str::to_owned)
        } else {
            None
        }
    })
}

/// Takes off variable assignments and wrappers, reads `sh -c` strings, and unwraps what
/// `find -exec`, `sudo`, `watch`, `parallel` and `env -S` run: every command that would run,
/// each through this same reading.
fn unwrap(mut simple: Simple, depth: usize) -> Result<Vec<Simple>, Unreadable> {
    if depth > DEEPEST {
        return Err(Unreadable);
    }
    let mut out: Vec<Simple> = Vec::new();
    loop {
        let Some(first) = simple.words.first().cloned() else {
            if !simple.writes_to.is_empty() {
                out.push(simple);
            }
            return Ok(out);
        };
        if is_assignment(&first) {
            simple.words.remove(0);
            continue;
        }
        let program = basename(&first).to_owned();
        if program.starts_with('$') || program == "eval" {
            return Err(Unreadable);
        }
        if let Some((_, valued)) = ELEVATE.iter().find(|(name, _)| *name == program) {
            // The wrapper itself, for the effect check (admin rights).
            out.push(simple.child(vec![first.clone()]));
            simple.words.remove(0);
            if program == "su" {
                // `su [user] -c 'cmd'`: the string is what runs; without one, a shell reads
                // what comes next, which Spade can't see.
                let Some(script) =
                    value_of(&simple.words, "-c").or_else(|| value_of(&simple.words, "--command"))
                else {
                    return Ok(out);
                };
                out.extend(adopt(parse(&script, depth + 1)?, &simple));
                return Ok(out);
            }
            strip_flags(&mut simple.words, valued);
            continue;
        }
        // `command -v x` only looks a name up.
        if program == "command" && simple.words.iter().any(|w| w == "-v" || w == "-V") {
            out.push(simple);
            return Ok(out);
        }
        // `env -S 'cmd args'` splits its string into the command.
        if program == "env"
            && let Some(script) =
                value_of(&simple.words, "-S").or_else(|| value_of(&simple.words, "--split-string"))
        {
            out.extend(adopt(parse(&script, depth + 1)?, &simple));
            return Ok(out);
        }
        if let Some((_, valued)) = WRAPPERS.iter().find(|(name, _)| *name == program) {
            if program == "env"
                && let Some(dir) =
                    value_of(&simple.words, "-C").or_else(|| value_of(&simple.words, "--chdir"))
            {
                simple.dir = Some(match simple.dir.take() {
                    Some(before) if !dir.starts_with('/') => format!("{before}/{dir}"),
                    _ => dir,
                });
            }
            // What xargs runs takes its words from its input: a shell or interpreter given
            // them runs text Spade never sees.
            let replace = (program == "xargs").then(|| {
                value_of(&simple.words, "-I")
                    .or_else(|| value_of(&simple.words, "--replace"))
                    .unwrap_or_else(|| "{}".to_owned())
            });
            simple.words.remove(0);
            strip_flags(&mut simple.words, valued);
            // `timeout 10 cmd`, `chrt 10 cmd`, `taskset 0x3 cmd`: the first plain value is the
            // wrapper's.
            if matches!(program.as_str(), "timeout" | "chrt" | "taskset") && simple.words.len() > 1
            {
                simple.words.remove(0);
            }
            if let Some(replace) = replace
                && let Some(next) = simple.words.first()
                && INTERPRETERS.contains(&basename(next))
            {
                let inline = simple.words[1..]
                    .iter()
                    .position(|w| matches!(w.as_str(), "-c" | "-e" | "-E" | "-r"))
                    .and_then(|at| simple.words.get(at + 2));
                match inline {
                    Some(code) if !code.contains(&replace) && !code.contains("{}") => {}
                    _ => return Err(Unreadable),
                }
            }
            if program == "doppler" {
                // `doppler run -- cmd`.
                if simple.words.first().is_some_and(|w| w == "run") {
                    simple.words.remove(0);
                    strip_flags(&mut simple.words, &[]);
                } else {
                    out.push(simple.child(vec![first]));
                    return Ok(out);
                }
            }
            continue;
        }
        if program == "flock" {
            // `flock [flags] file cmd…` or `flock [flags] file -c 'cmd'`.
            if let Some(script) = value_of(&simple.words, "-c") {
                out.extend(adopt(parse(&script, depth + 1)?, &simple));
                return Ok(out);
            }
            simple.words.remove(0);
            strip_flags(
                &mut simple.words,
                &["-w", "-E", "--timeout", "--conflict-exit-code"],
            );
            if !simple.words.is_empty() {
                simple.words.remove(0);
            }
            continue;
        }
        if program == "watch" {
            // `watch` hands its words to `sh -c`.
            simple.words.remove(0);
            strip_flags(
                &mut simple.words,
                &["-n", "-d", "--interval", "-q", "--equexit"],
            );
            out.extend(adopt(parse(&simple.words.join(" "), depth + 1)?, &simple));
            return Ok(out);
        }
        if program == "parallel" {
            // `parallel [flags] cmd ::: args`; with no command it runs lines from its input.
            let mut rest: Vec<String> = simple.words[1..].to_vec();
            strip_flags(
                &mut rest,
                &["-j", "-S", "--jobs", "--sshlogin", "-a", "--arg-file"],
            );
            let command: Vec<String> = rest
                .into_iter()
                .take_while(|w| !w.starts_with(":::"))
                .collect();
            if command.is_empty() {
                return Err(Unreadable);
            }
            let inner = simple.child(command);
            out.extend(unwrap(inner, depth + 1)?);
            return Ok(out);
        }
        if program == "find" {
            // `find` itself (for `-delete` and where it starts), then each `-exec` command.
            let words = simple.words.clone();
            let parent = simple.child(Vec::new());
            out.push(simple);
            let mut at = 0;
            while let Some(start) = words[at..]
                .iter()
                .position(|w| matches!(w.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))
            {
                let begin = at + start + 1;
                let inner: Vec<String> = words[begin..]
                    .iter()
                    .take_while(|w| !matches!(w.as_str(), ";" | "+" | "\\;"))
                    .cloned()
                    .collect();
                at = begin + inner.len();
                if inner.is_empty() {
                    break;
                }
                out.extend(unwrap(parent.child(inner), depth + 1)?);
            }
            return Ok(out);
        }
        if SHELLS.contains(&program.as_str()) {
            let script = simple
                .words
                .iter()
                .position(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c'))
                .and_then(|at| simple.words.get(at + 1).cloned());
            if let Some(script) = script {
                // `find -exec sh -c '{}'`: the command is a file's name, not text in the call.
                if script.contains("{}") {
                    return Err(Unreadable);
                }
                let mut inner = adopt(parse(&script, depth + 1)?, &simple);
                if let Some(first) = inner.first_mut() {
                    first.piped |= simple.piped;
                }
                out.extend(inner);
                return Ok(out);
            }
        }
        // A shell or interpreter reading its program from a pipe runs text Spade never sees.
        if simple.piped
            && INTERPRETERS.contains(&program.as_str())
            && simple.words[1..].iter().all(|w| w.starts_with('-'))
        {
            return Err(Unreadable);
        }
        out.push(simple);
        return Ok(out);
    }
}

pub(super) fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}
