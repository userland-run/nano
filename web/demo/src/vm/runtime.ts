// NanoVM runtime wrapper for the demo app.
// Manages a singleton NanoVM instance and provides high-level methods.

// @ts-ignore — nanovm.mjs is a JS module, no types
import { NanoVM } from "@container/nanovm.mjs";

let vmInstance: any = null;
let vmReady = false;
let initPromise: Promise<void> | null = null;

export async function ensureVM(): Promise<any> {
  if (vmInstance && vmReady) return vmInstance;
  if (initPromise) {
    await initPromise;
    return vmInstance;
  }

  initPromise = (async () => {
    vmInstance = await NanoVM.create({
      ramMB: 1800,
      wasm: import.meta.env.BASE_URL + "nano.wasm",
    });

    // Load bundled devenv tarball if available
    const exports = vmInstance._exports || vmInstance.exports;
    if (exports?.vm_bundled_devenv_ptr && exports?.vm_bundled_devenv_size) {
      const devenvPtr = exports.vm_bundled_devenv_ptr();
      const devenvSize = exports.vm_bundled_devenv_size();
      if (devenvPtr > 0 && devenvSize > 0) {
        console.log(`[NanoVM] Loading bundled devenv (${(devenvSize / 1024 / 1024).toFixed(1)} MB compressed)...`);
        const wasmMemory = vmInstance._memory || vmInstance.memory;
        if (wasmMemory) {
          const tarGz = new Uint8Array(wasmMemory.buffer, devenvPtr, devenvSize);
          const tarGzCopy = new Uint8Array(tarGz);
          await vmInstance.loadTarGz(tarGzCopy);
          console.log(`[NanoVM] Devenv loaded into VFS`);
        }
      }
    }

    vmReady = true;
  })();

  await initPromise;
  return vmInstance;
}

export function getVM(): any {
  return vmInstance;
}

export async function runBusybox(
  command: string,
  opts: { onStdout?: (chunk: string) => void; stdin?: string } = {}
): Promise<{ exitCode: number; stdout: string }> {
  const vm = await ensureVM();
  return vm.run(command, {
    onStdout: opts.onStdout,
    stdin: opts.stdin,
    maxSteps: 20_000_000,
  });
}

export async function runNode(
  args: string[],
  opts: { onStdout?: (chunk: string) => void; stdin?: string; maxSteps?: number } = {}
): Promise<{ exitCode: number; stdout: string }> {
  const vm = await ensureVM();
  return vm.node(...args, {
    onStdout: opts.onStdout,
    stdin: opts.stdin,
    maxSteps: opts.maxSteps || 2_000_000_000,
  });
}

export async function addFile(path: string, content: string | Uint8Array) {
  const vm = await ensureVM();
  vm.addFile(path, content);
}

export async function readFile(path: string): Promise<string | null> {
  const vm = await ensureVM();
  return vm.readFileString(path);
}

export async function listDir(path: string) {
  const vm = await ensureVM();
  return vm.listDir(path);
}

export async function resetVFS() {
  // Destroy and re-create to get a fresh FS
  if (vmInstance) {
    vmInstance.destroy();
    vmInstance = null;
    vmReady = false;
    initPromise = null;
  }
  await ensureVM();
}
