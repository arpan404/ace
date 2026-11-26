//! A skill or command the person starts from the composer's `/` menu (docs/plugins.md, "Skills
//! and commands"). Pure: the engine reads the store and the plugin's folder and passes them in.
//!
//! A command's file is a template: `$ARGUMENTS` is what the person wrote after the command and
//! `${PLUGIN_ROOT}` the folder of the accepted plugin version. A command that never names
//! `$ARGUMENTS` still gets the arguments, on a line after it. A skill is the skill's own text,
//! with the arguments on a line after it.

/// The kinds of thing the menu starts.
pub const SKILL: &str = "skill";
pub const COMMAND: &str = "command";

/// The longest arguments a command or skill is given, in characters.
pub const LONGEST_ARGS: usize = 8_000;

/// What the model reads for the skill or command: `body` is its text below the frontmatter,
/// `args` what the person wrote after it, `plugin_root` the plugin's folder (a command of a
/// plugin).
pub fn render(kind: &str, body: &str, args: Option<&str>, plugin_root: Option<&str>) -> String {
    let args = args.map(str::trim).filter(|a| !a.is_empty());
    let mut text = body.trim_end().to_owned();
    if let Some(root) = plugin_root {
        text = text.replace("${PLUGIN_ROOT}", root);
    }
    if kind != COMMAND {
        return with_args_line(text, args);
    }
    if text.contains("$ARGUMENTS") {
        text.replace("$ARGUMENTS", args.unwrap_or(""))
    } else {
        with_args_line(text, args)
    }
}

fn with_args_line(mut text: String, args: Option<&str>) -> String {
    if let Some(args) = args {
        text.push_str("\n\nARGUMENTS: ");
        text.push_str(args);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_gets_its_arguments_and_plugin_folder_put_in() {
        let text = render(
            COMMAND,
            "Run ${PLUGIN_ROOT}/lint.sh on $ARGUMENTS, then $ARGUMENTS again.",
            Some("  src/ "),
            Some("/plugins/style"),
        );
        assert_eq!(text, "Run /plugins/style/lint.sh on src/, then src/ again.");
    }

    #[test]
    fn a_command_without_the_placeholder_still_gets_the_arguments() {
        let text = render(
            COMMAND,
            "Summarise the diff.\n",
            Some("last 3 commits"),
            None,
        );
        assert_eq!(text, "Summarise the diff.\n\nARGUMENTS: last 3 commits");
    }

    #[test]
    fn a_command_with_no_arguments_leaves_nothing_behind() {
        assert_eq!(render(COMMAND, "Do $ARGUMENTS now", None, None), "Do  now");
        assert_eq!(render(COMMAND, "Do it", Some("   "), None), "Do it");
    }

    #[test]
    fn a_skill_keeps_its_text_and_takes_the_arguments_after_it() {
        let text = render(SKILL, "Check $ARGUMENTS here.", Some("the renderer"), None);
        assert_eq!(text, "Check $ARGUMENTS here.\n\nARGUMENTS: the renderer");
    }
}
