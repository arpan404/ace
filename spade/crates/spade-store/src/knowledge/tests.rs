use spade_core::knowledge::{Kind, Relation, SourceKind, TOPIC_GROWS, Trust};

use crate::{NewAgent, NewEpisode, Result, Store, Written};

use super::{EntryChange, NewEntry};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
    let store = Store::open(&dir.path().join("spade.sqlite")).unwrap_or_else(|e| panic!("{e}"));
    for (id, conversation) in [("a1", "c1"), ("a2", "c2")] {
        store
            .create_agent(
                NewAgent {
                    id,
                    kind: "bot",
                    name: id,
                    task: "Work.",
                    avatar: "{}",
                    model: "e/m",
                    conversation,
                },
                &[],
                1,
            )
            .unwrap_or_else(|e| panic!("{e}"));
    }
    (dir, store)
}

fn new<'a>(id: &'a str, agent: &'a str, title: &'a str, body: &'a str) -> NewEntry<'a> {
    NewEntry {
        id,
        agent,
        topic: "deploys",
        title,
        body,
        kind: Kind::Finding,
        source: SourceKind::Bot,
        source_detail: None,
        trust: Trust::Trusted,
        author: Some(agent),
        now_ms: 10,
    }
}

fn counter() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("k_s{n}")
    }
}

fn written(result: Written) -> super::StoredEntry {
    match result {
        Written::New { entry, .. } => entry,
        other => panic!("expected a new entry, got {other:?}"),
    }
}

#[test]
fn an_entry_is_found_by_its_words_in_the_bases_searched_and_written_once() -> Result<()> {
    let (_dir, store) = store();
    let mut ids = counter();
    written(store.write_knowledge(
        new(
            "k_1",
            "a1",
            "Release approvals",
            "Deploys need the release manager's approval",
        ),
        1 << 20,
        &mut ids,
    )?);
    let again = store.write_knowledge(
        new(
            "k_2",
            "a1",
            "Release approvals",
            "Deploys need the release manager's approval.",
        ),
        1 << 20,
        &mut ids,
    )?;
    assert!(
        matches!(again, Written::Exists(ref e) if e.id == "k_1"),
        "{again:?}"
    );
    let mine = vec!["a1".to_owned()];
    let theirs = vec!["a2".to_owned()];
    assert_eq!(store.search_knowledge(&mine, "\"approval\"", 10)?.len(), 1);
    assert!(
        store
            .search_knowledge(&theirs, "\"approval\"", 10)?
            .is_empty()
    );
    // A change is searched by its new words.
    let change = EntryChange {
        body: Some("Deploys wait for a green canary"),
        ..EntryChange::default()
    };
    store.change_knowledge("k_1", &change, None, 20)?;
    assert!(store.search_knowledge(&mine, "\"manager\"", 10)?.is_empty());
    assert_eq!(store.search_knowledge(&mine, "\"canary\"", 10)?.len(), 1);
    Ok(())
}

#[test]
fn a_merge_keeps_both_texts_and_links_and_lowers_trust_to_the_least_trusted() -> Result<()> {
    let (_dir, store) = store();
    let mut ids = counter();
    written(store.write_knowledge(
        new("k_1", "a1", "Canary", "Use a canary"),
        1 << 20,
        &mut ids,
    )?);
    let mut other = new("k_2", "a1", "Canary length", "Canaries run an hour");
    other.trust = Trust::Untrusted;
    written(store.write_knowledge(other, 1 << 20, &mut ids)?);
    written(store.write_knowledge(
        new("k_3", "a1", "Rollback", "Roll back fast"),
        1 << 20,
        &mut ids,
    )?);
    store.link_knowledge("k_3", "k_2", Relation::Supports)?;
    let merged = store
        .merge_knowledge("k_1", &["k_2".to_owned()], 30)?
        .unwrap_or_else(|| panic!("merged"));
    assert!(merged.body.contains("Use a canary") && merged.body.contains("Canaries run an hour"));
    assert_eq!(merged.trust, Trust::Untrusted);
    assert!(store.knowledge_entry("k_2")?.is_none());
    let links = store.knowledge_links("k_1")?;
    assert_eq!(links.len(), 1);
    assert_eq!((links[0].other.as_str(), links[0].outgoing), ("k_3", false));
    Ok(())
}

#[test]
fn a_full_base_folds_old_bot_entries_and_refuses_when_only_the_persons_are_left() -> Result<()> {
    let (_dir, store) = store();
    let mut ids = counter();
    let long = "word ".repeat(300);
    let mut person = new("p_1", "a1", "The person's rule", &long);
    person.author = None;
    person.source = SourceKind::Person;
    person.now_ms = 1;
    written(store.write_knowledge(person, 1 << 20, &mut ids)?);
    for i in 0..6 {
        let id = format!("k_{i}");
        let title = format!("Finding {i}");
        let mut entry = new(&id, "a1", &title, &long);
        entry.now_ms = 2 + i;
        written(store.write_knowledge(entry, 1 << 20, &mut ids)?);
    }
    let limit = store.knowledge_bytes("a1")?;
    let incoming = new("k_new", "a1", "Newest", &long);
    let Written::New { folded, .. } = store.write_knowledge(incoming, limit, &mut ids)? else {
        panic!("expected room by folding");
    };
    assert!(folded >= 2);
    assert!(store.knowledge_bytes("a1")? <= limit);
    assert!(
        store.knowledge_entry("p_1")?.is_some(),
        "the person's entry stays"
    );
    assert!(
        store.knowledge_entry("k_0")?.is_none(),
        "the oldest bot entry folded"
    );
    let digest = store
        .knowledge("a1", Some("deploys"))?
        .into_iter()
        .find(|e| e.kind == Kind::Summary)
        .unwrap_or_else(|| panic!("a digest"));
    assert!(digest.body.contains("Finding 0"));
    // Only the person's entry: nothing may fold, so nothing is lost and the write is refused.
    let (_dir2, alone) = store_pair();
    let mut theirs = new("p_1", "a1", "Theirs", &long);
    theirs.author = None;
    written(alone.write_knowledge(theirs, 1 << 20, &mut ids)?);
    let bound = alone.knowledge_bytes("a1")?;
    let refused = alone.write_knowledge(new("k_x", "a1", "More", "anything"), bound, &mut ids)?;
    assert_eq!(refused, Written::Full);
    assert!(alone.knowledge_entry("p_1")?.is_some());
    Ok(())
}

fn store_pair() -> (tempfile::TempDir, Store) {
    store()
}

#[test]
fn a_topic_past_its_bound_is_folded_into_a_digest() -> Result<()> {
    let (_dir, store) = store();
    let mut ids = counter();
    for i in 0..=TOPIC_GROWS {
        let id = format!("k_{i:03}");
        let title = format!("Distinct finding number {i}");
        let body = format!("Observation {i} about item{i} and thing{i}");
        let mut entry = new(&id, "a1", &title, &body);
        entry.now_ms = i as i64;
        written(store.write_knowledge(entry, 1 << 30, &mut ids)?);
    }
    let topic = store.knowledge("a1", Some("deploys"))?;
    assert!(
        topic.len() <= spade_core::knowledge::TOPIC_KEEPS,
        "{}",
        topic.len()
    );
    assert!(topic.iter().any(|e| e.kind == Kind::Summary));
    assert!(
        topic.iter().any(|e| e.id == format!("k_{TOPIC_GROWS:03}")),
        "the newest stays"
    );
    Ok(())
}

#[test]
fn a_goal_keeps_one_episode_found_by_its_words() -> Result<()> {
    let (_dir, store) = store();
    let episode = |id| NewEpisode {
        id,
        agent: "a1",
        conversation: "c1",
        goal: "g1",
        title: "Ship the release",
        outcome: "verified",
        body: "{}",
        text: "Ship the release. Worked: canary deploy",
        untrusted: false,
        cost_micros: 5,
        started_ms: 1,
        closed_ms: 2,
    };
    let (first, new) = store.save_episode(episode("e_1"))?;
    assert!(new);
    let (again, new) = store.save_episode(episode("e_2"))?;
    assert!(!new);
    assert_eq!(again.id, first.id);
    let mine = vec!["a1".to_owned()];
    assert_eq!(store.episodes(&mine, Some("\"canary\""), 10)?.len(), 1);
    assert!(
        store
            .episodes(&mine, Some("\"kubernetes\""), 10)?
            .is_empty()
    );
    assert_eq!(store.count_episodes(&mine)?, 1);
    store.record_spend("c1", "m", 7, 5)?;
    store.record_spend("c1", "m", 9, 50)?;
    assert_eq!(store.spent_between("c1", 1, 10)?, 7);
    Ok(())
}

#[test]
fn past_text_is_found_by_date_oldest_first_including_compaction_summaries() -> Result<()> {
    use spade_core::event::{Event, Known};
    let (_dir, store) = store();
    let day = 86_400_000;
    store.append(
        "c1",
        &Event::user_message("migrate the billing tables"),
        day,
    )?;
    store.append(
        "c1",
        &Event::Known(Known::ContextCompacted {
            summary: "Billing migration planned; tables listed".into(),
            keep_from: 1,
            tokens_before: 0,
            images_left_out: None,
            untrusted: false,
            carried: None,
        }),
        20 * day,
    )?;
    store.append("c1", &Event::user_message("billing again"), 30 * day)?;
    let window = |since_ms, until_ms, oldest_first| crate::HistoryWindow {
        since_ms,
        until_ms,
        oldest_first,
    };
    let all = store.search_history_in("c1", "\"billing\"", window(None, None, true), 10)?;
    assert_eq!(all.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(all[0].at_ms, day);
    let day_one =
        store.search_history_in("c1", "\"billing\"", window(None, Some(2 * day), false), 10)?;
    assert_eq!(day_one.len(), 1);
    let later =
        store.search_history_in("c1", "\"planned\"", window(Some(10 * day), None, false), 10)?;
    assert_eq!(later.len(), 1, "a past summary is searched");
    Ok(())
}
