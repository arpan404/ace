// SPDX-License-Identifier: Apache-2.0
use crate::CodecError;
use std::sync::{Arc, Mutex};

struct Storage {
    buffers: Mutex<Vec<Vec<u8>>>,
    capacity: usize,
}
#[derive(Clone)]
pub struct BufferPool {
    storage: Arc<Storage>,
}
pub struct PooledBuffer {
    storage: Arc<Storage>,
    data: Vec<u8>,
}
impl BufferPool {
    pub fn new(count: usize, capacity: usize) -> Result<Self, CodecError> {
        if count == 0 || capacity == 0 {
            return Err(CodecError::InvalidInput("empty buffer pool".into()));
        }
        Ok(Self {
            storage: Arc::new(Storage {
                buffers: Mutex::new((0..count).map(|_| Vec::with_capacity(capacity)).collect()),
                capacity,
            }),
        })
    }
    /// Exhaustion is backpressure; it never creates another buffer.
    pub fn try_acquire(&self) -> Option<PooledBuffer> {
        let data = self
            .storage
            .buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop()?;
        Some(PooledBuffer {
            storage: Arc::clone(&self.storage),
            data,
        })
    }
}
impl PooledBuffer {
    pub fn set(&mut self, bytes: &[u8]) -> Result<(), CodecError> {
        if bytes.len() > self.storage.capacity {
            return Err(CodecError::InvalidInput(
                "input exceeds pooled capacity".into(),
            ));
        }
        self.data.clear();
        self.data.extend_from_slice(bytes);
        Ok(())
    }
    pub fn capacity(&self) -> usize {
        self.storage.capacity
    }
    pub fn as_slice(&self) -> &[u8] {
        &self.data
    }
    pub(crate) fn output(&mut self) -> &mut Vec<u8> {
        &mut self.data
    }
}
impl Drop for PooledBuffer {
    fn drop(&mut self) {
        self.data.clear();
        self.storage
            .buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(std::mem::take(&mut self.data));
    }
}
