//! A bot's knowledge base (ADR 0164, docs/knowledge.md): how an entry's topic and text are
//! cleaned, the trust Spade gives it, when two entries are the same or alike, which entries a
//! growing topic or a full base folds into a digest, and the topic index the standing
//! instructions show. Pure: the store runs the queries and the engine supplies the time.
//!
//! - [`episode`]: what a closed goal is remembered as.

use serde::{Deserialize, Serialize};

pub mod episode;

/// The longest topic, in characters.
pub const TOPIC_CHARS: usize = 64;
/// The longest title, in characters.
pub const TITLE_CHARS: usize = 200;
/// The longest body, in characters.
pub const BODY_CHARS: usize = 8_000;
/// A topic with more entries than this has its oldest bot-written ones folded...
pub const TOPIC_GROWS: usize = 50;
/// ...until this many remain.
pub const TOPIC_KEEPS: usize = 30;
/// A base's size when the person set none: `SPADE_KNOWLEDGE_BYTES` overrides it.
pub const DEFAULT_BYTES: u64 = 4 * 1024 * 1024;
/// A base past its bound is folded down to this share of it.
pub const FOLD_TO_PERCENT: u64 = 90;
/// The most topics the standing instructions list.
pub const INDEX_TOPICS: usize = 12;
/// The longest topic index, in characters.
pub const INDEX_CHARS: usize = 2_000;
/// Titles shown per topic in the index.
const INDEX_TITLES: usize = 3;
/// Entries sharing at least this share of their words are alike: a merge is suggested.
pub const ALIKE: f64 = 0.6;
/// The most of one entry's body a digest keeps.
const DIGEST_LEAD: usize = 240;

/// What an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Fact,
    Decision,
    Finding,
    Howto,
    /// A digest of folded entries, made by Spade.
    Summary,
}

impl Kind {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Decision => "decision",
            Self::Finding => "finding",
            Self::Howto => "howto",
            Self::Summary => "summary",
        }
    }

    /// Read leniently: anything unknown is a fact.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "decision" => Self::Decision,
            "finding" => Self::Finding,
            "howto" => Self::Howto,
            "summary" => Self::Summary,
            _ => Self::Fact,
        }
    }
}

/// Where an entry's content came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Person,
    Bot,
    /// A web page; `detail` is its URL.
    Web,
    /// A file; `detail` is its path.
    File,
    /// A tool's output; `detail` is the tool's name and the call's id.
    Tool,
    /// Anything else from outside: an email, another bot's words.
    Untrusted,
}

impl SourceKind {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Bot => "bot",
            Self::Web => "web",
            Self::File => "file",
            Self::Tool => "tool",
            Self::Untrusted => "untrusted",
        }
    }

    /// Read leniently: anything unknown is untrusted.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "person" => Self::Person,
            "bot" => Self::Bot,
            "web" => Self::Web,
            "file" => Self::File,
            "tool" => Self::Tool,
            _ => Self::Untrusted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    Trusted,
    Untrusted,
}

impl Trust {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Untrusted => "untrusted",
        }
    }

    /// Read leniently: anything unknown is untrusted.
    pub fn parse(raw: &str) -> Self {
        if raw == "trusted" {
            Self::Trusted
        } else {
            Self::Untrusted
        }
    }
}

/// How one entry relates to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Related,
    Supports,
    Contradicts,
    Supersedes,
    PartOf,
}

impl Relation {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Related => "related",
            Self::Supports => "supports",
            Self::Contradicts => "contradicts",
            Self::Supersedes => "supersedes",
            Self::PartOf => "part_of",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "related" => Self::Related,
            "supports" => Self::Supports,
            "contradicts" => Self::Contradicts,
            "supersedes" => Self::Supersedes,
            "part_of" => Self::PartOf,
            _ => return None,
        })
    }
}

/// An entry as the rules here need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub topic: String,
    pub title: String,
    pub body: String,
    pub kind: Kind,
    pub source: SourceKind,
    pub trust: Trust,
    /// The person wrote it: no bot changes it, and folding never touches it.
    pub by_person: bool,
    pub created_ms: i64,
    pub updated_ms: i64,
}

impl Entry {
    /// What the entry takes against its base's bound: its text, in bytes.
    pub fn bytes(&self) -> u64 {
        (self.topic.len() + self.title.len() + self.body.len()) as u64
    }

    /// Whether folding may take it: written by a bot (a summary included), never the person's.
    pub fn foldable(&self) -> bool {
        !self.by_person
    }
}

/// A topic as stored: lower-case words joined by `-`, `/` between subtopics, at most
/// [`TOPIC_CHARS`]. `None` when nothing is left or it is too long.
pub fn topic(raw: &str) -> Option<String> {
    let parts: Vec<String> = raw
        .split('/')
        .map(|part| {
            part.split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
                .map(str::to_lowercase)
                .collect::<Vec<_>>()
                .join("-")
        })
        .filter(|part| !part.is_empty())
        .collect();
    let topic = parts.join("/");
    let count = topic.chars().count();
    (count > 0 && count <= TOPIC_CHARS).then_some(topic)
}

/// A title as stored: trimmed, on one line, at most [`TITLE_CHARS`].
pub fn title(raw: &str) -> Option<String> {
    let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = line.chars().count();
    (count > 0 && count <= TITLE_CHARS).then_some(line)
}

/// A body as stored: trimmed, line breaks kept, at most [`BODY_CHARS`].
pub fn body(raw: &str) -> Option<String> {
    let text = raw.trim();
    let count = text.chars().count();
    (count > 0 && count <= BODY_CHARS).then(|| text.to_owned())
}

/// The trust Spade gives a new entry: untrusted when its source is the web or another outside
/// party, when it is a tool whose output is untrusted, or when the prompt the write came from
/// shows untrusted content. The person's own entries are trusted.
pub fn trust(source: SourceKind, untrusted_tool: bool, tainted: bool) -> Trust {
    match source {
        SourceKind::Person => Trust::Trusted,
        SourceKind::Web | SourceKind::Untrusted => Trust::Untrusted,
        SourceKind::Tool if untrusted_tool => Trust::Untrusted,
        _ if tainted => Trust::Untrusted,
        _ => Trust::Trusted,
    }
}

/// An entry's trust after a bot's edit: it can go down, never up.
pub fn edited(old: Trust, tainted: bool) -> Trust {
    if tainted { Trust::Untrusted } else { old }
}

/// Whether two entries say the same: ADR 0128's rule over title and body together.
pub fn same(a_title: &str, a_body: &str, b_title: &str, b_body: &str) -> bool {
    crate::memory::same(
        &format!("{a_title} {a_body}"),
        &format!("{b_title} {b_body}"),
    )
}

/// The share of their meaningful words two texts have in common (Jaccard), 0 to 1.
pub fn overlap(a: &str, b: &str) -> f64 {
    let wa = crate::memory::words(a);
    let wb = crate::memory::words(b);
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    let shared = wa.iter().filter(|w| wb.contains(w)).count();
    let union = wa.len() + wb.len() - shared;
    shared as f64 / union as f64
}

/// Whether two entries are alike enough to suggest merging them.
pub fn alike(a: &Entry, b: &Entry) -> bool {
    a.id != b.id
        && a.topic == b.topic
        && overlap(
            &format!("{} {}", a.title, a.body),
            &format!("{} {}", b.title, b.body),
        ) >= ALIKE
}

/// Pairs of alike entries, each once, ordered by how alike, most first.
pub fn merge_suggestions(entries: &[Entry]) -> Vec<(String, String, f64)> {
    let mut pairs = Vec::new();
    for (i, a) in entries.iter().enumerate() {
        for b in &entries[i + 1..] {
            if a.topic != b.topic {
                continue;
            }
            let score = overlap(
                &format!("{} {}", a.title, a.body),
                &format!("{} {}", b.title, b.body),
            );
            if score >= ALIKE {
                pairs.push((a.id.clone(), b.id.clone(), score));
            }
        }
    }
    pairs.sort_by(|x, y| y.2.total_cmp(&x.2).then_with(|| x.0.cmp(&y.0)));
    pairs
}

/// Entries to fold into one digest: one topic, one trust level, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fold {
    pub topic: String,
    pub trust: Trust,
    pub entries: Vec<String>,
}

/// The oldest-first order folding takes entries in: least recently changed, then oldest made.
fn oldest_first<'a>(entries: impl Iterator<Item = &'a Entry>) -> Vec<&'a Entry> {
    let mut out: Vec<&Entry> = entries.filter(|e| e.foldable()).collect();
    out.sort_by(|a, b| {
        (a.updated_ms, a.created_ms, &a.id).cmp(&(b.updated_ms, b.created_ms, &b.id))
    });
    out
}

/// Groups taken entries into folds by topic and trust, so trusted and untrusted text never share
/// a digest. A fold of one entry changes nothing and is left out.
fn grouped(taken: &[&Entry]) -> Vec<Fold> {
    let mut folds: Vec<Fold> = Vec::new();
    for entry in taken {
        match folds
            .iter_mut()
            .find(|f| f.topic == entry.topic && f.trust == entry.trust)
        {
            Some(fold) => fold.entries.push(entry.id.clone()),
            None => folds.push(Fold {
                topic: entry.topic.clone(),
                trust: entry.trust,
                entries: vec![entry.id.clone()],
            }),
        }
    }
    folds.retain(|f| f.entries.len() > 1);
    folds
}

/// What a topic past [`TOPIC_GROWS`] folds: its oldest bot-written entries until
/// [`TOPIC_KEEPS`] remain, counting each digest made as one. Empty while it is small enough or
/// holds too few bot-written entries.
pub fn topic_folds(topic: &[Entry]) -> Vec<Fold> {
    if topic.len() <= TOPIC_GROWS {
        return Vec::new();
    }
    let candidates = oldest_first(topic.iter());
    // Taking n entries into (at most) two digests leaves len - n + 2.
    let excess = topic.len().saturating_sub(TOPIC_KEEPS) + 2;
    let take = excess.min(candidates.len());
    grouped(&candidates[..take])
}

/// What a base must fold so `incoming` more bytes fit in `limit`: its oldest bot-written
/// entries, oldest first across topics, until it is at [`FOLD_TO_PERCENT`] of the bound with
/// the new entry. `Some(empty)` when it fits already; `None` when even folding everything it may
/// fold leaves no room: the write is refused, never made by dropping anything.
pub fn bound_folds(base: &[Entry], limit: u64, incoming: u64) -> Option<Vec<Fold>> {
    let used: u64 = base.iter().map(Entry::bytes).sum();
    if used + incoming <= limit {
        return Some(Vec::new());
    }
    let target = limit * FOLD_TO_PERCENT / 100;
    let candidates = oldest_first(base.iter());
    let mut taken: Vec<&Entry> = Vec::new();
    for entry in candidates {
        taken.push(entry);
        let folds = grouped(&taken);
        if after_folds(base, &folds, &taken_of(&folds)) + incoming <= target {
            return Some(folds);
        }
    }
    let folds = grouped(&taken);
    (after_folds(base, &folds, &taken_of(&folds)) + incoming <= limit).then_some(folds)
}

fn taken_of(folds: &[Fold]) -> Vec<String> {
    folds
        .iter()
        .flat_map(|f| f.entries.iter().cloned())
        .collect()
}

/// The base's size once `folds` replaced their entries with digests.
fn after_folds(base: &[Entry], folds: &[Fold], taken: &[String]) -> u64 {
    let kept: u64 = base
        .iter()
        .filter(|e| !taken.contains(&e.id))
        .map(Entry::bytes)
        .sum();
    let digests: u64 = folds
        .iter()
        .map(|fold| {
            let entries: Vec<&Entry> = base
                .iter()
                .filter(|e| fold.entries.contains(&e.id))
                .collect();
            let (title, body) = digest(&entries);
            (fold.topic.len() + title.len() + body.len()) as u64
        })
        .sum();
    kept + digests
}

/// A digest of folded entries: a title naming how many and when, and one line each (title,
/// date, the first of its body), oldest first, within [`BODY_CHARS`]. Not a model's rewrite:
/// nothing is invented and nothing changes trust.
pub fn digest(entries: &[&Entry]) -> (String, String) {
    let topic = entries.first().map_or("", |e| e.topic.as_str());
    let from = entries.iter().map(|e| e.created_ms).min().unwrap_or(0);
    let to = entries.iter().map(|e| e.updated_ms).max().unwrap_or(0);
    let title = format!(
        "Summary of {} older entries on {topic} ({} to {})",
        entries.len(),
        day(from),
        day(to)
    );
    let mut body = String::new();
    for entry in entries {
        let lead: String = entry
            .body
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(DIGEST_LEAD)
            .collect();
        let line = format!(
            "- {} ({}, {}): {lead}\n",
            entry.title,
            day(entry.updated_ms),
            entry.kind.name()
        );
        if body.chars().count() + line.chars().count() > BODY_CHARS {
            let more = "- …and more, cut to fit\n";
            if body.chars().count() + more.len() <= BODY_CHARS {
                body.push_str(more);
            }
            break;
        }
        body.push_str(&line);
    }
    (title, body.trim_end().to_owned())
}

/// A day as `YYYY-MM-DD` (UTC) from ms since the epoch.
pub fn day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Ms since the epoch at the start of a `YYYY-MM-DD` day (UTC), or of a full RFC 3339 time.
pub fn parse_day(text: &str) -> Option<i64> {
    let text = text.trim();
    let date = text.get(..10)?;
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000)
}

/// One topic as the index shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct TopicLine {
    pub topic: String,
    pub entries: usize,
    /// Of those, how many are untrusted: counted, never shown.
    pub untrusted: usize,
    /// Trusted titles, most used and most recent first.
    pub titles: Vec<String>,
    /// How well the topic matches the bot's task and goal (higher first); 0 for none.
    pub relevance: f64,
    /// When its newest entry changed, or was last used.
    pub latest_ms: i64,
}

/// The topic index for the standing instructions: most relevant first, then most recent, up to
/// [`INDEX_TOPICS`] whole lines within [`INDEX_CHARS`], and how many past episodes the bot can
/// search. Only trusted titles are shown; a topic's untrusted entries are counted. Empty when
/// there is neither knowledge nor an episode.
pub fn index(topics: &[TopicLine], episodes: usize) -> String {
    let mut sorted: Vec<&TopicLine> = topics.iter().filter(|t| t.entries > 0).collect();
    sorted.sort_by(|a, b| {
        b.relevance
            .total_cmp(&a.relevance)
            .then_with(|| b.latest_ms.cmp(&a.latest_ms))
            .then_with(|| a.topic.cmp(&b.topic))
    });
    let mut lines = String::new();
    for line in sorted.iter().take(INDEX_TOPICS) {
        let titles: Vec<String> = line
            .titles
            .iter()
            .take(INDEX_TITLES)
            .map(|t| crate::goal::quoted(t, 80))
            .collect();
        let untrusted = match line.untrusted {
            0 => String::new(),
            n => format!(", {n} from untrusted sources"),
        };
        let shown = if titles.is_empty() {
            String::new()
        } else {
            format!(": {}", titles.join("; "))
        };
        let text = format!(
            "- {} ({} entries{untrusted}){shown}\n",
            line.topic, line.entries
        );
        if lines.len() + text.len() > INDEX_CHARS {
            break;
        }
        lines.push_str(&text);
    }
    if lines.is_empty() && episodes == 0 {
        return String::new();
    }
    let mut out = String::from(
        "Knowledge you keep, by topic (yours and your makers'; the person can see and edit it). \
Read entries with knowledge_search before redoing work, and keep findings and decisions with \
knowledge_write:\n<knowledge>\n",
    );
    out.push_str(&lines);
    out.push_str("</knowledge>");
    if episodes > 0 {
        out.push_str(&format!(
            "\nYou have {episodes} past task episodes (what worked, what failed, what it cost); \
episode_search finds ones like the task at hand."
        ));
    }
    out
}

/// The latest `knowledge_indexed` text.
pub fn latest_index(events: &[crate::event::Event]) -> Option<&str> {
    events.iter().rev().find_map(|event| match event {
        crate::event::Event::Known(crate::event::Known::KnowledgeIndexed { text }) => {
            Some(text.as_str())
        }
        _ => None,
    })
}

/// Whether the topic index may be (re)written now: no model call and no index since the
/// conversation began or last compacted, the one point the cached top changes anyway.
pub fn index_due(events: &[crate::event::Event]) -> bool {
    crate::context::top_due(events, |known| {
        matches!(known, crate::event::Known::KnowledgeIndexed { .. })
    })
}

#[cfg(test)]
mod tests;
