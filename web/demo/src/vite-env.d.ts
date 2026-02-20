/// <reference types="vite/client" />

declare module "@container/nanovm.mjs" {
  export class NanoVM {
    static create(options?: {
      ramMB?: number;
      wasm?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module;
      fs?: Record<string, string | Uint8Array>;
    }): Promise<NanoVM>;

    run(
      command: string,
      options?: {
        onStdout?: (chunk: string) => void;
        stdin?: string | Uint8Array;
        maxSteps?: number;
      }
    ): Promise<{ exitCode: number; stdout: string }>;

    node(
      ...args: (string | {
        onStdout?: (chunk: string) => void;
        stdin?: string | Uint8Array;
        maxSteps?: number;
      })[]
    ): Promise<{ exitCode: number; stdout: string }>;

    addFile(path: string, content: string | Uint8Array): void;
    addDir(path: string): void;
    readFile(path: string): Uint8Array | null;
    readFileString(path: string): string | null;
    listDir(path: string): { name: string; type: "file" | "dir" | "symlink"; size: number }[] | null;
    get virtualServer(): any;
    reset(): Promise<void>;
    destroy(): void;
  }
}
