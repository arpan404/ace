// SPDX-License-Identifier: Apache-2.0
//! The branch-listing half of the ref reads (G1): `for-each-ref` over `refs/heads` and
//! `refs/remotes`, with Git's sort (`-committerdate`, then `refname`), `--count`, its
//! `%(upstream:short)` and `%(upstream:track,nobracket)` spellings, and the refname
//! shortening `%(refname:short)` prints.

use gix::bstr::{BStr, BString, ByteSlice};
use gix::config::AsKey;
use gix::odb::Header;
use gix::refs::TargetRef;

use super::shorten;

/// One ref of the repository, in the order Git's ref store hands them out.
struct Entry {
    name: BString,
    symbolic: Option<BString>,
    commit: Option<gix::hash::ObjectId>,
    time: i64,
    /// The ref's object is absent. Git 1 skips such a ref with a warning; its SHA-256 reader
    /// lists it until an atom or sort key needs the object, which then fails the command.
    missing: bool,
}

impl Entry {
    fn is_branch(&self) -> bool {
        self.name.starts_with(b"refs/heads/")
    }
}

/// `for-each-ref` with `remote-branches.ts`'s format, sorted `-committerdate` then `refname`.
pub(super) fn branch_refs(
    repo: &gix::Repository,
    patterns: &[String],
    count: u32,
) -> Option<Vec<u8>> {
    let entries = catalog(repo)?;
    let mut listed: Vec<&Entry> = entries
        .iter()
        .filter(|entry| matches(entry.name.as_bytes(), patterns))
        .collect();
    // The sort key peels every listed ref; a missing object fails the command Git runs.
    if listed.iter().any(|entry| entry.missing) {
        return None;
    }
    listed.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.name.cmp(&b.name)));
    if count > 0 {
        listed.truncate(count as usize);
    }
    let mut out = Vec::new();
    for entry in listed {
        out.extend_from_slice(&entry.name);
        out.push(0);
        if let Some(symbolic) = &entry.symbolic {
            out.extend_from_slice(symbolic);
        }
        out.push(0);
        let upstream = upstream(repo, &entries, entry)?;
        out.extend_from_slice(&upstream.short);
        out.push(0);
        out.extend_from_slice(&upstream.track);
        out.push(b'\n');
    }
    Some(out)
}

/// `for-each-ref --format=%(refname:short)`, in ref name order (Git's default sort).
pub(super) fn branch_names(
    repo: &gix::Repository,
    patterns: &[String],
    count: u32,
) -> Option<Vec<u8>> {
    let entries = catalog(repo)?;
    let mut listed: Vec<&Entry> = entries
        .iter()
        .filter(|entry| matches(entry.name.as_bytes(), patterns))
        .collect();
    if count > 0 {
        listed.truncate(count as usize);
    }
    let exists = |name: &BStr| {
        entries
            .binary_search_by(|entry| entry.name.as_bstr().cmp(name))
            .is_ok()
    };
    let mut out = Vec::new();
    for entry in listed {
        out.extend_from_slice(&shorten(entry.name.as_bstr(), &exists));
        out.push(b'\n');
    }
    Some(out)
}

/// Every ref of the repository, name-sorted, with what Git's atoms need from each.
fn catalog(repo: &gix::Repository) -> Option<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in repo.references().ok()?.all().ok()? {
        // Git warns about and skips a ref it cannot parse; so does the listing.
        let Ok(mut reference) = item else {
            continue;
        };
        let name = reference.name().as_bstr().to_owned();
        let symbolic = match reference.target() {
            TargetRef::Symbolic(target) => Some(target.as_bstr().to_owned()),
            TargetRef::Object(_) => None,
        };
        // `%(committerdate)` peels symbolic refs and annotated tags to their commit.
        let peeled = reference
            .peel_to_kind(gix::object::Kind::Commit)
            .ok()
            .and_then(|object| object.try_into_commit().ok());
        let (commit, time) = match peeled {
            Some(commit) => (
                Some(commit.id),
                commit.time().map_or(0, |time| time.seconds),
            ),
            None => (None, 0),
        };
        let missing = match target_id(repo, &reference) {
            Some(target) => match repo.objects.try_header(&target).ok()? {
                Some(_) => false,
                // Git's file backend drops a broken ref while reading it, before any filter.
                None if repo.object_hash() == gix::hash::Kind::Sha1 => continue,
                None => true,
            },
            // A dangling symbolic ref: Git skips it, and so does `gix`.
            None => continue,
        };
        entries.push(Entry {
            name,
            symbolic,
            commit,
            time,
            missing,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Some(entries)
}

/// The object a ref resolves to, following symbolic refs (`git rev-parse <ref>` without `^{}`).
fn target_id(
    repo: &gix::Repository,
    reference: &gix::Reference<'_>,
) -> Option<gix::hash::ObjectId> {
    let mut name: gix::refs::FullName = match reference.target() {
        TargetRef::Object(id) => return Some(id.to_owned()),
        TargetRef::Symbolic(name) => name.to_owned(),
    };
    for _ in 0..5 {
        let found = repo.find_reference(name.as_bstr()).ok()?;
        match found.target() {
            TargetRef::Object(id) => return Some(id.to_owned()),
            TargetRef::Symbolic(next) => name = next.to_owned(),
        }
    }
    None
}

/// A pattern matches a ref completely, or up to a slash, as `for-each-ref` matches a literal.
fn matches(name: &[u8], patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        let pattern = pattern.as_bytes();
        name == pattern || (name.starts_with(pattern) && name.get(pattern.len()) == Some(&b'/'))
    })
}

/// Git's `%(upstream:short)` and `%(upstream:track,nobracket)` for one ref.
struct Upstream {
    short: Vec<u8>,
    track: Vec<u8>,
}

impl Upstream {
    fn none() -> Self {
        Self {
            short: Vec::new(),
            track: Vec::new(),
        }
    }
}

fn upstream(repo: &gix::Repository, entries: &[Entry], entry: &Entry) -> Option<Upstream> {
    if !entry.is_branch() {
        return Some(Upstream::none());
    }
    let branch = entry.name.as_bytes().strip_prefix(b"refs/heads/")?;
    let config = repo.config_snapshot();
    let remote_key = key(b"branch.", branch, b".remote");
    let Some(remote) = string(&config, remote_key.as_bstr()) else {
        return Some(Upstream::none());
    };
    let merge_key = key(b"branch.", branch, b".merge");
    let merges = values(&config, merge_key.as_bstr());
    // Git's `branch_get_upstream` answers with the first merge value.
    let Some(merge) = merges.first() else {
        return Some(Upstream::none());
    };
    let exists = |name: &BStr| {
        entries
            .binary_search_by(|entry| entry.name.as_bstr().cmp(name))
            .is_ok()
    };
    let full = if remote.as_bstr() == b"." {
        // A local upstream: Git expands the merge name like a revision would, and keeps it
        // as configured when it names no ref or names more than one.
        expand(merge.as_bstr(), &exists)
    } else {
        let fetch_key = key(b"remote.", remote.as_bstr().as_bytes(), b".fetch");
        let Some(tracked) = tracking(&values(&config, fetch_key.as_bstr()), merge.as_bstr()) else {
            return Some(Upstream::none());
        };
        tracked
    };
    let short = shorten(full.as_bstr(), &exists);
    let track = track(repo, entry.commit, full.as_bstr(), &exists)?;
    Some(Upstream { short, track })
}

/// `dwim_ref`: the one existing ref a short merge name expands to, else the name as configured.
fn expand(merge: &BStr, exists: &impl Fn(&BStr) -> bool) -> BString {
    let name = merge.as_bytes();
    let candidates = [
        name.to_vec(),
        [b"refs/".as_slice(), name].concat(),
        [b"refs/tags/".as_slice(), name].concat(),
        [b"refs/heads/".as_slice(), name].concat(),
        [b"refs/remotes/".as_slice(), name].concat(),
        [b"refs/remotes/".as_slice(), name, b"/HEAD"].concat(),
    ];
    let found: Vec<BString> = candidates
        .into_iter()
        .filter(|candidate| exists(BStr::new(candidate)))
        .map(BString::from)
        .collect();
    if let [only] = found.as_slice() {
        return only.clone();
    }
    merge.to_owned()
}

/// The remote-tracking ref a fetch refspec maps the merge ref to (`remote_find_tracking`).
fn tracking(refspecs: &[BString], merge: &BStr) -> Option<BString> {
    let merge = merge.as_bytes();
    refspecs.iter().find_map(|refspec| {
        let spec = refspec.as_bytes();
        let spec = spec.strip_prefix(b"+").unwrap_or(spec);
        if spec.starts_with(b"^") {
            return None;
        }
        let (source, target) = split(spec, b':')?;
        let middle = match split(source, b'*') {
            Some((prefix, suffix)) => merge
                .strip_prefix(prefix)?
                .strip_suffix(suffix)
                .filter(|middle| !middle.is_empty())?,
            None if source == merge => &[][..],
            None => return None,
        };
        let target = match split(target, b'*') {
            Some((prefix, suffix)) => [prefix, middle, suffix].concat(),
            None if middle.is_empty() => target.to_vec(),
            None => return None,
        };
        Some(BString::from(target))
    })
}

/// `%(upstream:track,nobracket)`: `ahead N`, `behind N`, `ahead N, behind M`, `gone`, or empty.
fn track(
    repo: &gix::Repository,
    branch: Option<gix::hash::ObjectId>,
    upstream: &BStr,
    exists: &impl Fn(&BStr) -> bool,
) -> Option<Vec<u8>> {
    if !exists(upstream) {
        return Some(b"gone".to_vec());
    }
    let Some(branch) = branch else {
        return Some(Vec::new());
    };
    let mut reference = repo.find_reference(upstream).ok()?;
    let peeled = reference.peel_to_kind(gix::object::Kind::Commit).ok()?;
    let target = peeled.id;
    if branch == target {
        return Some(Vec::new());
    }
    let bases = repo.merge_bases_many(branch, &[target]).ok()?;
    let hidden: Vec<gix::hash::ObjectId> = bases.iter().map(|base| base.detach()).collect();
    let ahead = count(repo, branch, &hidden)?;
    let behind = count(repo, target, &hidden)?;
    Some(match (ahead, behind) {
        (0, 0) => Vec::new(),
        (ahead, 0) => format!("ahead {ahead}").into_bytes(),
        (0, behind) => format!("behind {behind}").into_bytes(),
        (ahead, behind) => format!("ahead {ahead}, behind {behind}").into_bytes(),
    })
}

/// Commits reachable from `tip` but not from any of `hidden`.
fn count(
    repo: &gix::Repository,
    tip: gix::hash::ObjectId,
    hidden: &[gix::hash::ObjectId],
) -> Option<u64> {
    let mut commits = 0;
    for item in repo
        .rev_walk([tip])
        .with_hidden(hidden.to_vec())
        .all()
        .ok()?
    {
        item.ok()?;
        commits += 1;
    }
    Some(commits)
}

/// Split at the first `needle`, or `None` when it does not occur.
fn split(haystack: &[u8], needle: u8) -> Option<(&[u8], &[u8])> {
    let index = haystack.iter().position(|byte| *byte == needle)?;
    Some((&haystack[..index], &haystack[index + 1..]))
}

/// A configuration key as bytes: `prefix + middle + suffix`, a valid `section.[subsection.]name`.
fn key(prefix: &[u8], middle: &[u8], suffix: &[u8]) -> BString {
    [prefix, middle, suffix].concat().into()
}

/// The last value at `key`, as `branch.<name>.remote` and friends read it.
fn string(config: &gix::config::Snapshot<'_>, key: &BStr) -> Option<BString> {
    key.try_as_key()?;
    config.string(key)
}

/// Every value at `key`, in file order (`remote.<name>.fetch` can repeat).
fn values(config: &gix::config::Snapshot<'_>, key: &BStr) -> Vec<BString> {
    if key.try_as_key().is_none() {
        return Vec::new();
    }
    config.plumbing().raw_values(key).unwrap_or_default()
}
