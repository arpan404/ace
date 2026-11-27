use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct FakePorts {
    sources: Mutex<Option<Vec<String>>>,
    computes: AtomicUsize,
    sources_calls: AtomicUsize,
    keep: bool,
    now: i64,
}

impl ConfigPorts for FakePorts {
    fn sources(
        &self,
        _call: u64,
        _cwd: &str,
        _env_json: &str,
    ) -> crate::core::spawn::BoxFuture<'_, Option<Vec<String>>> {
        self.sources_calls.fetch_add(1, Ordering::SeqCst);
        let sources = self.sources.lock().ok().and_then(|sources| sources.clone());
        Box::pin(std::future::ready(sources))
    }
    fn compute(&self, _call: u64) -> crate::core::spawn::BoxFuture<'_, Result<Value, GitError>> {
        let count = self.computes.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(std::future::ready(Ok(Value::from(
            format!("v{count}").as_str(),
        ))))
    }
    fn keep(&self, _call: u64, _value: &Value) -> crate::core::spawn::BoxFuture<'_, bool> {
        Box::pin(std::future::ready(self.keep))
    }
    fn now_ms(&self, _call: u64) -> crate::core::spawn::BoxFuture<'_, i64> {
        Box::pin(std::future::ready(self.now))
    }
}

/// The injected clock: an hour ahead, so a test file's ctime (which userspace cannot set)
/// is already older than the settle window, exactly as a checkout that has been quiet.
fn fake_now() -> i64 {
    now() + 3_600_000
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// A source file `age_ms` old, so its stamp either has or has not settled.
fn source(name: &str, age_ms: i64) -> String {
    let path = std::env::temp_dir().join(format!(
        "ace-g2c-facts-{}-{name}-{}",
        std::process::id(),
        now()
    ));
    std::fs::write(&path, "config\n").expect("source");
    let stamp = std::time::UNIX_EPOCH
        + std::time::Duration::from_millis((fake_now() - age_ms).max(0) as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .and_then(|file| file.set_modified(stamp))
        .expect("mtime");
    path.to_string_lossy().into_owned()
}

fn facts(file: &str, keep: bool) -> (Arc<ConfigFacts>, Arc<FakePorts>) {
    let ports = Arc::new(FakePorts {
        sources: Mutex::new(Some(vec![file.to_owned()])),
        computes: AtomicUsize::new(0),
        sources_calls: AtomicUsize::new(0),
        keep,
        now: fake_now(),
    });
    (Arc::new(ConfigFacts::new(ports.clone())), ports)
}

#[tokio::test]
async fn an_unchanged_checkout_keeps_its_fact() {
    let file = source("kept", 10_000);
    let (facts, ports) = facts(&file, true);
    // The first call learns the sources after computing, so its value is not kept yet.
    facts.read(1, "/wt", &[], "root").await.expect("first");
    let second = facts.read(1, "/wt", &[], "root").await.expect("second");
    let third = facts.read(1, "/wt", &[], "root").await.expect("kept");
    assert_eq!(second, third);
    assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
    assert_eq!(ports.sources_calls.load(Ordering::SeqCst), 1);
    std::fs::remove_file(&file).ok();
}

#[tokio::test]
async fn a_changed_source_forgets_the_fact() {
    let file = source("changed", 10_000);
    let (facts, ports) = facts(&file, true);
    facts.read(1, "/wt", &[], "root").await.expect("first");
    std::fs::write(&file, "config\nuser.name = another\n").expect("write");
    let second = facts.read(1, "/wt", &[], "root").await.expect("second");
    assert_eq!(second, Value::from("v2"));
    assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
    std::fs::remove_file(&file).ok();
}

#[tokio::test]
async fn sources_that_have_not_settled_are_not_kept() {
    let file = source("fresh", 0);
    let (facts, ports) = facts(&file, true);
    facts.read(1, "/wt", &[], "root").await.expect("first");
    facts.read(1, "/wt", &[], "root").await.expect("second");
    assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
    std::fs::remove_file(&file).ok();
}

#[tokio::test]
async fn a_owner_that_says_no_is_not_kept() {
    let file = source("unkept", 10_000);
    let (facts, ports) = facts(&file, false);
    facts.read(1, "/wt", &[], "root").await.expect("first");
    facts.read(1, "/wt", &[], "root").await.expect("second");
    assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
    std::fs::remove_file(&file).ok();
}

#[tokio::test]
async fn the_oldest_checkout_is_evicted_beyond_the_capacity() {
    let file = source("evict", 10_000);
    let (facts, ports) = facts(&file, true);
    facts.read(1, "/wt/0", &[], "root").await.expect("first");
    let kept = facts.read(1, "/wt/0", &[], "root").await.expect("kept");
    for index in 1..=CAPACITY {
        facts
            .read(1, &format!("/wt/{index}"), &[], "root")
            .await
            .expect("each");
    }
    // The first checkout fell out of the cache and is computed again.
    let refreshed = facts.read(1, "/wt/0", &[], "root").await.expect("again");
    assert_ne!(refreshed, kept);
    std::fs::remove_file(&file).ok();
    assert!(ports.computes.load(Ordering::SeqCst) >= CAPACITY + 2);
}
