# Host API Reference

NanoVM communicates with the browser through a minimal set of WASM imports and exports.

## WASM Imports (JS → WASM)

These are provided by the JS host when instantiating the WASM module:

| Import | Signature | Purpose |
|--------|-----------|---------|
| `memory` | `WebAssembly.Memory` | Shared linear memory (must be `shared: true`) |
| `console_write` | `(fd: i32, ptr: i32, len: i32)` | Write bytes to stdout/stderr |
| `debug_log` | `(val: i32)` | Debug logging (context-switch tracing, etc.) |
| `abort_js` | `() -> !` | Abort execution (panic handler) |
| `emscripten_random` | `() -> f32` | Random number source for `getrandom` syscall |
| `emscripten_date_now` | `() -> f64` | Wall-clock time in ms for `clock_gettime` and timerfds |

## WASM Exports (WASM → JS)

### VM Lifecycle

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_create` | `(ram_size: i32) -> i32` | Allocate and initialize a VM instance. Returns vm_ptr. |
| `vm_init` | `(vm_ptr, ram_base, ram_size)` | Re-initialize an existing VM with new RAM region |
| `vm_step` | `(vm_ptr, budget) -> i32` | Execute instructions. Returns remaining budget. |
| `vm_load_elf` | `(vm_ptr, elf_offset, elf_size) -> i32` | Load ELF from guest RAM offset. Sets up PC and stack. |
| `vm_load_raw` | `(vm_ptr, data_offset, data_size, load_addr, entry) -> i32` | Load raw binary at address |

### Memory Info

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_ram_ptr` | `(vm_ptr) -> u32` | Guest RAM base address in WASM linear memory |
| `vm_ram_size` | `(vm_ptr) -> u32` | Guest RAM size in bytes |
| `vm_struct_ptr` | `(vm_ptr) -> u32` | VM struct address (same as vm_ptr) |
| `vm_struct_size` | `() -> i32` | VM struct size (12,680 bytes) |
| `vm_exit_code` | `(vm_ptr) -> i32` | Process exit code |

### FS Protocol

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_fs_request_ptr` | `(vm_ptr) -> u32` | Pointer to FsRequest struct (552 bytes) |
| `vm_fs_response_ptr` | `(vm_ptr) -> u32` | Pointer to FsResponse struct (24 bytes) |
| `vm_thread_fs_request_ptr` | `(vm_ptr) -> u32` | Thread FS request (at offset 3972) |
| `vm_thread_fs_response_ptr` | `(vm_ptr) -> u32` | Thread FS response |

### Threading

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_alloc_thread` | `(parent_ptr) -> u32` | Allocate a child VM struct (copy of parent) |
| `vm_thread_step` | `(vm_ptr, budget) -> i32` | Step a thread (same as vm_step) |
| `vm_fork_return` | `(vm_ptr, child_sp, child_tls)` | Set up child thread registers |
| `vm_shared_efd_ptr` | `(vm_ptr) -> u32` | Pointer to shared eventfd AtomicI32 |

### Virtual Server

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_inject_connection` | `(vm_ptr, port, req_ptr, req_len) -> i32` | Inject HTTP request into listening socket. Returns conn_id. |
| `vm_read_response` | `(vm_ptr, conn_id, dst_ptr, dst_len) -> i32` | Read response bytes. >0=data, 0=waiting, -1=done. |
| `vm_close_connection` | `(vm_ptr, conn_id)` | Close virtual connection. |

### Bundled Binaries

| Export | Signature | Purpose |
|--------|-----------|---------|
| `vm_bundled_busybox_ptr` / `_size` | `() -> i32` | BusyBox ELF (feature `busybox`) |
| `vm_bundled_node_ptr` / `_size` | `() -> i32` | Node.js ELF (feature `node`) |
| `vm_bundled_devenv_ptr` / `_size` | `() -> i32` | Devenv tarball (feature `devenv`) |
| `vm_bundled_elf_ptr` / `_size` | `() -> i32` | Legacy: same as busybox |

Returns ptr=0 and size=0 when the feature is not enabled.

### Debug

| Export | Signature | Purpose |
|--------|-----------|---------|
| `debug_pc` | `(vm_ptr) -> u64` | Current program counter |
| `debug_reg` | `(vm_ptr, reg) -> u64` | Register value (0-31) |
| `debug_status` | `(vm_ptr) -> i32` | VM status code |
| `debug_read_guest` | `(vm_ptr, addr) -> u32` | Read 32 bits from guest memory |
| `debug_fault_pc` | `(vm_ptr) -> u64` | PC at last fault |
| `debug_fault_addr` | `(vm_ptr) -> u64` | Address that caused last fault |

### Allocator

| Export | Signature | Purpose |
|--------|-----------|---------|
| `malloc` | `(size: u32) -> u32` | Bump-allocate bytes (8-byte aligned). Returns 0 on failure. |
| `free` | `(ptr: u32)` | No-op (bump allocator never frees) |

## FS_PENDING Protocol

When the VM needs filesystem I/O it cannot handle internally:

1. Rust fills the `FsRequest` struct at `vm_fs_request_ptr(vm_ptr)`:
   - `+0`: syscall_nr (i32)
   - `+4`: fd (i32)
   - `+8`: arg1 (i64)
   - `+16`: arg2 (i64)
   - `+24`: arg3 (i64)
   - `+32`: buf_ptr (u32) — guest address for data transfer
   - `+36`: buf_len (u32)
   - `+40`: path (256 bytes, null-terminated)
   - `+296`: path2 (256 bytes, null-terminated, for rename)

2. Sets `vm.status = 6` (STATUS_FS_PENDING)

3. JS host reads the request, processes it via MemFS, then:
   - Writes the result to the `a0` register: `dv.setBigInt64(vm_ptr + 80, result, true)`
   - Resets status: `dv.setInt32(vm_ptr + 528, 0, true)` (STATUS_OK)

4. JS calls `vm_step()` again to resume execution

## Status Codes

| Value | Name | Meaning |
|-------|------|---------|
| 0 | STATUS_OK | Ready to execute |
| 3 | STATUS_FAULT | Process exited or trapped |
| 6 | STATUS_FS_PENDING | Waiting for JS to handle filesystem request |
| 7 | STATUS_EPOLL_BLOCKED | Event loop has no runnable thread; host sets `a0 = -EINTR` (and lets real time / virtual-server connections advance) before resuming |
| 18 | STATUS_RUNNING | Currently executing |

When `vm_step` returns with `status == 7` (STATUS_EPOLL_BLOCKED), the host writes `-EINTR` (`-4`) to `a0` (`vm_ptr + 80`), resets status to `0`, and calls `vm_step` again — this is how `epoll_pwait` yields to the host so timers fire and injected HTTP connections get accepted.
