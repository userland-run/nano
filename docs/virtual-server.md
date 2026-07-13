# Virtual Server

> The virtual server belongs to the **RISC-V runner** — one of NanoVM's four execution tiers.
> See [Architecture](architecture.md) for how the runners fit together.

The virtual server bridges HTTP requests from the browser into the VM's internal socket layer, allowing Node.js HTTP servers running inside the emulator to serve pages in a preview iframe.

## Overview

```
Preview iframe                Service Worker              Main page
     │                              │                         │
     │  GET /sw/8080/               │                         │
     ├─────────────────────────────►│                         │
     │                              │  postMessage(rawHTTP)   │
     │                              ├────────────────────────►│
     │                              │                         │ sw-bridge.ts
     │                              │                         │ vm.virtualServer
     │                              │                         │   .injectConnection(8080, rawHTTP)
     │                              │                         │
     │                              │                         ▼
     │                              │                   ┌───────────┐
     │                              │                   │ nanovm.mjs│
     │                              │                   │           │
     │                              │                   │ 1. Write request bytes to scratch buf
     │                              │                   │ 2. vm_inject_connection(port, ptr, len)
     │                              │                   │ 3. VM executes → server processes request
     │                              │                   │ 4. vm_read_response() polls for data
     │                              │                   │ 5. Response Promise resolves
     │                              │                   └─────┬─────┘
     │                              │  postMessage(response)  │
     │                              │◄────────────────────────┤
     │  HTTP Response               │                         │
     │◄─────────────────────────────┤                         │
```

## WASM Exports

Three exports in `runners/riscv/src/exports.rs` provide the low-level socket injection:

### `vm_inject_connection(vm_ptr, port, req_ptr, req_len) -> conn_id`

1. Finds the listening socket on `port` (scans SOCKETS array)
2. Allocates two socket slots: **server-side** and **client-side**
3. Connects them as peers (`peer_idx` points to each other)
4. Copies HTTP request bytes from `req_ptr` into server-side's recv buffer
5. Pushes server-side index onto the listening socket's accept queue
6. Wakes any thread blocked in `epoll_pwait`
7. Returns client-side index as `conn_id`

When the Node.js server calls `accept()`, it pops the server-side socket from the queue. Reading from it returns the HTTP request bytes. Writing to it puts data into the client-side recv buffer.

### `vm_read_response(vm_ptr, conn_id, dst_ptr, dst_len) -> n`

Reads from the client-side socket's recv buffer (where the server wrote the response):
- `n > 0`: copied `n` bytes to `dst_ptr`
- `n = 0`: no data yet (server still processing)
- `n = -1`: server closed its end (response complete)

### `vm_close_connection(vm_ptr, conn_id)`

Marks both sides as `SOCK_SHUTDOWN` so the server sees EOF.

## JS Implementation

### VirtualServer class (`runners/riscv/host/nanovm.mjs`)

```js
class VirtualServer {
  async injectConnection(port, httpRequest) {
    // httpRequest is a raw HTTP string from the Service Worker:
    // "GET / HTTP/1.1\r\nHost: localhost:8080\r\n\r\n"

    const requestBytes = new TextEncoder().encode(httpRequest);
    mem.set(requestBytes, vm._scratchPtr);

    const connId = exports.vm_inject_connection(vmPtr, port, scratchPtr, len);

    // Returns Promise that resolves when response is complete
    return new Promise(resolve => {
      vm._pendingConnections.push({ connId, resolve, responseChunks: [] });
    });
  }
}
```

### Polling loop

`_pollConnections()` is called between `vm_step()` iterations in the execution loop:

```js
_pollConnections() {
  for (each pending connection) {
    const n = exports.vm_read_response(vmPtr, connId, scratchPtr, 16384);
    if (n > 0) conn.responseChunks.push(copy of bytes);
    if (n === -1) {
      // Concatenate chunks, resolve Promise
      exports.vm_close_connection(vmPtr, connId);
      conn.resolve(fullResponse);
    }
  }
}
```

### Service Worker

The SW intercepts requests matching `/sw/PORT/path`:

1. Extracts port and path from the URL
2. Serializes the full HTTP request (method, headers, body) as a raw string
3. Sends to the main page via `MessageChannel`
4. Waits for response (30s timeout)
5. Injects COOP/COEP headers on the response for iframe compatibility

Sub-requests from the iframe (e.g., `<script src="/app.js">`) are also intercepted by checking the referrer URL for the `/sw/PORT/` prefix.

## Socket Internals

The socket system in `runners/riscv/src/syscall.rs` uses a static array of 32 socket slots:

```rust
struct SocketSlot {
    state: u8,           // FREE, CREATED, BOUND, LISTENING, CONNECTED, SHUTDOWN
    local_port: u16,
    peer_idx: i32,       // Index of connected peer (-1 if none)
    guest_fd: i32,       // Guest file descriptor
    accept_queue: [i32; 8],  // Pending connection indices
    recv_buf: [u8; 16384],   // 16KB ring buffer
    recv_head: u32,
    recv_tail: u32,
}
```

Data flow for a connected pair (A ↔ B):
- Writing to A puts bytes in B's `recv_buf` (via `peer_idx`)
- Reading from B consumes bytes from B's `recv_buf`
- `epoll_pwait` checks `recv_tail > recv_head` for EPOLLIN readiness
