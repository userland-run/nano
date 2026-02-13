// NanoVM JS Host — WASM loader, import stubs, cooperative scheduler, terminal.
"use strict";

const KERNEL_URL = "kernel-x86_64.bin"; // bzImage (startup_32 handles 32→64-bit transition)
const WASM_URL = "nanovm.wasm";
const RAM_MB = 256;
const BUDGET = 2000000; // instructions per timeslice

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
            if (!console_write._logged) {
                console.log("UART TX first call: len=" + len + " buf=0x" + buf.toString(16) + " char=" + bytes[0]);
                console_write._logged = true;
            }
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
        debug_log(code) {
            const tag = (code >>> 24) & 0xFF;
            const val = code & 0x00FFFFFF;
            switch (tag) {
                case 0xAA: console.log("TRACE RIP: 0x" + (code >>> 0).toString(16)); break;
                case 0xD1: console.log("DIAG PIT ch0 reload: " + val + " (0x" + val.toString(16) + ")"); break;
                case 0xD2: console.log("DIAG PIC master IMR: 0b" + val.toString(2).padStart(8,'0')); break;
                case 0xD3: console.log("DIAG PIC master ISR: 0b" + val.toString(2).padStart(8,'0')); break;
                case 0xD4: console.log("DIAG PIC master IRR: 0b" + val.toString(2).padStart(8,'0')); break;
                case 0xD5: console.log("DIAG RFLAGS IF: " + val); break;
                case 0xD6: console.log("DIAG RIP low24: 0x" + val.toString(16)); break;
                case 0xD7: console.log("DIAG PIT ch0 count: " + val + " (0x" + val.toString(16) + ")"); break;
                case 0xD8: console.log("DIAG PIC master irq_base: 0x" + val.toString(16)); break;
                case 0xA0: console.log("TRACE RIP=0x" + val.toString(16)); break;
                case 0xE0: console.log("IO WRITE port=0x" + ((val >> 8) & 0xFFFF).toString(16) + " val=0x" + (val & 0xFF).toString(16)); break;
                case 0xE1: console.log("IO READ port=0x" + ((val >> 8) & 0xFFFF).toString(16) + " ret=0x" + (val & 0xFF).toString(16)); break;
                case 0xEC: window._exc_cr2_hi = val; break;
                case 0xED: window._exc_cr2_lo = val; break;
                case 0xEE: window._exc_rip_hi = val; break;
                case 0xEF: {
                    const vec = val & 0xFF;
                    const rip16 = (val >> 8) & 0xFFFF;
                    const ripHi = window._exc_rip_hi || 0;
                    const cr2Lo = window._exc_cr2_lo || 0;
                    const cr2Hi = window._exc_cr2_hi || 0;
                    const names = {0:'#DE',6:'#UD',13:'#GP',14:'#PF',8:'#DF'};
                    const fullRip = "0x" + ripHi.toString(16).padStart(8,'0') + rip16.toString(16).padStart(4,'0');
                    const fullCr2 = "0x" + cr2Hi.toString(16).padStart(8,'0') + cr2Lo.toString(16).padStart(6,'0');
                    console.log("EXCEPTION #" + vec + " (" + (names[vec]||'?') + ") RIP=" + fullRip + " CR2=" + fullCr2);
                    break;
                }
                default: console.log("DEBUG: 0x" + (code >>> 0).toString(16)); break;
            }
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

        console.log("Loading bzImage...");
        const loadOk = wasm.exports.load_kernel(kernelPtr, kernelBytes.byteLength);
        wasm.exports.free(kernelPtr);

        if (loadOk === 0) {
            setStatus("Error: failed to load kernel");
            termWrite("ERROR: Failed to load kernel.\n");
            return;
        }

        // 7. Set up keyboard input
        document.addEventListener("keydown", onKeyDown);

        // 8. Start execution
        setStatus("Booting...");
        running = true;
        bootTime = Date.now();
        requestAnimationFrame(step);

    } catch (err) {
        setStatus("Error: " + err.message);
        console.error("Boot failed:", err);
    }
}

// ============================================================
// Cooperative scheduler — runs one timeslice per frame
// ============================================================
let stepCount = 0;
let bootTime = Date.now();
function step() {
    if (!running) return;

    try {
        refreshMem();
        const now = Date.now();
        // Single-step trace when RIP is in the critical range (find 2-byte decode bug)
        const rip0 = BigInt.asUintN(64, BigInt(wasm.exports.debug_rip()));
        if (rip0 >= 0x200100n && rip0 <= 0x200200n) {
            // Single-step mode: execute 1 instruction at a time, log each RIP
            for (let i = 0; i < 200; i++) {
                const ripBefore = BigInt.asUintN(64, BigInt(wasm.exports.debug_rip()));
                wasm.exports.vm_step(1, now);
                const ripAfter = BigInt.asUintN(64, BigInt(wasm.exports.debug_rip()));
                console.log(`TRACE: 0x${ripBefore.toString(16)} -> 0x${ripAfter.toString(16)}`);
                if (ripAfter > 0x200180n || ripAfter < 0x200000n) break;
            }
        } else {
            wasm.exports.vm_step(BUDGET, now);
        }
        stepCount++;
        // One-shot IRQ state dump after 5 seconds
        if (stepCount === 1000 && wasm.exports.debug_dump_irq_state) {
            console.log("=== IRQ STATE DUMP (5s) ===");
            wasm.exports.debug_dump_irq_state();
            console.log("=== END IRQ STATE DUMP ===");
        }
        // Periodic progress check every 200 steps
        if (stepCount % 200 === 0 && wasm.exports.debug_rip) {
            const rip = BigInt.asUintN(64, BigInt(wasm.exports.debug_rip()));
            const elapsed = ((Date.now() - bootTime) / 1000).toFixed(1);
            console.log(`[${elapsed}s] step ${stepCount}: RIP=0x${rip.toString(16)}, ${(stepCount * BUDGET / 1e6).toFixed(0)}M insns`);
        }
    } catch (err) {
        running = false;
        setStatus("CPU error: " + err.message);
        const hex64 = (v) => "0x" + BigInt.asUintN(64, BigInt(v)).toString(16);
        if (wasm.exports.debug_instr_rip) {
            console.error("Last instruction RIP:", hex64(wasm.exports.debug_instr_rip()));
        }
        if (wasm.exports.debug_cr2) {
            console.error("CR2 (fault addr):", hex64(wasm.exports.debug_cr2()));
            console.error("CR3 (page table):", hex64(wasm.exports.debug_cr3()));
        }
        if (wasm.exports.debug_reg) {
            const names = ["RAX","RCX","RDX","RBX","RSP","RBP","RSI","RDI",
                           "R8","R9","R10","R11","R12","R13","R14","R15"];
            let regs = "";
            for (let i = 0; i < 16; i++) {
                regs += names[i] + "=" + hex64(wasm.exports.debug_reg(i)) + " ";
                if (i % 4 === 3) { console.error(regs.trim()); regs = ""; }
            }
        }
        if (wasm.exports.debug_idt_limit) {
            console.error("IDT limit:", wasm.exports.debug_idt_limit(), "base:", hex64(wasm.exports.debug_idt_base()));
        }
        if (wasm.exports.debug_read_phys && wasm.exports.debug_instr_rip) {
            const rip = BigInt.asUintN(64, BigInt(wasm.exports.debug_instr_rip()));
            // Try physical = rip - 0xffffffff80000000 (kernel text mapping)
            let phys = rip;
            if (rip >= 0xffffffff80000000n) {
                phys = rip - 0xffffffff80000000n;
            }
            if (phys < 0x10000000n) { // within 256MB
                let bytes = "";
                for (let i = 0; i < 16; i++) {
                    bytes += wasm.exports.debug_read_phys(Number(phys) + i).toString(16).padStart(2, '0') + " ";
                }
                console.error("Fault insn at phys 0x" + phys.toString(16) + ":", bytes);
                // Also dump surrounding context (32 bytes before, 32 after)
                let before = "";
                for (let i = -32; i < 0; i++) {
                    before += wasm.exports.debug_read_phys(Number(phys) + i).toString(16).padStart(2, '0') + " ";
                }
                console.error("Context [-32]:", before);
            }
            // Dump first 32 bytes of decompressed kernel at 0x200000
            let kstart = "";
            for (let i = 0; i < 32; i++) {
                kstart += wasm.exports.debug_read_phys(0x200000 + i).toString(16).padStart(2, '0') + " ";
            }
            console.error("Kernel start at phys 0x200000:", kstart);
            // Walk page table: CR3 -> PML4[511] to verify mapping
            const cr3 = Number(BigInt.asUintN(64, BigInt(wasm.exports.debug_cr3())));
            const readPhys64 = (addr) => {
                let v = 0n;
                for (let i = 0; i < 8; i++) v |= BigInt(wasm.exports.debug_read_phys(addr + i)) << BigInt(i * 8);
                return v;
            };
            const pml4e = readPhys64(cr3 + 511 * 8);
            console.error("PML4[511] =", "0x" + pml4e.toString(16));
            // PDP index for 0xffffffff80200172: bits 38:30
            const pdp_base = Number(pml4e & 0xfffffffffffff000n);
            const pdp_idx = Number((0xffffffff80200172n >> 30n) & 0x1ffn);
            const pdpe = readPhys64(pdp_base + pdp_idx * 8);
            console.error(`PDP[${pdp_idx}] =`, "0x" + pdpe.toString(16));
            // If 1GB page (bit 7 set), physical = pdpe & mask
            if (pdpe & 0x80n) {
                console.error("1GB page! phys =", "0x" + (pdpe & 0xffffffffc0000000n).toString(16));
            } else {
                const pd_base = Number(pdpe & 0xfffffffffffff000n);
                const pd_idx = Number((0xffffffff80200172n >> 21n) & 0x1ffn);
                const pde = readPhys64(pd_base + pd_idx * 8);
                console.error(`PD[${pd_idx}] =`, "0x" + pde.toString(16));
                if (pde & 0x80n) {
                    console.error("2MB page! phys =", "0x" + (pde & 0xffffffffffe00000n).toString(16));
                } else {
                    const pt_base = Number(pde & 0xfffffffffffff000n);
                    const pt_idx = Number((0xffffffff80200172n >> 12n) & 0x1ffn);
                    const pte = readPhys64(pt_base + pt_idx * 8);
                    console.error(`PT[${pt_idx}] =`, "0x" + pte.toString(16));
                    console.error("4KB page! phys =", "0x" + (pte & 0xfffffffffffff000n).toString(16));
                }
            }
        }
        console.error("Execution error at step", stepCount, ":", err);
        termWrite("\n\n--- VM STOPPED at step " + stepCount + ": " + err.message + " ---\n");
        return;
    }

    setTimeout(step, 0);
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
