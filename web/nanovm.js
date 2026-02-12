// NanoVM JS Host — WASM loader, import stubs, cooperative scheduler, terminal.
"use strict";

const KERNEL_URL = "kernel-x86_64.bin";
const WASM_URL = "nanovm.wasm";
const RAM_MB = 256;
const BUDGET = 200000; // instructions per timeslice

let wasm = null;
let mem = null;
let HEAPU8 = null;
let running = false;

// Terminal output
const terminal = document.getElementById("terminal");
const statusEl = document.getElementById("status");

function termWrite(str) {
    terminal.textContent += str;
    // Keep last 100K chars to prevent unbounded growth
    if (terminal.textContent.length > 100000) {
        terminal.textContent = terminal.textContent.slice(-80000);
    }
    window.scrollTo(0, document.body.scrollHeight);
}

function setStatus(msg) {
    statusEl.textContent = "NanoVM — " + msg;
}

// Refresh HEAPU8 view after memory.grow
function refreshMem() {
    if (mem && (!HEAPU8 || HEAPU8.buffer !== mem.buffer)) {
        HEAPU8 = new Uint8Array(mem.buffer);
    }
}

// ============================================================
// WASM Import stubs — map to extern "C" declarations in host.rs
// ============================================================
const imports = {
    env: {
        console_write(opaque, buf, len) {
            refreshMem();
            const bytes = HEAPU8.subarray(buf, buf + len);
            const str = new TextDecoder().decode(bytes);
            termWrite(str);
        },
        console_get_size(pw, ph) {
            refreshMem();
            const view = new DataView(mem.buffer);
            view.setUint32(pw, 80, true);
            view.setUint32(ph, 25, true);
        },
        fb_refresh() {},
        net_recv_packet() {},
        fs_export_file() {},
        fs_wget_update_downloading() {},
        file_buffer_init() {},
        file_buffer_read() {},
        file_buffer_write() {},
        file_buffer_resize() { return 0; },
        file_buffer_reset() {},
        file_buffer_set() {},
        emscripten_async_call(func, arg, millis) {
            // Not used in our scheduler — we drive the loop from JS.
            // But keep it functional in case internal code uses it.
            const delay = millis >= 0 ? millis : 0;
            setTimeout(() => {
                if (wasm) {
                    try {
                        wasm.exports.__indirect_function_table.get(func)(arg);
                    } catch (e) {
                        console.error("emscripten_async_call callback error:", e);
                    }
                }
            }, delay);
        },
        emscripten_async_wget3_data() { return 0; },
        emscripten_date_now() { return Date.now(); },
        // Note: u64 params are passed as BigInt in modern WASM
        clock_time_get(clk_id, precision, ptime) {
            refreshMem();
            const now = (clk_id === 0)
                ? BigInt(Math.round(Date.now() * 1e6))
                : BigInt(Math.round(performance.now() * 1e6));
            const view = new DataView(mem.buffer);
            view.setBigUint64(ptime, now, true);
            return 0;
        },
        emscripten_random() { return Math.random(); },
        emscripten_resize_heap(requested) {
            const currentPages = mem.buffer.byteLength / 65536;
            const neededPages = Math.ceil(requested / 65536);
            if (neededPages > currentPages) {
                try {
                    mem.grow(neededPages - currentPages);
                    refreshMem();
                    return 1;
                } catch (e) {
                    console.error("Failed to grow memory:", e);
                    return 0;
                }
            }
            return 1;
        },
        fd_write(fd, iov, iovcnt, pnum) {
            refreshMem();
            const view = new DataView(mem.buffer);
            let num = 0;
            for (let i = 0; i < iovcnt; i++) {
                const ptr = view.getUint32(iov + i * 8, true);
                const len = view.getUint32(iov + i * 8 + 4, true);
                const bytes = HEAPU8.subarray(ptr, ptr + len);
                const str = new TextDecoder().decode(bytes);
                if (fd === 1) console.log(str);
                else console.error(str);
                num += len;
            }
            view.setUint32(pnum, num, true);
            return 0;
        },
        fd_seek() { return 70; },   // ENOSYS
        fd_close() { return 52; },  // ENOSYS
        gmtime_js(time, tm_ptr) {},
        localtime_js(time, tm_ptr) {},
        tzset_js() {},
        abort_js() {
            running = false;
            throw new Error("NanoVM abort");
        },
        assert_fail(cond, file, line, func) {
            console.error("Assertion failed at line", line);
            throw new Error("Assertion failed");
        },
        exit(code) {
            running = false;
            setStatus("Exited with code " + code);
        },
    }
};

// ============================================================
// Boot sequence
// ============================================================
async function boot() {
    try {
        // 1. Load WASM module
        setStatus("Loading WASM...");
        const wasmBytes = await (await fetch(WASM_URL)).arrayBuffer();

        setStatus("Compiling WASM...");
        const result = await WebAssembly.instantiate(wasmBytes, imports);
        wasm = result.instance;
        mem = wasm.exports.memory;
        refreshMem();

        const wasmKB = (wasmBytes.byteLength / 1024).toFixed(1);
        console.log("WASM loaded:", wasmKB, "KB");
        console.log("Exports:", Object.keys(wasm.exports));

        // 2. Load kernel
        setStatus("Fetching kernel (" + KERNEL_URL + ")...");
        const kernelResp = await fetch(KERNEL_URL);
        if (!kernelResp.ok) {
            setStatus("Error: kernel not found (" + KERNEL_URL + "). Place kernel-x86_64.bin in web/");
            termWrite("ERROR: Could not fetch " + KERNEL_URL + "\n");
            termWrite("Place the Linux kernel binary (kernel-x86_64.bin) in the web/ directory.\n");
            termWrite("You can get it from: https://bellard.org/jslinux/\n");
            return;
        }
        const kernelBytes = new Uint8Array(await kernelResp.arrayBuffer());
        const kernelMB = (kernelBytes.byteLength / 1024 / 1024).toFixed(1);
        console.log("Kernel loaded:", kernelMB, "MB");

        // 3. Grow memory for RAM + heap
        const neededBytes = (RAM_MB + 32) * 1024 * 1024; // 32MB overhead for Machine, heap, etc.
        const currentBytes = mem.buffer.byteLength;
        if (currentBytes < neededBytes) {
            const pagesToGrow = Math.ceil((neededBytes - currentBytes) / 65536);
            setStatus("Growing memory (" + pagesToGrow + " pages)...");
            mem.grow(pagesToGrow);
            refreshMem();
        }
        console.log("WASM memory:", (mem.buffer.byteLength / 1024 / 1024).toFixed(1), "MB");

        // 4. Initialize heap (start after WASM data section)
        // __heap_base is exported by the linker — it's the first safe address after
        // static data (which includes MACHINE, HEAP_PTR, HEAP_END globals).
        // Using 0x100000 would overlap the data section and corrupt heap state!
        const HEAP_START = wasm.exports.__heap_base.value;
        const heapSize = mem.buffer.byteLength - HEAP_START;
        console.log("Heap start:", "0x" + HEAP_START.toString(16), "size:", (heapSize / 1024 / 1024).toFixed(1), "MB");
        wasm.exports.vm_init(HEAP_START, heapSize);

        // 5. Initialize machine
        setStatus("Initializing machine...");
        wasm.exports.vm_start(0, RAM_MB, 0, 0, 80, 25, 0, 0);

        // 6. Copy kernel into WASM memory and load it
        setStatus("Loading kernel...");
        const kernelPtr = wasm.exports.malloc(kernelBytes.byteLength);
        if (kernelPtr === 0) {
            setStatus("Error: out of memory allocating kernel buffer");
            return;
        }
        refreshMem();
        HEAPU8.set(kernelBytes, kernelPtr);

        const loadOk = wasm.exports.load_kernel(kernelPtr, kernelBytes.byteLength);
        wasm.exports.free(kernelPtr);

        if (loadOk === 0) {
            setStatus("Error: invalid kernel (not a valid bzImage)");
            termWrite("ERROR: Failed to load kernel — not a valid bzImage format.\n");
            return;
        }

        // 7. Set up keyboard input
        document.addEventListener("keydown", onKeyDown);

        // 8. Start execution
        setStatus("Booting...");
        running = true;
        requestAnimationFrame(step);

    } catch (err) {
        setStatus("Error: " + err.message);
        console.error("Boot failed:", err);
    }
}

// ============================================================
// Cooperative scheduler — runs one timeslice per frame
// ============================================================
function step() {
    if (!running) return;

    try {
        refreshMem();
        const now = Date.now();
        wasm.exports.vm_step(BUDGET, now);
    } catch (err) {
        running = false;
        setStatus("CPU error: " + err.message);
        console.error("Execution error:", err);
        termWrite("\n\n--- VM STOPPED: " + err.message + " ---\n");
        return;
    }

    requestAnimationFrame(step);
}

// ============================================================
// Keyboard input
// ============================================================
function onKeyDown(e) {
    if (!wasm || !running) return;

    let ch = 0;

    if (e.key.length === 1) {
        ch = e.key.charCodeAt(0);
        // Handle Ctrl+key combinations
        if (e.ctrlKey && ch >= 0x61 && ch <= 0x7A) {
            ch -= 0x60; // Ctrl+a=1, Ctrl+c=3, etc.
        } else if (e.ctrlKey && ch >= 0x41 && ch <= 0x5A) {
            ch -= 0x40; // Ctrl+A=1, etc.
        }
    } else {
        // Special keys → VT100 escape sequences
        const qc = (c) => wasm.exports.console_queue_char(c);
        switch (e.key) {
            case "Enter":     ch = 13; break;
            case "Backspace": ch = 127; break; // DEL (most terminals use this for backspace)
            case "Tab":       ch = 9; break;
            case "Escape":    ch = 27; break;
            case "ArrowUp":    qc(27); qc(91); ch = 65; break;
            case "ArrowDown":  qc(27); qc(91); ch = 66; break;
            case "ArrowRight": qc(27); qc(91); ch = 67; break;
            case "ArrowLeft":  qc(27); qc(91); ch = 68; break;
            case "Delete":     qc(27); qc(91); qc(51); ch = 126; break;
            case "Home":       qc(27); qc(91); ch = 72; break;
            case "End":        qc(27); qc(91); ch = 70; break;
            case "PageUp":     qc(27); qc(91); qc(53); ch = 126; break;
            case "PageDown":   qc(27); qc(91); qc(54); ch = 126; break;
            default: return; // Don't prevent default for unhandled keys
        }
    }

    if (ch !== 0) {
        wasm.exports.console_queue_char(ch);
    }
    e.preventDefault();
}

// Start boot sequence
boot();
