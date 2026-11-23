// SPDX-License-Identifier: Apache-2.0
//! Spawning through `cmd.exe` on Windows: batch entrypoints cannot spawn
//! directly, so they ride a quoted `cmd.exe /d /s /c` line. Ports the
//! command half of `process-owner.ts`. Ownership bookkeeping (the owned
//! map, journals, listeners, guards, shutdown handlers) stays on the shell
//! boundary; everything here is pure and shared by both backends.

/// A Windows command: the program, its arguments, and whether the spawn
/// must pass them verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsCommand {
    pub command: String,
    pub args: Vec<String>,
    pub verbatim: bool,
}

/// Quote for the target argv parser: always wrap, escape `"` and edge backslashes.
fn msvcrt_quote(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            quoted.push(ch);
        }
        backslashes = 0;
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Hides one cmd.exe parse behind `^`; a second pass survives the shim's `%*` reparse.
fn caret_escape(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if "()%!^\"<>&|".contains(ch) {
            out.push('^');
        }
        out.push(ch);
    }
    out
}

/// The program path rides in plain quotes; a quote or % in the path is refused.
fn escape_command(value: &str) -> Result<String, String> {
    if value.contains('"') || value.contains('%') {
        return Err("Windows batch command path cannot contain a quote or %".to_owned());
    }
    Ok(format!("\"{value}\""))
}

fn escape_argument(value: &str) -> String {
    caret_escape(&caret_escape(&msvcrt_quote(value)))
}

/// One program inside a `cmd.exe /c` line the caller already owns.
pub fn windows_cmd_line(command: &str, args: &[&str]) -> Result<String, String> {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = base.to_ascii_lowercase();
    let batch = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let mut parts = vec![escape_command(command)?];
    for arg in args {
        parts.push(if batch {
            escape_argument(arg)
        } else {
            caret_escape(&msvcrt_quote(arg))
        });
    }
    Ok(parts.join(" "))
}

/// Wraps a batch entrypoint as `cmd.exe /d /s /c "..."`; other commands pass through.
pub fn to_windows_command(command: &str, args: &[&str]) -> Result<WindowsCommand, String> {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = base.to_ascii_lowercase();
    if !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
        return Ok(WindowsCommand {
            command: command.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            verbatim: false,
        });
    }
    let line = windows_cmd_line(command, args)?;
    Ok(WindowsCommand {
        command: "cmd.exe".to_owned(),
        args: vec![
            "/d".to_owned(),
            "/s".to_owned(),
            "/c".to_owned(),
            format!("\"{line}\""),
        ],
        verbatim: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(command: &str, args: &[&str]) -> WindowsCommand {
        to_windows_command(command, args).expect("command maps")
    }

    #[test]
    fn non_batch_commands_pass_through_without_verbatim_spawning() {
        assert_eq!(
            command("C:\\tools\\agent.exe", &["--stdio"]),
            WindowsCommand {
                command: "C:\\tools\\agent.exe".to_owned(),
                args: vec!["--stdio".to_owned()],
                verbatim: false,
            }
        );
        assert_eq!(
            command("C:\\dir.cmd\\tool.exe", &[]),
            WindowsCommand {
                command: "C:\\dir.cmd\\tool.exe".to_owned(),
                args: Vec::new(),
                verbatim: false,
            }
        );
        assert_eq!(
            command("tool.cmdx", &["a&b"]),
            WindowsCommand {
                command: "tool.cmdx".to_owned(),
                args: vec!["a&b".to_owned()],
                verbatim: false,
            }
        );
    }

    #[test]
    fn batch_entrypoints_spawn_verbatim_through_cmd() {
        assert_eq!(
            command("cursor-agent.cmd", &[]),
            WindowsCommand {
                command: "cmd.exe".to_owned(),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    "\"\"cursor-agent.cmd\"\"".to_owned()
                ],
                verbatim: true,
            }
        );
        assert_eq!(
            command("C:\\tools\\run.BAT", &[]),
            WindowsCommand {
                command: "cmd.exe".to_owned(),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    "\"\"C:\\tools\\run.BAT\"\"".to_owned()
                ],
                verbatim: true,
            }
        );
    }

    #[test]
    fn path_with_spaces_rides_in_plain_quotes_while_its_flag_is_escaped_twice() {
        assert_eq!(
            command("C:\\Program Files\\agent\\run.cmd", &["--stdio"]),
            WindowsCommand {
                command: "cmd.exe".to_owned(),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    "\"\"C:\\Program Files\\agent\\run.cmd\" ^^^\"--stdio^^^\"\"".to_owned(),
                ],
                verbatim: true,
            }
        );
    }

    #[test]
    fn percent_signs_survive_both_cmd_parses_without_expanding() {
        assert_eq!(
            command("tool.cmd", &["%PATH%", "100%"]),
            WindowsCommand {
                command: "cmd.exe".to_owned(),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    "\"\"tool.cmd\" ^^^\"^^^%PATH^^^%^^^\" ^^^\"100^^^%^^^\"\"".to_owned(),
                ],
                verbatim: true,
            }
        );
    }

    #[test]
    fn ampersand_stays_inside_its_doubly_escaped_quotes() {
        assert_eq!(
            command("tool.cmd", &["a&b"]).args[3],
            "\"\"tool.cmd\" ^^^\"a^^^&b^^^\"\"".to_owned()
        );
    }

    #[test]
    fn embedded_quote_cannot_flip_cmd_out_of_its_quoted_span() {
        assert_eq!(
            command("tool.cmd", &["say \"hi\" & echo pwned"]).args[3],
            "\"\"tool.cmd\" ^^^\"say \\^^^\"hi\\^^^\" ^^^& echo pwned^^^\"\"".to_owned()
        );
    }

    #[test]
    fn trailing_backslash_is_doubled_before_the_closing_quote() {
        assert_eq!(
            command("tool.cmd", &["C:\\my dir\\"]).args[3],
            "\"\"tool.cmd\" ^^^\"C:\\my dir\\\\^^^\"\"".to_owned()
        );
    }

    #[test]
    fn empty_argument_still_arrives_as_one_argument() {
        assert_eq!(
            command("tool.cmd", &[""]).args[3],
            "\"\"tool.cmd\" ^^^\"^^^\"\"".to_owned()
        );
    }

    #[test]
    fn quoted_percent_in_path_is_refused_instead_of_misquoted() {
        assert!(to_windows_command("tool\".cmd", &[]).is_err());
        assert!(to_windows_command("a%b.cmd", &[]).is_err());
    }
}
