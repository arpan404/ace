use ace_protocol::terminal::TerminalEvent;
use ace_terminal::{SequencedTerminalEvent, TerminalConfig};
use criterion::{Criterion, criterion_group, criterion_main};

fn bench_history_append(c: &mut Criterion) {
    let config = TerminalConfig::default();
    let chunk = "building crate\n".repeat(128);
    c.bench_function("terminal_history_append_bounded", |b| {
        b.iter(|| {
            let mut history = String::new();
            for _ in 0..256 {
                ace_terminal::append_bounded_history(&mut history, &chunk, &config);
            }
            history.len()
        });
    });
}

fn bench_event_serialization(c: &mut Criterion) {
    let event = SequencedTerminalEvent {
        sequence: 42,
        event: TerminalEvent::Output {
            thread_id: "thread-1".to_string(),
            terminal_id: "default".to_string(),
            created_at: "now".to_string(),
            data: "x".repeat(32 * 1024),
        },
    };
    c.bench_function("terminal_event_serialize_32kb", |b| {
        b.iter(|| serde_json::to_string(&event).expect("serialize"))
    });
}

criterion_group!(
    terminal_perf,
    bench_history_append,
    bench_event_serialization
);
criterion_main!(terminal_perf);
