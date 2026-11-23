//! What a search looks for and which files it looks in: plain text or a regular expression, and a
//! file pattern. Pure; the walk is in `files.rs`.
//!
//! Regular expressions use the `regex` crate, which runs in time linear in the text whatever the
//! pattern, so no pattern can hang a search. Its compiled size is capped as well.

/// The most a compiled pattern may take, in bytes (a pattern past it is refused).
const PATTERN_BYTES: usize = 1 << 20;
/// How deep a pattern's groups may nest.
const PATTERN_NESTING: u32 = 64;
/// The longest pattern accepted, in characters.
const PATTERN_CHARS: usize = 1_000;

/// What a search looks for in each line.
#[derive(Debug, Clone)]
pub enum Needle {
    /// Plain text; `wanted` is lower-cased when case is ignored.
    Text {
        wanted: String,
        ignore_case: bool,
    },
    Pattern(regex::Regex),
}

impl Needle {
    /// `text` as plain text, or as a regular expression when `regex`. Explains a pattern that
    /// doesn't compile or is too large.
    pub fn new(text: &str, regex: bool, ignore_case: bool) -> Result<Self, String> {
        if text.is_empty() {
            return Err("give the text to look for".to_owned());
        }
        if !regex {
            return Ok(Self::Text {
                wanted: if ignore_case {
                    text.to_lowercase()
                } else {
                    text.to_owned()
                },
                ignore_case,
            });
        }
        if text.chars().count() > PATTERN_CHARS {
            return Err(format!(
                "that pattern is longer than {PATTERN_CHARS} characters"
            ));
        }
        regex::RegexBuilder::new(text)
            .case_insensitive(ignore_case)
            .size_limit(PATTERN_BYTES)
            .dfa_size_limit(PATTERN_BYTES)
            .nest_limit(PATTERN_NESTING)
            .build()
            .map(Self::Pattern)
            .map_err(|error| match error {
                regex::Error::CompiledTooBig(_) => {
                    "that pattern is too large; make it simpler".to_owned()
                }
                other => format!("that is not a regular expression this search reads: {other}"),
            })
    }

    /// Whether `line` holds what is looked for.
    pub fn finds(&self, line: &str) -> bool {
        match self {
            Self::Text {
                wanted,
                ignore_case: true,
            } => line.to_lowercase().contains(wanted.as_str()),
            Self::Text { wanted, .. } => line.contains(wanted.as_str()),
            Self::Pattern(pattern) => pattern.is_match(line),
        }
    }
}

/// A file pattern: `*.csv` (a name, in any folder), `data/*.csv` or `src/**/*.rs` (a path from
/// the workspace's top). `*` and `?` stay within one name; `**` crosses folders.
#[derive(Debug, Clone)]
pub struct Glob {
    pattern: glob::Pattern,
    /// A pattern with a `/` is matched against the whole path, else against the name.
    whole_path: bool,
}

const OPTIONS: glob::MatchOptions = glob::MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

impl Glob {
    pub fn new(pattern: &str) -> Result<Self, String> {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return Err("give a file pattern, such as *.csv".to_owned());
        }
        glob::Pattern::new(pattern)
            .map(|compiled| Self {
                pattern: compiled,
                whole_path: pattern.contains('/'),
            })
            .map_err(|error| format!("that is not a file pattern: {error}"))
    }

    /// Whether the file at `path` (relative to the workspace, with `/`) fits.
    pub fn fits(&self, path: &str) -> bool {
        if self.whole_path {
            return self.pattern.matches_with(path, OPTIONS);
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        self.pattern.matches_with(name, OPTIONS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn needle(text: &str, regex: bool, ignore_case: bool) -> Needle {
        Needle::new(text, regex, ignore_case).unwrap_or_else(|e| panic!("{e}"))
    }

    fn glob(pattern: &str) -> Glob {
        Glob::new(pattern).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn plain_text_is_found_as_written_or_in_any_case() {
        assert!(needle("total", false, false).finds("the total is 4"));
        assert!(!needle("Total", false, false).finds("the total is 4"));
        assert!(needle("Total", false, true).finds("the TOTAL is 4"));
        // Plain text is never read as a pattern.
        assert!(!needle("a.c", false, false).finds("abc"));
        assert!(needle("a.c", false, false).finds("a.c"));
    }

    #[test]
    fn a_regular_expression_finds_lines_by_their_shape() {
        let dates = needle(r"^\d{4}-\d{2}-\d{2},", true, false);
        assert!(dates.finds("2026-11-23,apples,3"));
        assert!(!dates.finds("date,fruit,count"));
        assert!(needle("^error", true, true).finds("ERROR: disk full"));
    }

    #[test]
    fn a_pattern_that_is_broken_or_too_large_is_refused_in_words() {
        let broken = Needle::new("(unclosed", true, false)
            .err()
            .unwrap_or_default();
        assert!(broken.contains("not a regular expression"), "{broken}");
        let huge = Needle::new(r"\w{1000}\w{1000}\w{1000}", true, false)
            .err()
            .unwrap_or_default();
        assert!(huge.contains("too large"), "{huge}");
        let long = Needle::new(&"a".repeat(2_000), true, false)
            .err()
            .unwrap_or_default();
        assert!(long.contains("longer than"), "{long}");
        assert!(Needle::new("", false, false).is_err());
    }

    #[test]
    fn a_name_pattern_fits_files_in_any_folder_and_a_path_pattern_from_the_top() {
        let csv = glob("*.csv");
        assert!(csv.fits("sales.csv"));
        assert!(csv.fits("data/2026/sales.csv"));
        assert!(!csv.fits("sales.csv.bak"));

        let top = glob("data/*.csv");
        assert!(top.fits("data/sales.csv"));
        assert!(!top.fits("data/2026/sales.csv"));
        assert!(!top.fits("other/data/sales.csv"));

        let deep = glob("src/**/*.rs");
        assert!(deep.fits("src/main.rs"));
        assert!(deep.fits("src/a/b/lib.rs"));
        assert!(!deep.fits("tests/a.rs"));

        assert!(glob("./notes/*.md").fits("notes/plan.md"));
        assert!(glob("report-?.txt").fits("report-1.txt"));
        assert!(Glob::new("").is_err());
        assert!(Glob::new("[").is_err());
    }
}
