// SPDX-License-Identifier: Apache-2.0
//! Retention: closed identifiers are replay hints, not an archive.

use std::collections::{HashMap, HashSet, VecDeque};

use ace_json::Value;

/// At most 1024 ids; re-add moves to the end.
pub struct RecentSet {
    order: VecDeque<String>,
    present: HashSet<String>,
}

impl RecentSet {
    pub fn new() -> Self {
        Self {
            order: VecDeque::new(),
            present: HashSet::new(),
        }
    }

    pub fn add(&mut self, value: String) {
        if self.present.contains(&value) {
            self.order.retain(|entry| entry != &value);
        } else {
            self.present.insert(value.clone());
        }
        self.order.push_back(value);
        while self.order.len() > 1024 {
            if let Some(oldest) = self.order.pop_front() {
                self.present.remove(&oldest);
            }
        }
    }

    pub fn delete(&mut self, value: &str) -> bool {
        if self.present.remove(value) {
            self.order.retain(|entry| entry != value);
            true
        } else {
            false
        }
    }

    pub fn has(&self, value: &str) -> bool {
        self.present.contains(value)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

impl Default for RecentSet {
    fn default() -> Self {
        Self::new()
    }
}

struct BufferedFrame {
    seq: usize,
    data: Value,
    bytes: usize,
}

struct ThreadBuffer {
    frames: VecDeque<BufferedFrame>,
    lost: bool,
}

/// Raw facts precede buffering; eviction keeps one guard until a scan.
pub struct UnknownBuffers {
    threads: HashMap<String, ThreadBuffer>,
    bytes: usize,
    count: usize,
    order: VecDeque<(String, usize)>,
    next_seq: usize,
    overflow: bool,
}

impl UnknownBuffers {
    pub fn new() -> Self {
        Self {
            threads: HashMap::new(),
            bytes: 0,
            count: 0,
            order: VecDeque::new(),
            next_seq: 0,
            overflow: false,
        }
    }

    pub fn pending(&self) -> usize {
        self.threads.len()
    }

    pub fn is_overflow(&self) -> bool {
        self.overflow
    }

    pub fn clear(&mut self) {
        self.threads.clear();
        self.bytes = 0;
        self.count = 0;
        self.order.clear();
        self.overflow = false;
    }

    fn frame_bytes(data: &Value) -> usize {
        match ace_json::ser::to_string(data) {
            Ok(text) => text.encode_utf16().count() * 2,
            Err(_) => 0,
        }
    }

    fn forget(&mut self, id: &str, seq: usize, bytes: usize, lost: bool) {
        self.bytes = self.bytes.saturating_sub(bytes);
        self.count = self.count.saturating_sub(1);
        if let Some(thread) = self.threads.get_mut(id) {
            if let Some(pos) = thread.frames.iter().position(|f| f.seq == seq) {
                thread.frames.remove(pos);
            }
            if lost {
                thread.lost = true;
            }
        }
    }

    pub fn push(&mut self, id: String, data: Value) {
        if !self.threads.contains_key(&id) {
            if self.threads.len() >= 256
                && let Some(oldest) = self.threads.keys().next().map(|key| key.to_string())
            {
                if let Some(thread) = self.threads.remove(&oldest) {
                    for frame in thread.frames {
                        self.bytes = self.bytes.saturating_sub(frame.bytes);
                        self.count = self.count.saturating_sub(1);
                    }
                    self.order.retain(|(tid, _)| tid != &oldest);
                }
                self.overflow = true;
            }
            let lost = self.overflow;
            self.threads.insert(
                id.clone(),
                ThreadBuffer {
                    frames: VecDeque::new(),
                    lost,
                },
            );
        }
        let size = Self::frame_bytes(&data);
        if size > 64 * 1024 {
            if let Some(thread) = self.threads.get_mut(&id) {
                thread.lost = true;
            }
            return;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        if let Some(thread) = self.threads.get_mut(&id) {
            thread.frames.push_back(BufferedFrame {
                seq,
                data,
                bytes: size,
            });
            if thread.frames.len() > 64
                && let Some(old) = thread.frames.pop_front()
            {
                thread.lost = true;
                self.bytes = self.bytes.saturating_sub(old.bytes);
                self.count = self.count.saturating_sub(1);
                self.order.retain(|(tid, s)| !(tid == &id && *s == old.seq));
            }
        }
        self.bytes += size;
        self.count += 1;
        self.order.push_back((id, seq));
        while self.bytes > 512 * 1024 || self.count > 256 {
            let front = self.order.pop_front();
            match front {
                Some((tid, s)) => {
                    let bytes = self
                        .threads
                        .get(&tid)
                        .and_then(|t| t.frames.iter().find(|f| f.seq == s))
                        .map(|f| f.bytes)
                        .unwrap_or(0);
                    self.forget(&tid, s, bytes, true);
                    if self.order.is_empty() {
                        break;
                    }
                }
                None => break,
            }
        }
    }

    pub fn take(&mut self, id: &str) -> (Vec<Value>, bool) {
        let overflow = self.overflow;
        match self.threads.remove(id) {
            Some(thread) => {
                for frame in &thread.frames {
                    self.bytes = self.bytes.saturating_sub(frame.bytes);
                    self.count = self.count.saturating_sub(1);
                }
                self.order.retain(|(tid, _)| tid != id);
                let frames: Vec<Value> = thread.frames.into_iter().map(|f| f.data).collect();
                (frames, thread.lost)
            }
            None => (Vec::new(), overflow),
        }
    }
}

impl Default for UnknownBuffers {
    fn default() -> Self {
        Self::new()
    }
}
