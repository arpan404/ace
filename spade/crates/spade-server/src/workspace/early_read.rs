//! Samples one workspace file during streaming and checks its identity and trust before reuse.

use std::io::{Read as _, Seek as _};

use cap_fs_ext::MetadataExt;

use super::Workspace;
use crate::tools::{EarlyRead, ToolOutput};

#[derive(PartialEq, Eq)]
struct FileStamp {
    device: u64,
    inode: u64,
    size: u64,
    modified: cap_std::time::SystemTime,
}

fn stamp(file: &cap_std::fs::File) -> Option<FileStamp> {
    let meta = file.metadata().ok()?;
    Some(FileStamp {
        device: meta.dev(),
        inode: meta.ino(),
        size: meta.len(),
        modified: meta.modified().ok()?,
    })
}

pub(super) fn sample(
    workspace: Workspace,
    path: &str,
    offset: usize,
    limit: usize,
) -> Option<EarlyRead> {
    use super::files::{LARGEST_TEXT, open_regular};
    use super::reading::{self, Shape};

    let path = workspace.normal(path).ok()?;
    let relative = std::path::Path::new(&path);
    let mut file = open_regular(&workspace.dir().ok()?, relative, &path).ok()?;
    let before = stamp(&file)?;
    let mut head = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(reading::HEAD as u64)
        .read_to_end(&mut head)
        .ok()?;
    let shape = reading::shape(&head);
    let largest = match shape {
        Shape::Text => LARGEST_TEXT,
        Shape::Image => reading::LARGEST_IMAGE,
        Shape::Document => return None,
    };
    if before.size > largest {
        return None;
    }
    file.rewind().ok()?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(largest + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if stamp(&file)? != before || bytes.len() as u64 != before.size {
        return None;
    }
    let entry = workspace.trust().hash_at(&path);
    let plain = workspace.plain_file(&path);
    let trusted = plain
        && entry
            .as_ref()
            .is_some_and(|hash| *hash == super::trust::hash(&bytes));
    let output = match shape {
        Shape::Text => ToolOutput::ok(super::files::window(
            &path,
            std::str::from_utf8(&bytes).ok()?,
            offset,
            limit,
        )),
        Shape::Image => ToolOutput {
            content: reading::image_line(&path, &bytes),
            images: vec![bytes],
            ..ToolOutput::ok("")
        },
        Shape::Document => return None,
    };
    #[cfg(feature = "test-hooks")]
    if let Some(hook) = &workspace.early_read_hook.0 {
        hook(&path);
    }
    Some(EarlyRead {
        output: if trusted { output } else { output.untrusted() },
        current: Box::new(move || {
            let Ok(dir) = workspace.dir() else {
                return false;
            };
            open_regular(&dir, std::path::Path::new(&path), &path)
                .ok()
                .and_then(|file| stamp(&file))
                .is_some_and(|now| now == before)
                && workspace.trust().hash_at(&path) == entry
                && workspace.plain_file(&path) == plain
        }),
    })
}
