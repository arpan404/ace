//! Toolchains under the person's home folder (ADR 0167 decision 1; the audit's A1): found for the
//! person to confirm per bot, then read-only in the bot's sandbox with their `bin` first on
//! `PATH`. Pure apart from the `is_dir` it is given.

use std::path::{Path, PathBuf};

/// Where toolchains usually live, under the home folder.
const CANDIDATES: &[&str] = &[
    ".cargo/bin",
    ".rustup",
    ".bun/bin",
    ".deno/bin",
    ".local/bin",
    "go/bin",
    ".volta/bin",
    ".pyenv",
    ".local/share/mise",
    ".asdf",
    ".dotnet",
    ".ghcup/bin",
    "Library/pnpm",
];

/// The candidates that exist under `home`, for the person to confirm.
pub fn detect(home: &Path, is_dir: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    CANDIDATES
        .iter()
        .map(|candidate| home.join(candidate))
        .filter(|path| is_dir(path))
        .collect()
}

/// What confirmed toolchains add to a run: folders first on `PATH`, and variables a toolchain
/// needs when `HOME` is the workspace (`RUSTUP_HOME`, `PYENV_ROOT`).
pub fn env(
    toolchains: &[PathBuf],
    is_dir: &dyn Fn(&Path) -> bool,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut path = Vec::new();
    let mut vars = Vec::new();
    for dir in toolchains {
        let text = dir.to_string_lossy().into_owned();
        match dir.file_name().and_then(|n| n.to_str()) {
            Some("bin") => path.push(text),
            Some(".rustup") => vars.push(("RUSTUP_HOME".to_owned(), text)),
            Some(".pyenv") => {
                vars.push(("PYENV_ROOT".to_owned(), text));
                path.push(dir.join("shims").to_string_lossy().into_owned());
            }
            _ if is_dir(&dir.join("bin")) => {
                path.push(dir.join("bin").to_string_lossy().into_owned())
            }
            _ => {}
        }
    }
    (path, vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolchains_that_exist_are_offered_and_add_their_bin_first_on_path() {
        let home = Path::new("/Users/p");
        let present = |p: &Path| {
            [
                "/Users/p/.cargo/bin",
                "/Users/p/.rustup",
                "/Users/p/.bun/bin",
                "/Users/p/.dotnet",
                "/Users/p/.dotnet/bin",
            ]
            .iter()
            .any(|x| Path::new(x) == p)
        };
        let found = detect(home, &present);
        assert_eq!(
            found,
            vec![
                PathBuf::from("/Users/p/.cargo/bin"),
                PathBuf::from("/Users/p/.rustup"),
                PathBuf::from("/Users/p/.bun/bin"),
                PathBuf::from("/Users/p/.dotnet"),
            ]
        );
        let (path, vars) = env(&found, &present);
        assert_eq!(
            path,
            vec![
                "/Users/p/.cargo/bin",
                "/Users/p/.bun/bin",
                "/Users/p/.dotnet/bin"
            ]
        );
        assert_eq!(
            vars,
            vec![("RUSTUP_HOME".to_owned(), "/Users/p/.rustup".to_owned())]
        );
    }
}
