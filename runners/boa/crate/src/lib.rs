//! nano-boa — the Boa JavaScript engine packaged as nano's `boa.wasm` scripting
//! component. See `specs/nano/scripting-layer.md`.
//!
//! This module is the **C-style ABI** the JS loader (`container/boa.mjs`) drives.
//! Values cross the boundary as UTF-8 JSON; pointers are 32-bit (wasm32). Every
//! string an export returns is a buffer allocated here and reclaimed by the host
//! via [`boa_free`]; every string the host hands in (sources, names, results) is
//! allocated by the host via [`boa_alloc`] and owned by it, except the reply to
//! `host_call`, whose buffer we take ownership of.
//!
//! Layout of the ABI mirrors the spec's §3.2 table, adapted to raw wasm:
//! string returns are packed as `(ptr << 32) | len` in a `u64`.

mod host;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use boa_engine::builtins::promise::ResolvingFunctions;
use boa_engine::gc::GcRefCell;
use boa_engine::object::builtins::JsPromise;
use boa_engine::property::Attribute;
use boa_engine::{
    js_string, Context, Finalize, JsData, JsError, JsNativeError, JsValue, NativeFunction, Source,
    Trace,
};

use host::{HostClock, HostHooksImpl, HostLogger};

// ---------------------------------------------------------------------------
// ABI version & build identity
// ---------------------------------------------------------------------------

/// Bumped on any incompatible change to the export/import contract below.
const ABI_VERSION: u32 = 1;
const WRAPPER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// Per-context state held across host calls (GC-safe via host-defined data)
// ---------------------------------------------------------------------------

/// Registry of in-flight async host calls and the settled top-level result for
/// one context. Stored inside the [`Context`] as host-defined data so the GC
/// traces the promise resolvers it holds (a plain side-table would let them be
/// collected mid-flight).
#[derive(Trace, Finalize, JsData)]
struct Pending {
    /// Monotonic id source for async host calls.
    #[unsafe_ignore_trace]
    next_id: Cell<u32>,
    /// `promise_id -> resolvers` for async calls awaiting `boa_resolve`/`boa_reject`.
    map: GcRefCell<Vec<(u32, ResolvingFunctions)>>,
    /// Settled top-level eval result envelope (`{ok, value|error}`), once known.
    #[unsafe_ignore_trace]
    result: RefCell<Option<serde_json::Value>>,
}

impl Pending {
    fn new() -> Self {
        Self {
            next_id: Cell::new(1),
            map: GcRefCell::new(Vec::new()),
            result: RefCell::new(None),
        }
    }
}

thread_local! {
    /// Live contexts keyed by the handle handed back from `boa_context_create`.
    static CTXS: RefCell<HashMap<u32, Context>> = RefCell::new(HashMap::new());
    /// Next context handle (never 0; 0 is the error sentinel).
    static NEXT_CTX: Cell<u32> = const { Cell::new(1) };
}

/// Run `f` with mutable access to the context behind `handle`, or return
/// `default` if the handle is unknown.
fn with_ctx<R>(handle: u32, default: R, f: impl FnOnce(&mut Context) -> R) -> R {
    CTXS.with(|cell| {
        let mut map = cell.borrow_mut();
        match map.get_mut(&handle) {
            Some(ctx) => f(ctx),
            None => default,
        }
    })
}

// ---------------------------------------------------------------------------
// Memory & string marshalling
// ---------------------------------------------------------------------------

fn layout(len: usize) -> std::alloc::Layout {
    // align 1 keeps alloc/free symmetric with `Vec<u8>::from_raw_parts` reclaim.
    std::alloc::Layout::from_size_align(len.max(1), 1).expect("layout")
}

/// Allocate `len` bytes in our linear memory for the host to write into.
#[no_mangle]
pub extern "C" fn boa_alloc(len: usize) -> *mut u8 {
    unsafe { std::alloc::alloc(layout(len)) }
}

/// Free a buffer previously returned by `boa_alloc` (or by a string-returning export).
#[no_mangle]
pub extern "C" fn boa_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { std::alloc::dealloc(ptr, layout(len)) }
    }
}

/// Pack a `(ptr, len)` pair into the `u64` string-return convention.
fn pack(ptr: *const u8, len: usize) -> u64 {
    ((ptr as u32 as u64) << 32) | (len as u32 as u64)
}

/// Unpack a `u64` produced by the host's `host_call` reply.
fn unpack(v: u64) -> (*mut u8, usize) {
    (((v >> 32) as u32) as *mut u8, (v & 0xffff_ffff) as usize)
}

/// Copy `s` into a freshly allocated buffer and return it packed. The host reads
/// it and calls `boa_free`.
fn return_string(s: String) -> u64 {
    let bytes = s.into_bytes();
    let len = bytes.len();
    if len == 0 {
        return 0;
    }
    let ptr = boa_alloc(len);
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len) };
    pack(ptr, len)
}

/// View a host-provided buffer as `&str` (caller guarantees lifetime/validity).
unsafe fn read_str<'a>(ptr: *const u8, len: usize) -> &'a str {
    if ptr.is_null() || len == 0 {
        return "";
    }
    std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len))
}

// ---------------------------------------------------------------------------
// JSON <-> JsValue
// ---------------------------------------------------------------------------

/// Convert a `JsValue` to JSON, falling back to its string form for values JSON
/// can't represent (functions, symbols, BigInt, cycles).
fn jsval_to_json(v: &JsValue, ctx: &mut Context) -> serde_json::Value {
    match v.to_json(ctx) {
        Ok(Some(json)) => json,
        Ok(None) => serde_json::Value::Null,
        Err(_) => match v.to_string(ctx) {
            Ok(s) => serde_json::Value::String(s.to_std_string_escaped()),
            Err(_) => serde_json::Value::Null,
        },
    }
}

/// Serialize a JS argument list as a JSON array string for a host call.
fn args_to_json(args: &[JsValue], ctx: &mut Context) -> String {
    let arr: Vec<serde_json::Value> = args.iter().map(|a| jsval_to_json(a, ctx)).collect();
    serde_json::Value::Array(arr).to_string()
}

/// `{ok, pending, value|error}` envelope as a JSON string.
fn envelope(ok: bool, pending: bool, value: Option<serde_json::Value>, error: Option<String>) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("ok".into(), serde_json::Value::Bool(ok));
    obj.insert("pending".into(), serde_json::Value::Bool(pending));
    if let Some(v) = value {
        obj.insert("value".into(), v);
    }
    if let Some(e) = error {
        obj.insert("error".into(), serde_json::Value::String(e));
    }
    serde_json::Value::Object(obj).to_string()
}

// ---------------------------------------------------------------------------
// Host-function bridge (native globals that call back into the host)
// ---------------------------------------------------------------------------

/// Build a synchronous host-function global: serialize args, call `host_call`,
/// return the marshalled value (or throw on `{error}`).
fn make_sync_fn(fn_id: u32) -> NativeFunction {
    NativeFunction::from_copy_closure(move |_this, args, ctx| {
        let args_json = args_to_json(args, ctx);
        let packed = unsafe { host::host_call(fn_id, args_json.as_ptr(), args_json.len()) };
        let (ptr, len) = unpack(packed);
        let reply: serde_json::Value = if ptr.is_null() || len == 0 {
            serde_json::Value::Null
        } else {
            // Take ownership of the host-allocated reply buffer and free it on drop.
            let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        if let Some(err) = reply.get("error") {
            let msg = err.as_str().map(str::to_owned).unwrap_or_else(|| err.to_string());
            return Err(JsNativeError::typ().with_message(msg).into());
        }
        let val = reply.get("value").cloned().unwrap_or(serde_json::Value::Null);
        JsValue::from_json(&val, ctx)
    })
}

/// Build an asynchronous host-function global: create a pending promise, hand
/// the host its id via `host_call_async`, and return the promise to the script.
fn make_async_fn(fn_id: u32) -> NativeFunction {
    NativeFunction::from_copy_closure(move |_this, args, ctx| {
        let args_json = args_to_json(args, ctx);
        let (promise, resolvers) = JsPromise::new_pending(ctx);
        let id = {
            let reg = ctx
                .get_data::<Pending>()
                .ok_or_else(|| JsNativeError::typ().with_message("scripting: no pending registry"))?;
            let id = reg.next_id.get();
            reg.next_id.set(id.wrapping_add(1));
            reg.map.borrow_mut().push((id, resolvers));
            id
        };
        unsafe { host::host_call_async(fn_id, args_json.as_ptr(), args_json.len(), id) };
        Ok(JsValue::from(promise))
    })
}

/// Native `.then`/`.catch` handler that records the settled top-level result.
fn make_result_handler(is_ok: bool) -> NativeFunction {
    NativeFunction::from_copy_closure(move |_this, args, ctx| {
        let val = args.first().cloned().unwrap_or(JsValue::undefined());
        let env = if is_ok {
            let json = jsval_to_json(&val, ctx);
            serde_json::json!({ "ok": true, "value": json })
        } else {
            let msg = val
                .to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_else(|_| "rejected".to_string());
            serde_json::json!({ "ok": false, "error": msg })
        };
        if let Some(reg) = ctx.get_data::<Pending>() {
            *reg.result.borrow_mut() = Some(env);
        }
        Ok(JsValue::undefined())
    })
}

// ---------------------------------------------------------------------------
// Exports — the ABI
// ---------------------------------------------------------------------------

/// `{ engine, wrapper, abi }` identity string. The loader asserts compatibility.
#[no_mangle]
pub extern "C" fn boa_version() -> u64 {
    let s = serde_json::json!({
        "engine": "boa_engine 0.21",
        "wrapper": WRAPPER_VERSION,
        "abi": ABI_VERSION,
    })
    .to_string();
    return_string(s)
}

/// Create a context. `config_json` (optional) selects WebAPIs and runtime limits:
/// `{ "webapis": ["console","encoding","url","timers"], "limits": { "loopIterations": N, "recursion": N } }`.
/// Returns a handle ≥ 1, or 0 on failure.
#[no_mangle]
pub extern "C" fn boa_context_create(config_ptr: *const u8, config_len: usize) -> u32 {
    let cfg: serde_json::Value = {
        let s = unsafe { read_str(config_ptr, config_len) };
        serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
    };

    let mut ctx = match Context::builder()
        .clock(Rc::new(HostClock))
        .host_hooks(Rc::new(HostHooksImpl))
        .build()
    {
        Ok(c) => c,
        Err(_) => return 0,
    };

    // Runtime limits (bound runaway scripts).
    if let Some(limits) = cfg.get("limits") {
        if let Some(n) = limits.get("loopIterations").and_then(serde_json::Value::as_u64) {
            ctx.runtime_limits_mut().set_loop_iteration_limit(n);
        }
        if let Some(n) = limits.get("recursion").and_then(serde_json::Value::as_u64) {
            ctx.runtime_limits_mut().set_recursion_limit(n as usize);
        }
    }

    // WebAPIs (opt-in; default to console only when unspecified).
    let has = |name: &str| -> bool {
        match cfg.get("webapis").and_then(serde_json::Value::as_array) {
            Some(arr) => arr.iter().any(|v| v.as_str() == Some(name)),
            None => name == "console",
        }
    };
    if has("console") && boa_runtime::Console::register_with_logger(HostLogger, &mut ctx).is_err() {
        return 0;
    }
    if has("encoding")
        && boa_runtime::register_extensions(boa_runtime::extensions::EncodingExtension, None, &mut ctx).is_err()
    {
        return 0;
    }
    if has("url")
        && boa_runtime::register_extensions(boa_runtime::extensions::UrlExtension, None, &mut ctx).is_err()
    {
        return 0;
    }
    if has("timers")
        && boa_runtime::register_extensions(
            (
                boa_runtime::extensions::TimeoutExtension,
                boa_runtime::extensions::MicrotaskExtension,
            ),
            None,
            &mut ctx,
        )
        .is_err()
    {
        return 0;
    }

    // Attach the per-context async/result registry.
    ctx.insert_data(Pending::new());

    let handle = NEXT_CTX.with(|n| {
        let h = n.get();
        n.set(h.wrapping_add(1).max(1));
        h
    });
    CTXS.with(|c| c.borrow_mut().insert(handle, ctx));
    handle
}

/// Dispose a context and free its heap.
#[no_mangle]
pub extern "C" fn boa_context_dispose(ctx: u32) {
    CTXS.with(|c| {
        c.borrow_mut().remove(&ctx);
    });
}

/// Define a plain-data global from JSON.
#[no_mangle]
pub extern "C" fn boa_define_global(
    ctx: u32,
    name_ptr: *const u8,
    name_len: usize,
    value_ptr: *const u8,
    value_len: usize,
) -> u32 {
    let name = unsafe { read_str(name_ptr, name_len) }.to_owned();
    let value_json: serde_json::Value = {
        let s = unsafe { read_str(value_ptr, value_len) };
        serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
    };
    with_ctx(ctx, 0, |ctx| {
        let val = match JsValue::from_json(&value_json, ctx) {
            Ok(v) => v,
            Err(_) => return 0,
        };
        match ctx.register_global_property(js_string!(name.as_str()), val, Attribute::all()) {
            Ok(()) => 1,
            Err(_) => 0,
        }
    })
}

/// Bind a global function `name` to host callback `fn_id`. `is_async != 0`
/// makes it return a promise settled later via `boa_resolve`/`boa_reject`.
#[no_mangle]
pub extern "C" fn boa_register_host_fn(
    ctx: u32,
    name_ptr: *const u8,
    name_len: usize,
    fn_id: u32,
    is_async: u32,
) -> u32 {
    let name = unsafe { read_str(name_ptr, name_len) }.to_owned();
    with_ctx(ctx, 0, |ctx| {
        let nf = if is_async != 0 {
            make_async_fn(fn_id)
        } else {
            make_sync_fn(fn_id)
        };
        match ctx.register_global_builtin_callable(js_string!(name.as_str()), 0, nf) {
            Ok(()) => 1,
            Err(_) => 0,
        }
    })
}

/// Parse and evaluate `source`. Returns an `{ok, pending, value|error}` envelope.
/// When `pending` is true the result is a promise; pump with `boa_run_jobs`,
/// settle async calls, and read it with `boa_take_result`.
#[no_mangle]
pub extern "C" fn boa_eval(ctx: u32, source_ptr: *const u8, source_len: usize) -> u64 {
    let src = unsafe { read_str(source_ptr, source_len) }.to_owned();
    let out = with_ctx(ctx, envelope(false, false, None, Some("invalid context".into())), |ctx| {
        match ctx.eval(Source::from_bytes(src.as_bytes())) {
            Err(e) => envelope(false, false, None, Some(e.to_string())),
            Ok(value) => settle_or_pending(ctx, value),
        }
    });
    return_string(out)
}

/// If `value` is a promise, attach result handlers and report `pending`;
/// otherwise marshal it as the settled result.
fn settle_or_pending(ctx: &mut Context, value: JsValue) -> String {
    if let Some(obj) = value.as_object() {
        if let Ok(promise) = JsPromise::from_object(obj) {
            let on_f = make_result_handler(true).to_js_function(ctx.realm());
            let on_r = make_result_handler(false).to_js_function(ctx.realm());
            promise.then(Some(on_f), Some(on_r), ctx);
            return envelope(true, true, None, None);
        }
    }
    let json = jsval_to_json(&value, ctx);
    envelope(true, false, Some(json), None)
}

/// Evaluate `source` as an ES module. The module's evaluation is a promise, so
/// this always reports `pending`; drive it like an async `boa_eval`.
#[no_mangle]
pub extern "C" fn boa_eval_module(
    ctx: u32,
    source_ptr: *const u8,
    source_len: usize,
    specifier_ptr: *const u8,
    specifier_len: usize,
) -> u64 {
    let src = unsafe { read_str(source_ptr, source_len) }.to_owned();
    let specifier = unsafe { read_str(specifier_ptr, specifier_len) }.to_owned();
    let out = with_ctx(ctx, envelope(false, false, None, Some("invalid context".into())), |ctx| {
        let path = std::path::Path::new(if specifier.is_empty() { "<script>" } else { specifier.as_str() });
        let module = match boa_engine::Module::parse(Source::from_bytes(src.as_bytes()).with_path(path), None, ctx) {
            Ok(m) => m,
            Err(e) => return envelope(false, false, None, Some(e.to_string())),
        };
        let promise = module.load_link_evaluate(ctx);
        let on_f = make_result_handler(true).to_js_function(ctx.realm());
        let on_r = make_result_handler(false).to_js_function(ctx.realm());
        promise.then(Some(on_f), Some(on_r), ctx);
        envelope(true, true, None, None)
    });
    return_string(out)
}

/// Drive the microtask/job queue. Returns the count of async host calls still
/// awaiting settlement (0 = the engine is quiescent on its own).
#[no_mangle]
pub extern "C" fn boa_run_jobs(ctx: u32) -> u32 {
    with_ctx(ctx, 0, |ctx| {
        let _ = ctx.run_jobs();
        ctx.get_data::<Pending>()
            .map(|p| p.map.borrow().len() as u32)
            .unwrap_or(0)
    })
}

/// Read the settled top-level result. Returns `{"ready":false}` until settled,
/// then `{"ready":true, ok, value|error}`.
#[no_mangle]
pub extern "C" fn boa_take_result(ctx: u32) -> u64 {
    let out = with_ctx(ctx, r#"{"ready":false}"#.to_string(), |ctx| {
        let settled = ctx
            .get_data::<Pending>()
            .and_then(|p| p.result.borrow_mut().take());
        match settled {
            None => r#"{"ready":false}"#.to_string(),
            Some(mut env) => {
                if let Some(obj) = env.as_object_mut() {
                    obj.insert("ready".into(), serde_json::Value::Bool(true));
                }
                env.to_string()
            }
        }
    });
    return_string(out)
}

/// Resolve a pending host promise with `{"value": ..}`.
#[no_mangle]
pub extern "C" fn boa_resolve(ctx: u32, promise_id: u32, value_ptr: *const u8, value_len: usize) {
    let payload: serde_json::Value = {
        let s = unsafe { read_str(value_ptr, value_len) };
        serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
    };
    let value = payload.get("value").cloned().unwrap_or(serde_json::Value::Null);
    with_ctx(ctx, (), |ctx| {
        let resolvers = take_resolvers(ctx, promise_id);
        if let Some(r) = resolvers {
            if let Ok(val) = JsValue::from_json(&value, ctx) {
                let _ = r.resolve.call(&JsValue::undefined(), &[val], ctx);
            }
        }
    });
}

/// Reject a pending host promise with `{"error": "message"}`.
#[no_mangle]
pub extern "C" fn boa_reject(ctx: u32, promise_id: u32, error_ptr: *const u8, error_len: usize) {
    let payload: serde_json::Value = {
        let s = unsafe { read_str(error_ptr, error_len) };
        serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
    };
    let msg = payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("rejected")
        .to_owned();
    with_ctx(ctx, (), |ctx| {
        if let Some(r) = take_resolvers(ctx, promise_id) {
            let err = JsError::from_native(JsNativeError::error().with_message(msg)).to_opaque(ctx);
            let _ = r.reject.call(&JsValue::undefined(), &[err.into()], ctx);
        }
    });
}

/// Remove and return the resolvers for `promise_id`, if present.
fn take_resolvers(ctx: &mut Context, promise_id: u32) -> Option<ResolvingFunctions> {
    let reg = ctx.get_data::<Pending>()?;
    let mut map = reg.map.borrow_mut();
    let pos = map.iter().position(|(id, _)| *id == promise_id)?;
    Some(map.swap_remove(pos).1)
}
