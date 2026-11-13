//! The note a bot reads when the person hands its computer back (ADR 0142): what the person did,
//! in Spade's words. Never their keystrokes: the lines they entered at the shell's prompt, the
//! files that changed and the surfaces they used.

/// Most changed files the note names.
pub const MOST_FILES: usize = 30;
/// Longest file name the note shows.
const NAME_CHARS: usize = 120;

/// What the person did while they drove.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Driven<'a> {
    /// Lines entered at the terminal's prompt, oldest first.
    pub commands: &'a [String],
    /// Lines entered past those kept.
    pub more_commands: usize,
    /// Each changed path and how (`new`, `changed`, `removed`).
    pub files: &'a [(String, &'static str)],
    /// Surfaces ace said they used (`browser`, `screen`).
    pub used: &'a [String],
}

pub fn note(driven: &Driven<'_>) -> String {
    let mut lines = vec![
        "The person took over your computer and has handed it back to you. What they did while \
         they had it was theirs, not yours:"
            .to_owned(),
    ];
    if driven.commands.is_empty() {
        lines.push("- They entered no commands in your terminal.".to_owned());
    } else {
        let shown: Vec<String> = driven
            .commands
            .iter()
            .map(|command| format!("`{}`", command.replace('`', "'")))
            .collect();
        let mut line = format!(
            "- In your terminal they entered (as typed): {}",
            shown.join("; ")
        );
        if driven.more_commands > 0 {
            line.push_str(&format!(" … and {} more", driven.more_commands));
        }
        line.push('.');
        lines.push(line);
    }
    if driven.files.is_empty() {
        lines.push("- No files in your workspace changed.".to_owned());
    } else {
        let shown: Vec<String> = driven
            .files
            .iter()
            .take(MOST_FILES)
            .map(|(path, how)| format!("`{}` ({how})", name(path)))
            .collect();
        let mut line = format!(
            "- Files in your workspace that changed: {}",
            shown.join(", ")
        );
        if driven.files.len() > MOST_FILES {
            line.push_str(&format!(" … and {} more", driven.files.len() - MOST_FILES));
        }
        line.push('.');
        lines.push(line);
    }
    for surface in driven.used {
        let what = match surface.as_str() {
            "browser" => "your browser",
            "screen" => "your screen",
            _ => continue,
        };
        lines.push(format!("- They used {what}."));
    }
    lines.push(
        "Your terminal, browser and files may not be as you left them. If you were in the middle \
         of something, check where things stand before you carry on."
            .to_owned(),
    );
    lines.join("\n")
}

/// A path as the note shows it: one line, no backticks, cut short.
fn name(path: &str) -> String {
    let flat: String = path
        .chars()
        .map(|c| if c.is_control() || c == '`' { '_' } else { c })
        .collect();
    if flat.chars().count() > NAME_CHARS {
        let cut: String = flat.chars().take(NAME_CHARS).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_note_names_what_the_person_ran_changed_and_used() {
        let commands = vec!["git pull".to_owned(), "npm test".to_owned()];
        let files = vec![
            ("src/a.ts".to_owned(), "changed"),
            ("bad`\nname".to_owned(), "new"),
        ];
        let used = vec!["browser".to_owned()];
        let text = note(&Driven {
            commands: &commands,
            more_commands: 3,
            files: &files,
            used: &used,
        });
        assert!(text.contains("they entered (as typed): `git pull`; `npm test` … and 3 more."));
        assert!(text.contains("`src/a.ts` (changed), `bad__name` (new)"));
        assert!(text.contains("They used your browser."));
        assert!(!text.contains("your screen"));
    }

    #[test]
    fn a_handback_with_nothing_done_says_so() {
        let text = note(&Driven::default());
        assert!(text.contains("They entered no commands"));
        assert!(text.contains("No files in your workspace changed."));
    }
}
