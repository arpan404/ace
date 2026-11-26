// SPDX-License-Identifier: Apache-2.0
//! Paths the platform walks: `path.join` for this machine's separator, without resolving
//! anything. Every part is a name or a path a caller supplied, so nothing here touches the
//! filesystem or follows a link.

/// `path.join` for this machine: the parts joined by the host's separator.
pub fn join(parts: &[&str]) -> String {
    let mut path = std::path::PathBuf::new();
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_join_keeps_every_part_in_order() {
        assert_eq!(join(&["/a", "b", "c.ini"]), "/a/b/c.ini");
    }
}
