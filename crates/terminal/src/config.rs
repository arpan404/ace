use std::time::Duration;

pub(crate) const MIN_COLS: u16 = 20;
pub(crate) const MAX_COLS: u16 = 400;
pub(crate) const MIN_ROWS: u16 = 5;
pub(crate) const MAX_ROWS: u16 = 200;
pub(crate) const DEFAULT_COLS: u16 = 120;
pub(crate) const DEFAULT_ROWS: u16 = 30;
pub(crate) const MAX_TERMINAL_ID: usize = 128;
pub(crate) const MAX_THREAD_ID: usize = 256;
pub(crate) const MAX_ENV_KEYS: usize = 128;
pub(crate) const MAX_ENV_KEY: usize = 128;
pub(crate) const MAX_ENV_VALUE: usize = 8_192;
pub(crate) const MAX_WRITE_BYTES: usize = 65_536;

const DEFAULT_HISTORY_LINES: usize = 5_000;
const DEFAULT_HISTORY_BYTES: usize = 1_000_000;
const DEFAULT_EVENT_REPLAY: usize = 2_048;
const DEFAULT_WRITE_QUEUE: usize = 256;
const DEFAULT_CONTROL_QUEUE: usize = 64;
const DEFAULT_OUTPUT_BATCH_BYTES: usize = 32 * 1024;
const DEFAULT_OUTPUT_BATCH_DELAY: Duration = Duration::from_millis(8);

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub history_line_limit: usize,
    pub history_byte_limit: usize,
    pub event_replay_limit: usize,
    pub write_queue_limit: usize,
    pub control_queue_limit: usize,
    pub output_batch_bytes: usize,
    pub output_batch_delay: Duration,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            history_line_limit: DEFAULT_HISTORY_LINES,
            history_byte_limit: DEFAULT_HISTORY_BYTES,
            event_replay_limit: DEFAULT_EVENT_REPLAY,
            write_queue_limit: DEFAULT_WRITE_QUEUE,
            control_queue_limit: DEFAULT_CONTROL_QUEUE,
            output_batch_bytes: DEFAULT_OUTPUT_BATCH_BYTES,
            output_batch_delay: DEFAULT_OUTPUT_BATCH_DELAY,
        }
    }
}
