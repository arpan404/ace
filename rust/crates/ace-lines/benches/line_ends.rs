//! Microbenchmark for `line_ends` on a JSONL-shaped buffer. The perf gate that decides merges
//! measures through the daemon's API (`packages/native/bench`); this one is for tuning.

use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

fn jsonl(records: usize) -> Vec<u8> {
    let line = br#"{"type":"user","sessionId":"bench","message":{"role":"user","content":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#;
    let mut bytes = Vec::with_capacity(records * (line.len() + 1));
    for _ in 0..records {
        bytes.extend_from_slice(line);
        bytes.push(b'\n');
    }
    bytes
}

fn bench(criterion: &mut Criterion) {
    let bytes = jsonl(100_000);
    let mut group = criterion.benchmark_group("line_ends");
    group.throughput(Throughput::Bytes(
        u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    ));
    group.bench_function("jsonl_100k", |bench| {
        bench.iter(|| ace_lines::line_ends(black_box(&bytes)));
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
