// SPDX-License-Identifier: Apache-2.0
use media_codec::*;
use std::{collections::HashSet, sync::Arc};
fn tiny_jpeg() -> Result<Vec<u8>, CodecError> {
    let p = CpuPicture::new(
        Size {
            width: 32,
            height: 16,
        },
        PixelFormat::Rgb8,
        vec![Plane {
            data: vec![120; 32 * 16 * 3],
            stride: 96,
        }],
        0,
    )?;
    CpuJpegCodec::default().encode(&p, 80)
}
#[test]
fn leased_buffers_bound_memory_and_are_recycled_after_release() -> Result<(), CodecError> {
    let pool = BufferPool::new(1, 16)?;
    let mut first = pool.try_acquire().ok_or(CodecError::Backpressure)?;
    first.set(b"private frame")?;
    assert!(first.set(&[0; 17]).is_err());
    assert!(pool.try_acquire().is_none());
    drop(first);
    let mut next = pool.try_acquire().ok_or(CodecError::Backpressure)?;
    assert!(next.as_slice().is_empty());
    next.set(b"new")?;
    assert_eq!(next.as_slice(), b"new");
    Ok(())
}
#[test]
fn jobs_run_on_separate_fixed_workers_and_keep_their_identity() -> Result<(), CodecError> {
    let jpeg = tiny_jpeg()?;
    let mut pool = StillWorkers::new(
        WorkerLimits {
            physical_cores: 4,
            input_bytes: 8192,
            output_bytes: 8192,
        },
        Arc::new(|| 0),
    )?;
    let mut threads = HashSet::new();
    for id in 0..3 {
        let mut input = pool.try_input().ok_or(CodecError::Backpressure)?;
        input.set(&jpeg)?;
        pool.try_submit(
            id,
            input,
            Size {
                width: 16,
                height: 8,
            },
            80,
            1,
        )
        .map_err(|r| r.error)?;
    }
    let mut ids = HashSet::new();
    for _ in 0..3 {
        let result = pool.recv()?;
        assert_ne!(result.thread, std::thread::current().id());
        threads.insert(result.thread);
        ids.insert(result.id);
        assert_eq!(
            CpuJpegCodec::default()
                .decode(result.data?.as_slice())?
                .size(),
            Size {
                width: 16,
                height: 8
            }
        );
    }
    assert_eq!(threads.len(), 3);
    assert_eq!(ids, HashSet::from([0, 1, 2]));
    Ok(())
}
#[test]
fn deadlines_and_codec_errors_are_reported_and_buffers_return_to_the_pool() -> Result<(), CodecError>
{
    let mut pool = StillWorkers::new(
        WorkerLimits {
            physical_cores: 1,
            input_bytes: 8192,
            output_bytes: 8192,
        },
        Arc::new(|| 10),
    )?;
    for (id, deadline) in [(1, 5), (2, 20)] {
        let mut input = pool.try_input().ok_or(CodecError::Backpressure)?;
        input.set(b"not jpeg")?;
        pool.try_submit(
            id,
            input,
            Size {
                width: 16,
                height: 8,
            },
            80,
            deadline,
        )
        .map_err(|r| r.error)?;
        let result = pool.recv()?;
        assert_eq!(result.id, id);
        if id == 1 {
            assert!(matches!(result.data, Err(CodecError::DeadlineExceeded)));
        } else {
            assert!(matches!(result.data, Err(CodecError::InvalidInput(_))));
        }
    }
    assert!(pool.try_input().is_some());
    Ok(())
}
