// SPDX-License-Identifier: Apache-2.0
//! Bounded I/O shell. Codec decisions and pixels stay outside the calling thread.
use crate::*;
use std::{
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle, ThreadId},
};

#[derive(Clone, Copy)]
pub struct WorkerLimits {
    pub physical_cores: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
}
pub type WorkerClock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type StillFactory = Arc<dyn Fn() -> Box<dyn StillCodec> + Send + Sync>;
struct Job {
    id: u64,
    input: PooledBuffer,
    output: PooledBuffer,
    target: Size,
    quality: u8,
    deadline_us: u64,
}
pub struct StillResult {
    pub stages_us: Option<[u64; 3]>,
    pub id: u64,
    pub thread: ThreadId,
    pub data: Result<PooledBuffer, CodecError>,
}
pub struct RejectedStill {
    pub error: CodecError,
    pub input: PooledBuffer,
}
pub struct StillWorkers {
    inputs: BufferPool,
    outputs: BufferPool,
    senders: Vec<SyncSender<Job>>,
    results: Receiver<StillResult>,
    handles: Vec<JoinHandle<()>>,
    next: usize,
}
impl StillWorkers {
    /// M7 supplies physical core count and its own monotonic microsecond clock.
    pub fn new(limits: WorkerLimits, now: WorkerClock) -> Result<Self, CodecError> {
        Self::with_factory(limits, now, Arc::new(|| Box::<CpuJpegCodec>::default()))
    }
    pub fn with_factory(
        limits: WorkerLimits,
        now: WorkerClock,
        factory: StillFactory,
    ) -> Result<Self, CodecError> {
        let count = limits.physical_cores.saturating_sub(1).clamp(1, 8);
        let inputs = BufferPool::new(count * 2, limits.input_bytes)?;
        let outputs = BufferPool::new(count * 2, limits.output_bytes)?;
        let (result_tx, results) = mpsc::sync_channel(count * 2);
        let mut pool = Self {
            inputs,
            outputs,
            senders: Vec::with_capacity(count),
            results,
            handles: Vec::with_capacity(count),
            next: 0,
        };
        for index in 0..count {
            let (tx, rx) = mpsc::sync_channel::<Job>(1);
            let result_tx = result_tx.clone();
            let now = Arc::clone(&now);
            let factory = Arc::clone(&factory);
            let handle = thread::Builder::new()
                .name(format!("media-still-{index}"))
                .spawn(move || {
                    let mut codec = factory();
                    while let Ok(mut job) = rx.recv() {
                        let started = now();
                        let mut stages = [None; 3];
                        let result = if now() >= job.deadline_us {
                            Err(CodecError::DeadlineExceeded)
                        } else {
                            codec.transcode_observed(
                                job.input.as_slice(),
                                job.target,
                                job.quality,
                                job.output.output(),
                                &mut |stage| {
                                    let index = match stage {
                                        StillStage::Decoded => 0,
                                        StillStage::Scaled => 1,
                                        StillStage::Encoded => 2,
                                    };
                                    stages[index] = Some(now());
                                },
                            )
                        };
                        drop(job.input);
                        let stages_us = match stages {
                            [Some(d), Some(s), Some(e)] => Some([
                                d.saturating_sub(started),
                                s.saturating_sub(d),
                                e.saturating_sub(s),
                            ]),
                            _ => None,
                        };
                        let data = result.and_then(|()| {
                            if now() >= job.deadline_us {
                                Err(CodecError::DeadlineExceeded)
                            } else {
                                Ok(job.output)
                            }
                        });
                        if result_tx
                            .send(StillResult {
                                stages_us,
                                id: job.id,
                                thread: thread::current().id(),
                                data,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .map_err(|e| CodecError::Backend(e.to_string()))?;
            pool.senders.push(tx);
            pool.handles.push(handle);
        }
        Ok(pool)
    }
    pub fn worker_count(&self) -> usize {
        self.senders.len()
    }
    pub fn try_input(&self) -> Option<PooledBuffer> {
        self.inputs.try_acquire()
    }
    /// On rejection the caller retains the source buffer and may retry.
    pub fn try_submit(
        &mut self,
        id: u64,
        input: PooledBuffer,
        target: Size,
        quality: u8,
        deadline_us: u64,
    ) -> Result<(), RejectedStill> {
        if let Err(error) = target.validate() {
            return Err(RejectedStill { error, input });
        }
        let Some(output) = self.outputs.try_acquire() else {
            return Err(RejectedStill {
                error: CodecError::Backpressure,
                input,
            });
        };
        if libjpeg_turbo_rs::jpeg_buf_size(
            target.width as usize,
            target.height as usize,
            libjpeg_turbo_rs::Subsampling::S420,
        ) > output.capacity()
        {
            return Err(RejectedStill {
                error: CodecError::InvalidInput("JPEG exceeds output pool capacity".into()),
                input,
            });
        }
        let mut job = Job {
            id,
            input,
            output,
            target,
            quality,
            deadline_us,
        };
        for offset in 0..self.senders.len() {
            let index = (self.next + offset) % self.senders.len();
            match self.senders[index].try_send(job) {
                Ok(()) => {
                    self.next = (index + 1) % self.senders.len();
                    return Ok(());
                }
                Err(TrySendError::Full(returned) | TrySendError::Disconnected(returned)) => {
                    job = returned
                }
            }
        }
        Err(RejectedStill {
            error: CodecError::Backpressure,
            input: job.input,
        })
    }
    pub fn recv(&self) -> Result<StillResult, CodecError> {
        self.results
            .recv()
            .map_err(|_| CodecError::Backend("still workers stopped".into()))
    }
    pub fn try_recv(&self) -> Result<Option<StillResult>, CodecError> {
        match self.results.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(CodecError::Backend("still workers stopped".into()))
            }
        }
    }
}
impl Drop for StillWorkers {
    fn drop(&mut self) {
        // At most two jobs per worker exist because every job leases an output.
        // The completion queue holds all of them, so joining cannot await a reader.
        self.senders.clear();
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}
