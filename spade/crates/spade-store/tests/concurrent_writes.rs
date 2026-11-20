//! Writes through several connections to one real SQLite file, as Spade's server makes them:
//! a store write that reads first waits for another connection's write, never fails at once.

use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use spade_store::{Store, StoredEndpoint, StoredModel};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;

fn endpoint(id: &str) -> StoredEndpoint {
    StoredEndpoint {
        id: id.to_owned(),
        name: id.to_owned(),
        format: "openai-chat".to_owned(),
        base_url: "http://127.0.0.1:9".to_owned(),
        headers: Vec::new(),
        session_header: None,
        needs_key: false,
        key_env: None,
        preset: None,
        created_ms: 1,
        models: Vec::new(),
    }
}

fn model(id: &str) -> StoredModel {
    StoredModel {
        id: id.to_owned(),
        name: None,
        context: None,
        capabilities: None,
        source: "typed".to_owned(),
    }
}

#[test]
fn a_write_that_reads_first_waits_for_another_connections_write_and_then_succeeds() -> Result {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("spade.sqlite");
    let store = Store::open(&path)?;
    store.insert_endpoint(&endpoint("e_1"))?;

    let held = Duration::from_millis(300);
    let (locked, on_locked) = mpsc::channel();
    let holder = thread::spawn({
        let path = path.clone();
        move || -> std::result::Result<(), String> {
            let mut other = Store::connect(&path).map_err(|e| e.to_string())?;
            let tx = other.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('held', 'yes')",
                [],
            )
            .map_err(|e| e.to_string())?;
            locked.send(()).map_err(|e| e.to_string())?;
            thread::sleep(held);
            tx.commit().map_err(|e| e.to_string())
        }
    });
    on_locked.recv()?;

    // `put_model` reads that its endpoint exists, then writes the model.
    let started = Instant::now();
    assert!(
        store.put_model("e_1", &model("m_1"))?,
        "the endpoint is there"
    );
    let waited = started.elapsed();
    holder.join().map_err(|_| "the holder panicked")??;

    assert!(
        waited >= held / 2,
        "it waited for the other write ({waited:?}), not went ahead of it"
    );
    let saved = store.endpoints()?;
    assert_eq!(saved[0].models, vec![model("m_1")]);
    assert_eq!(store.setting("held")?.as_deref(), Some("yes"));
    Ok(())
}

#[test]
fn stores_on_one_file_writing_at_once_all_succeed() -> Result {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("spade.sqlite");
    Store::open(&path)?.insert_endpoint(&endpoint("e_1"))?;
    // The server opens one store per part (engine, connectors, skills...), all on one file.
    let stores: Vec<Arc<Store>> = (0..4)
        .map(|_| Store::open(&path).map(Arc::new))
        .collect::<std::result::Result<_, _>>()?;
    let writers: Vec<_> = stores
        .iter()
        .enumerate()
        .map(|(n, store)| {
            let store = store.clone();
            thread::spawn(move || -> std::result::Result<(), String> {
                for i in 0..50 {
                    store
                        .put_model("e_1", &model(&format!("m_{n}_{i}")))
                        .map_err(|e| format!("store {n} write {i}: {e}"))?;
                }
                Ok(())
            })
        })
        .collect();
    for writer in writers {
        writer.join().map_err(|_| "a writer panicked")??;
    }
    let saved = stores[0].endpoints()?;
    assert_eq!(saved[0].models.len(), 4 * 50, "every write landed");
    Ok(())
}
