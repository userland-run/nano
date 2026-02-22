# Web Demo

The demo is a browser-based IDE that runs Node.js and BusyBox inside the RISC-V emulator. It has a three-panel layout: file tree, code editor, and console/preview output.

## Stack

```
┌─────────────────────────────────────────────────┐
│                  Browser Tab                     │
│  ┌──────────┬──────────────┬──────────────────┐ │
│  │ FileTree │   Editor     │ Console/Preview  │ │
│  │          │ (CodeMirror) │                  │ │
│  └──────────┴──────────────┴──────────────────┘ │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │   runtime.ts   │ Singleton VM     │
│              └───────┬────────┘                  │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │  nanovm.mjs    │ WASM + MemFS     │
│              │  (container/)  │                  │
│              └───────┬────────┘                  │
│                      │                           │
│              ┌───────▼────────┐                  │
│              │   nano.wasm    │ RV64 Emulator    │
│              └────────────────┘                  │
│                                                  │
│  ┌─ Service Worker (sw.js) ──────────────────┐  │
│  │ Intercepts /sw/PORT/path → injects into   │  │
│  │ VM sockets via sw-bridge.ts               │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Directory Structure

```
web/demo/
├── index.html
├── public/
│   ├── nano.wasm            ← copied by `make demo`
│   └── sw.js                ← Service Worker
├── src/
│   ├── App.tsx              ← Main app (VM init, file open, run/stop)
│   ├── main.tsx             ← Entry point
│   ├── App.css              ← Styles
│   ├── types.ts             ← TypeScript interfaces
│   ├── components/
│   │   ├── TopBar.tsx       ← Runtime selector, command input, run/stop
│   │   ├── FileTree.tsx     ← VFS directory browser
│   │   ├── Editor.tsx       ← CodeMirror editor with save
│   │   ├── Preview.tsx      ← Console output + iframe preview
│   │   └── Terminal.tsx     ← ANSI-aware terminal output
│   └── vm/
│       ├── runtime.ts       ← Singleton VM management
│       ├── examples.ts      ← Example files seeded into VFS
│       └── sw-bridge.ts     ← Service Worker ↔ VM bridge
├── vite.config.ts
└── tsconfig.json

container/                   ← Shared between demo and tests
├── nanovm.mjs               ← Browser NanoVM class
└── memfs.mjs                ← In-memory POSIX filesystem
```

## How It Works

### Startup

1. `App.tsx` calls `ensureVM()` which creates a `NanoVM` instance
2. NanoVM fetches `nano.wasm`, instantiates it, creates a VM with 512MB RAM
3. Bundled ELFs (busybox, node) are detected and loaded from the WASM data section
4. If the devenv tarball is bundled, it's extracted into the VFS
5. Example files from `examples.ts` are written into the VFS at `/examples/`
6. The Service Worker is registered for HTTP preview support

### Running Code

When the user clicks "Run":

1. `App.tsx` determines the runtime: `node script.js` or BusyBox command
2. For Node.js: `runtime.runNode(args, { onStdout, maxSteps })` which calls `vm.node(...args)`
3. The NanoVM wrapper:
   - Resets the VM struct to clean state
   - Copies the ELF binary into guest RAM
   - Calls `vm_load_elf` to parse segments and set up PC/stack
   - Calls `_setupArgv` to write argv/envp/auxv
   - Enters the execution loop: `vm_step(budget)` in batches
4. On `STATUS_FS_PENDING`: processes filesystem request via MemFS
5. On stdout write: `console_write` import fires `onStdout` callback → React state update
6. Every 50 iterations: `await setTimeout(0)` yields to browser event loop

### HTTP Preview (Virtual Server)

For examples that start an HTTP server:

1. Node.js calls `socket()` → `bind(port)` → `listen()` → `accept()` (all handled internally by Rust)
2. The console output "listening on port 8080" triggers the preview iframe to load `/sw/8080/`
3. The Service Worker intercepts this request:
   - Serializes it as raw HTTP: `GET / HTTP/1.1\r\nHost: localhost:8080\r\n\r\n`
   - Posts to the main page via `MessageChannel`
4. `sw-bridge.ts` receives the message, calls `vm.virtualServer.injectConnection(8080, rawHttp)`
5. The `VirtualServer` class:
   - Writes request bytes into WASM scratch buffer
   - Calls `vm_inject_connection(vm_ptr, port, ptr, len)` — creates a socket pair, queues on accept
   - Returns a Promise for the response
6. The execution loop polls `vm_read_response()` between steps
7. When the server closes the connection: response bytes are collected, Promise resolves
8. `sw-bridge.ts` parses the HTTP response and sends it back to the Service Worker
9. The iframe receives the HTML page

### Vite Configuration

- Base path: `/nano/` (for deployment)
- `@container` alias → `container/` at project root
- COOP/COEP headers for SharedArrayBuffer support
- CodeMirror chunked separately for caching

## Examples

The demo includes three categories of examples:

- **01-basic** — hello world, argv/env, filesystem, path/url, timers
- **02-advanced** — streams, crypto hashing, Buffer operations, EventEmitter
- **03-real-apps** — HTTP server with preview, REST API with routing, React SPA
