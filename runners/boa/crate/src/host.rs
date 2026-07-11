//! The host boundary: the imports `boa.wasm` calls back into, plus the small
//! adapters (entropy backend, clock, timezone hook, console logger) that route
//! engine needs through those imports.
//!
//! Everything here is `unsafe extern` glue; the safe, high-level ABI lives in
//! `lib.rs`.

use boa_engine::context::time::{Clock, JsInstant};
use boa_engine::context::HostHooks;
use boa_engine::{Context, Finalize, JsResult, Trace};
use boa_runtime::{ConsoleState, Logger};

// Stream ids handed to `host_write`, matching POSIX fds.
pub const STREAM_STDOUT: u32 = 1;
pub const STREAM_STDERR: u32 = 2;

extern "C" {
    /// Fill `len` bytes at `ptr` with entropy (browser crypto / Node crypto).
    pub fn host_random(ptr: *mut u8, len: usize);

    /// Current wall-clock time, milliseconds since the Unix epoch.
    pub fn host_now_millis() -> f64;

    /// Local timezone offset east of UTC, in seconds, for the given Unix time.
    pub fn host_tz_offset(unix_secs: f64) -> i32;

    /// Synchronous host-function call. `args_json` is a JSON array of arguments;
    /// the return is a packed `(ptr<<32)|len` of a JSON object `{"value":..}` or
    /// `{"error":".."}` allocated in our memory by the host via `boa_alloc`.
    /// We take ownership of that buffer and free it.
    pub fn host_call(fn_id: u32, args_ptr: *const u8, args_len: usize) -> u64;

    /// Asynchronous host-function call. The host performs the work off-thread and
    /// later settles the promise via `boa_resolve`/`boa_reject` with `promise_id`.
    pub fn host_call_async(fn_id: u32, args_ptr: *const u8, args_len: usize, promise_id: u32);

    /// Console / log output. `stream` is `STREAM_STDOUT` or `STREAM_STDERR`.
    pub fn host_write(stream: u32, ptr: *const u8, len: usize);
}

/// getrandom 0.3 custom backend — every bit of engine randomness (Math.random,
/// hash seeds, ...) flows through the host's CSPRNG.
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    if len != 0 {
        host_random(dest, len);
    }
    Ok(())
}

/// Write a line to a host stream (used by the console logger).
pub fn write_line(stream: u32, msg: &str) {
    // One allocation; append the newline the console implies.
    let mut buf = String::with_capacity(msg.len() + 1);
    buf.push_str(msg);
    buf.push('\n');
    unsafe { host_write(stream, buf.as_ptr(), buf.len()) };
}

/// Clock backed by `host_now_millis`, replacing Boa's default `std::time` clock
/// (which panics on `wasm32-unknown-unknown`).
#[derive(Debug, Clone, Copy, Default)]
pub struct HostClock;

impl Clock for HostClock {
    fn now(&self) -> JsInstant {
        let millis = unsafe { host_now_millis() };
        let millis = if millis.is_finite() && millis >= 0.0 {
            millis as u64
        } else {
            0
        };
        JsInstant::new(millis / 1000, ((millis % 1000) * 1_000_000) as u32)
    }
}

/// Host hooks. We only need the local-timezone offset (Date local time); the
/// rest keep Boa's defaults. `utc_now` is deprecated and unused — Date reads the
/// clock above.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostHooksImpl;

impl HostHooks for HostHooksImpl {
    fn local_timezone_offset_seconds(&self, unix_time_seconds: i64) -> i32 {
        unsafe { host_tz_offset(unix_time_seconds as f64) }
    }
}

/// Console logger that routes `console.*` to `host_write`, splitting normal
/// output (log/info → stdout) from diagnostics (warn/error → stderr).
#[derive(Debug, Default, Trace, Finalize)]
pub struct HostLogger;

impl Logger for HostLogger {
    fn log(&self, msg: String, _: &ConsoleState, _: &mut Context) -> JsResult<()> {
        write_line(STREAM_STDOUT, &msg);
        Ok(())
    }
    fn info(&self, msg: String, _: &ConsoleState, _: &mut Context) -> JsResult<()> {
        write_line(STREAM_STDOUT, &msg);
        Ok(())
    }
    fn warn(&self, msg: String, _: &ConsoleState, _: &mut Context) -> JsResult<()> {
        write_line(STREAM_STDERR, &msg);
        Ok(())
    }
    fn error(&self, msg: String, _: &ConsoleState, _: &mut Context) -> JsResult<()> {
        write_line(STREAM_STDERR, &msg);
        Ok(())
    }
}
