//! A terminal's scrollback (ADR 0142): its output as numbered chunks, the oldest dropped once
//! the whole passes a byte bound, so a viewer joining late (or coming back with `after`) sees the
//! recent screen without Spade keeping a terminal's whole history.

use std::collections::VecDeque;

/// How much output each terminal keeps for viewers.
pub const SCROLLBACK: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct Ring {
    chunks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    bound: usize,
    /// The next chunk's number. Numbers only grow, across a terminal's restarts too.
    next: u64,
}

impl Ring {
    /// Numbers start at `first`: a time-derived start keeps them growing across Spade restarts,
    /// so a viewer's `after` from before a restart never hides new output.
    pub fn new(bound: usize, first: u64) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            bound: bound.max(1),
            next: first.max(1),
        }
    }

    /// Keeps `data` and answers its number. A chunk larger than the bound keeps its tail.
    pub fn push(&mut self, data: &[u8]) -> u64 {
        let data = if data.len() > self.bound {
            &data[data.len() - self.bound..]
        } else {
            data
        };
        let seq = self.next;
        self.next += 1;
        self.bytes += data.len();
        self.chunks.push_back((seq, data.to_vec()));
        while self.bytes > self.bound {
            match self.chunks.pop_front() {
                Some((_, old)) => self.bytes -= old.len(),
                None => break,
            }
        }
        seq
    }

    /// Every chunk kept with a number above `after`, oldest first.
    pub fn after(&self, after: u64) -> Vec<(u64, Vec<u8>)> {
        self.chunks
            .iter()
            .filter(|(seq, _)| *seq > after)
            .cloned()
            .collect()
    }

    /// The bytes kept.
    pub fn len(&self) -> usize {
        self.bytes
    }

    pub fn is_empty(&self) -> bool {
        self.bytes == 0
    }

    /// The number the next chunk will get.
    pub fn next(&self) -> u64 {
        self.next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_keeps_the_newest_output_within_its_bound() {
        let mut ring = Ring::new(10, 1);
        for chunk in [b"aaaa", b"bbbb", b"cccc"] {
            ring.push(chunk);
        }
        assert!(ring.len() <= 10);
        let kept: Vec<u8> = ring.after(0).into_iter().flat_map(|(_, d)| d).collect();
        assert_eq!(kept, b"bbbbcccc");
        ring.push(&[b'z'; 25]);
        assert_eq!(ring.after(0), vec![(4, vec![b'z'; 10])]);
    }

    #[test]
    fn a_viewer_coming_back_gets_only_what_it_missed() {
        let mut ring = Ring::new(100, 500);
        let first = ring.push(b"one");
        ring.push(b"two");
        assert_eq!(ring.after(first), vec![(501, b"two".to_vec())]);
        // A number from before a restart is older than everything kept now.
        assert_eq!(ring.after(3).len(), 2);
    }
}
