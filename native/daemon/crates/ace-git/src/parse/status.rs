//! Strict `git status --porcelain=v2 -z --branch` parsing (`packages/git/src/parse-status.ts`,
//! G3a). Every record is validated; anything else is `malformed_output`, never a guess.
//!
//! Proof: `malformed-output.test.ts`'s "status" cases (moved here), and the reads through
//! `repository.process`, `changed-files-regressions.process`, `malformed.process` and
//! `failure-categories.process`.

use serde::Serialize;

use crate::core::decode::{
    self, MODE_SCHEMA, Records, fields_and_path, hash, malformed, nul, path_schema, ref_schema,
};
use crate::parse::repository::BranchState;

/// One file `git status` reports, with its index and worktree letters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub submodule: String,
}

/// The four lists `git status` reports, ignored files excluded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Status {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<StatusEntry>,
}

/// One status read: the lists and the branch headers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedStatus {
    pub status: Status,
    pub branch: BranchState,
}

fn mode_schema(value: &str) -> bool {
    MODE_SCHEMA.contains(&value)
}

fn xy_ok(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(character) if ".MTADRC".contains(character))
        && matches!(characters.next(), Some(character) if ".MTADRC".contains(character))
        && characters.next().is_none()
}

fn sub_ok(value: &str) -> bool {
    let characters: Vec<char> = value.chars().collect();
    match characters.as_slice() {
        ['N', '.', '.', '.'] => true,
        ['S', commit, modified, untracked] => {
            matches!(commit, '.' | 'C')
                && matches!(modified, '.' | 'M')
                && matches!(untracked, '.' | 'U')
        }
        _ => false,
    }
}

fn conflict_xy(value: &str) -> bool {
    matches!(value, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

fn rename_score(value: &str) -> Option<(&str, u64)> {
    let mut characters = value.chars();
    let kind = characters.next()?;
    if !matches!(kind, 'R' | 'C') {
        return None;
    }
    let digits = characters.as_str();
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((&value[..1], decode::count(digits).ok()?))
}

/// Parses one `status` read's bytes.
pub fn parse_status(bytes: &[u8]) -> Result<ParsedStatus, crate::core::error::GitError> {
    let mut status = Status::default();
    let mut branch = BranchState::default();
    let mut records = Records::new(nul(bytes)?);
    let mut headers: Vec<String> = Vec::new();
    while !records.done() {
        let record = records.next()?.to_owned();
        if let Some(header) = record.strip_prefix("# ") {
            let Some(space) = header.find(' ') else {
                return Err(malformed("status header"));
            };
            let key = &header[..space];
            let value = &header[space + 1..];
            if headers.iter().any(|known| known == key) {
                return Err(malformed("duplicate status header"));
            }
            headers.push(key.to_owned());
            match key {
                "branch.oid" => {
                    branch.head = if value == "(initial)" {
                        None
                    } else {
                        Some(hash(value)?)
                    };
                }
                "branch.head" => {
                    branch.detached = value == "(detached)";
                    branch.branch = if branch.detached {
                        None
                    } else {
                        Some(ref_schema(value).ok_or_else(|| malformed("branch"))?)
                    };
                }
                "branch.upstream" => {
                    branch.upstream = Some(ref_schema(value).ok_or_else(|| malformed("upstream"))?);
                }
                "branch.ab" => {
                    let [ahead, behind] = match value.split(' ').collect::<Vec<_>>()[..] {
                        [ahead, behind] => [ahead, behind],
                        _ => return Err(malformed("ahead/behind")),
                    };
                    let ahead = ahead
                        .strip_prefix('+')
                        .filter(|digits| {
                            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                        })
                        .ok_or_else(|| malformed("ahead/behind"))?;
                    let behind = behind
                        .strip_prefix('-')
                        .filter(|digits| {
                            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                        })
                        .ok_or_else(|| malformed("ahead/behind"))?;
                    branch.ahead = decode::count(ahead)?;
                    branch.behind = decode::count(behind)?;
                }
                _ => return Err(malformed("status header")),
            }
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            // Even with `--untracked-files=all`, a nested repository or linked worktree is one
            // directory entry with a trailing slash; it still makes the worktree dirty.
            let path = path.strip_suffix('/').unwrap_or(path);
            // ace's files service parks uploads under `.ace-upload-*`; they are not the person's.
            if path.split('/').any(|part| part.starts_with(".ace-upload-")) {
                continue;
            }
            status
                .untracked
                .push(path_schema(path).ok_or_else(|| malformed("untracked path"))?);
            continue;
        }
        let kind = record.chars().next().unwrap_or_default();
        let field_count = match kind {
            '1' => 8,
            '2' => 9,
            'u' => 10,
            _ => return Err(malformed("status record kind")),
        };
        let (fields, path) = fields_and_path(&record, field_count)?;
        let (xy, submodule) = match kind {
            '1' => {
                let [xy, submodule] = ordinary(&fields)?;
                (xy.to_owned(), submodule.to_owned())
            }
            '2' => {
                let [xy, submodule, score] = renamed(&fields)?;
                let (rename_kind, similarity) =
                    rename_score(score).ok_or_else(|| malformed("rename score"))?;
                if !xy.contains(rename_kind) || similarity > 100 {
                    return Err(malformed("rename score"));
                }
                (xy.to_owned(), submodule.to_owned())
            }
            _ => {
                let [xy, submodule] = conflict(&fields)?;
                (xy.to_owned(), submodule.to_owned())
            }
        };
        let characters: Vec<char> = xy.chars().collect();
        let [index_status, worktree_status] = match characters.as_slice() {
            [index, worktree] => [index.to_string(), worktree.to_string()],
            _ => return Err(malformed("XY status")),
        };
        let mut entry = StatusEntry {
            path,
            old_path: None,
            index_status,
            worktree_status,
            submodule,
        };
        if kind == '2' {
            entry.old_path =
                Some(path_schema(records.next()?).ok_or_else(|| malformed("rename source"))?);
        }
        if kind == 'u' {
            status.conflicted.push(entry);
        } else {
            if entry.index_status != "." {
                status.staged.push(entry.clone());
            }
            if entry.worktree_status != "." {
                status.unstaged.push(entry);
            }
        }
    }
    if !headers.iter().any(|key| key == "branch.oid")
        || !headers.iter().any(|key| key == "branch.head")
    {
        return Err(malformed("missing branch headers"));
    }
    Ok(ParsedStatus { status, branch })
}

fn validate_xy_sub(fields: &[String]) -> Result<(), crate::core::error::GitError> {
    if !xy_ok(&fields[1]) {
        return Err(malformed("XY status"));
    }
    if !sub_ok(&fields[2]) {
        return Err(malformed("submodule status"));
    }
    Ok(())
}

fn modes(fields: &[String], indexes: &[usize]) -> Result<(), crate::core::error::GitError> {
    for index in indexes {
        if !mode_schema(fields.get(*index).map(String::as_str).unwrap_or_default()) {
            return Err(malformed("file mode"));
        }
    }
    Ok(())
}

fn ordinary(fields: &[String]) -> Result<[&str; 2], crate::core::error::GitError> {
    if fields.len() != 8 {
        return Err(malformed("ordinary status"));
    }
    validate_xy_sub(fields)?;
    modes(fields, &[3, 4, 5])?;
    hash(fields.get(6).map(String::as_str).unwrap_or_default())?;
    hash(fields.get(7).map(String::as_str).unwrap_or_default())?;
    Ok([fields[1].as_str(), fields[2].as_str()])
}

fn renamed(fields: &[String]) -> Result<[&str; 3], crate::core::error::GitError> {
    if fields.len() != 9 {
        return Err(malformed("rename status"));
    }
    validate_xy_sub(fields)?;
    modes(fields, &[3, 4, 5])?;
    hash(fields.get(6).map(String::as_str).unwrap_or_default())?;
    hash(fields.get(7).map(String::as_str).unwrap_or_default())?;
    Ok([fields[1].as_str(), fields[2].as_str(), fields[8].as_str()])
}

fn conflict(fields: &[String]) -> Result<[&str; 2], crate::core::error::GitError> {
    if fields.len() != 10 {
        return Err(malformed("conflict status"));
    }
    if !conflict_xy(&fields[1]) {
        return Err(malformed("conflict status"));
    }
    if !sub_ok(&fields[2]) {
        return Err(malformed("submodule status"));
    }
    modes(fields, &[3, 4, 5, 6])?;
    for index in [7usize, 8, 9] {
        hash(fields.get(index).map(String::as_str).unwrap_or_default())?;
    }
    Ok([fields[1].as_str(), fields[2].as_str()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::GitErrorCode;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEADERS: &str =
        "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0# branch.head main\0";

    fn ordinary_record() -> String {
        format!("1 M. N... 100644 100644 100644 {SHA} {SHA}")
    }

    fn rename_record() -> String {
        format!("2 R. N... 100644 100644 100644 {SHA} {SHA} R100")
    }

    fn rejects(output: &str) {
        let error = parse_status(format!("{HEADERS}{output}").as_bytes()).expect_err(output);
        assert_eq!(error.code, GitErrorCode::MalformedOutput, "{output:?}");
    }

    // Every case of `malformed-output.test.ts`'s "status" table, moved with the parser.
    #[test]
    fn malformed_status_records_are_refused_with_a_typed_error() {
        let ordinary = ordinary_record();
        let rename = rename_record();
        for record in [
            "1 M. N...\0".to_owned(),
            format!("{} file\0", ordinary.replace("M.", "Z.")),
            format!("{} file\0", ordinary.replace("M.", "UU")),
            format!("{} file\0", ordinary.replace(SHA, "abcdef")),
            format!("{} file\0", ordinary.replace(SHA, &"z".repeat(40))),
            format!("{} file\0", ordinary.replace("100644", "123456")),
            format!("{} file\0", ordinary.replace("N...", "NXXX")),
            format!("{rename} file\0"),
            format!("{} file\0old\0", rename.replace("R100", "R101")),
            format!("{} file\0old\0", rename.replace("R.", "M.")),
            "? /outside\0".to_owned(),
            "? ../outside\0".to_owned(),
            "? \0".to_owned(),
            "? .git/config\0".to_owned(),
            format!("u ZZ N... 100644 100644 100644 100644 {SHA} {SHA} {SHA} file\0"),
            "# branch.ab +-1 -0\0".to_owned(),
            "# branch.ab +Infinity -0\0".to_owned(),
            "# branch.ab +9007199254740992 -0\0".to_owned(),
            "# branch.ab +1 -0 extra\0".to_owned(),
            "# unknown value\0".to_owned(),
            "# branch.head other\0".to_owned(),
            "? file".to_owned(),
        ] {
            rejects(&record);
        }
    }

    #[test]
    fn invalid_utf8_path_bytes_are_rejected_rather_than_replaced() {
        let mut bytes = format!("{HEADERS}? ").into_bytes();
        bytes.extend_from_slice(&[255, 0]);
        let error = parse_status(&bytes).expect_err("invalid utf8");
        assert_eq!(error.code, GitErrorCode::MalformedOutput);
    }

    #[test]
    fn well_formed_records_preserve_unusual_paths_exactly() {
        let path = "space tab\tnewline\n\u{96ea}.txt";
        let parsed = parse_status(
            format!(
                "{HEADERS}{} {path}\0? untracked\n\u{96ea}\0",
                ordinary_record()
            )
            .as_bytes(),
        )
        .expect("status");
        assert_eq!(
            parsed.status,
            Status {
                staged: vec![StatusEntry {
                    path: path.to_owned(),
                    old_path: None,
                    index_status: "M".to_owned(),
                    worktree_status: ".".to_owned(),
                    submodule: "N...".to_owned(),
                }],
                unstaged: Vec::new(),
                untracked: vec!["untracked\n\u{96ea}".to_owned()],
                conflicted: Vec::new(),
            }
        );
    }

    #[test]
    fn branch_headers_carry_the_branch_detachment_and_counts_and_require_oid_and_head() {
        let parsed = parse_status(
            format!(
                "# branch.oid {SHA}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0"
            )
            .as_bytes(),
        )
        .expect("status");
        assert_eq!(
            parsed.branch,
            BranchState {
                branch: Some("main".to_owned()),
                detached: false,
                head: Some(SHA.to_owned()),
                upstream: Some("origin/main".to_owned()),
                ahead: 2,
                behind: 3,
            }
        );
        let detached =
            parse_status(format!("# branch.oid {SHA}\0# branch.head (detached)\0").as_bytes())
                .expect("detached");
        assert_eq!(detached.branch.branch, None);
        assert!(detached.branch.detached);
        let initial =
            parse_status(b"# branch.oid (initial)\0# branch.head main\0").expect("initial");
        assert_eq!(initial.branch.head, None);
        for headers in [
            format!("# branch.oid {SHA}\0"),
            "# branch.head main\0".to_owned(),
            format!("# branch.oid {SHA}\0# branch.head main\0# branch.head other\0"),
        ] {
            let error = parse_status(headers.as_bytes()).expect_err("headers");
            assert_eq!(error.code, GitErrorCode::MalformedOutput, "{headers}");
        }
    }

    #[test]
    fn a_rename_reports_both_paths_and_its_source_is_required() {
        let parsed =
            parse_status(format!("{HEADERS}{} new name\0old name\0", rename_record()).as_bytes())
                .expect("rename");
        assert_eq!(parsed.status.staged.len(), 1);
        assert_eq!(parsed.status.staged[0].path, "new name");
        assert_eq!(
            parsed.status.staged[0].old_path.as_deref(),
            Some("old name")
        );
    }

    #[test]
    fn invalid_submodule_flags_are_malformed_and_dirty_and_moved_ones_are_not() {
        let ordinary = ordinary_record();
        rejects(&format!(
            "{HEADERS}{} file\0",
            ordinary.replace("N...", "S.U.")
        ));
        let dirty = parse_status(
            format!("{HEADERS}{} dirty-sub\0", ordinary.replace("N...", "S.M.")).as_bytes(),
        )
        .expect("dirty submodule");
        assert_eq!(dirty.status.staged[0].submodule, "S.M.");
        let moved = parse_status(
            format!(
                "{HEADERS}{} moved-sub.txt\0",
                ordinary.replace("N...", "SCM.")
            )
            .as_bytes(),
        )
        .expect("moved submodule");
        assert_eq!(moved.status.staged[0].submodule, "SCM.");
    }

    #[test]
    fn ace_upload_paths_are_never_the_persons_changes_and_a_dirty_directory_counts() {
        let parsed = parse_status(
            format!("{HEADERS}? .ace-upload-123/file\0? linked-worktree/\0? plain\0").as_bytes(),
        )
        .expect("status");
        assert_eq!(
            parsed.status.untracked,
            vec!["linked-worktree".to_owned(), "plain".to_owned()]
        );
    }
}
