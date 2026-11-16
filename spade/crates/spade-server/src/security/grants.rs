//! Grants down a bot's tree with folders compared as the objects they name (ADR 0167 decision 5):
//! every folder grant, the parent's too, is resolved (links followed) each time it is used, so a
//! worker's folder that is, or later becomes, a link out of its parent's folder is dropped.

use spade_core::grant::{self, Grant, Scope};

/// `grants` with each folder's path resolved by `resolve`.
pub fn resolved(grants: &[Grant], resolve: &dyn Fn(&str) -> String) -> Vec<Grant> {
    grants
        .iter()
        .map(|g| match &g.scope {
            Scope::Folder { path, write } => Grant {
                scope: Scope::Folder {
                    path: resolve(path),
                    write: *write,
                },
                ..g.clone()
            },
            _ => g.clone(),
        })
        .collect()
}

/// The effective grants of the last bot in `chain` (top first, each bot's own grants), folders
/// resolved before each one is narrowed by the one above.
pub fn narrowed(chain: &[Vec<Grant>], resolve: &dyn Fn(&str) -> String) -> Vec<Grant> {
    let mut above: Option<Vec<Grant>> = None;
    for own in chain {
        let own = resolved(own, resolve);
        above = Some(grant::effective(&own, above.as_deref()));
    }
    above.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(path: &std::path::Path, write: bool) -> Grant {
        Grant {
            id: "g".to_owned(),
            scope: Scope::Folder {
                path: path.to_string_lossy().into_owned(),
                write,
            },
            by: grant::BY_PERSON.to_owned(),
            created_at: 0,
        }
    }

    fn real(path: &str) -> String {
        spade_sandbox::policy::real(std::path::Path::new(path))
            .to_string_lossy()
            .into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn a_workers_folder_that_is_a_link_out_of_its_parents_folder_is_dropped() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let root = spade_sandbox::policy::real(dir.path());
        let (app, secret) = (root.join("app"), root.join("secret"));
        std::fs::create_dir_all(app.join("src")).unwrap_or_default();
        std::fs::create_dir_all(&secret).unwrap_or_default();
        let _ = std::os::unix::fs::symlink(&secret, app.join("escape"));
        let parent = vec![folder(&app, true)];
        let inside = folder(&app.join("src"), true);
        let escaping = folder(&app.join("escape"), true);
        let kept = narrowed(&[parent.clone(), vec![inside.clone(), escaping]], &real);
        assert_eq!(kept, vec![inside.clone()]);
        // A folder that was inside, swapped for a link out, is dropped on its next use.
        let _ = std::fs::remove_dir_all(app.join("src"));
        let _ = std::os::unix::fs::symlink(&secret, app.join("src"));
        assert!(narrowed(&[parent, vec![inside]], &real).is_empty());
    }
}
