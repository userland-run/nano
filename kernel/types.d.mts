// kernel/types.d.mts — shared protocol IDL for the Kernel (spec UL-SPEC/nodert,
// Appendix A). Consumed by kernel/*.mjs via JSDoc, by the SDK vendor mirror,
// and by nano/nodert (TypeScript) as the single source of interface truth.

/** Process kinds (§7.1). */
export type ProcessKind = "vm-init" | "vm" | "node" | "boa" | "service" | "wasm";

export type ProcessState = "running" | "zombie" | "reaped";

/** Capability record (§7.3). A child's caps MUST be a subset of its parent's. */
export interface Capabilities {
  fs: {
    mode: "none" | "readonly" | "readwrite";
    /** Path prefixes the fs mode applies to; absent = whole tree. */
    scopes?: string[];
  };
  net: {
    /** Outbound via host-fetch bridge. */
    fetchHosts: "none" | "all" | string[];
    /** Loopback listen: any port (true), none (false), or a whitelist. */
    listen: boolean | number[];
    loopbackConnect: boolean;
  };
  spawn: { node: boolean; vm: boolean; boa: boolean };
  /** Kernel Service ids, e.g. ["swc", "duckdb"]. */
  services: string[];
  env: "none" | "inherit" | Record<string, string>;
  stdio: "inherit" | "pipe";
}

/** A Kernel-registered execution context (§7.1). */
export interface Process {
  pid: number;
  kind: ProcessKind;
  ppid: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  caps: Capabilities;
  /** Pipe ids, or "tty" for the interactive terminal. */
  stdio: [number | "tty", number | "tty", number | "tty"];
  state: ProcessState;
  exitCode?: number;
  signal?: string;
}

/** Wire form of a Kernel error (§5.3). */
export interface KernelErrorJSON {
  /** Positive Linux errno. */
  errno: number;
  /** Symbolic name, or machine-readable override like "ERR_CAP_DENIED". */
  name: string;
  message?: string;
  /** Set on capability denials: the capability facet that denied. */
  capability?: string;
}

/** Version handshake sent as a bus client's first async-plane message (§5.2). */
export interface BusHello {
  hello: {
    major: number;
    minor: number;
    pid: number;
    /** Per-spawn nonce; prevents a worker claiming another pid. */
    token: string;
  };
}

/** Async-plane request/response framing. */
export interface BusRequest {
  id: number;
  op: number;
  args: unknown;
}
export type BusResponse =
  | { id: number; ok: unknown }
  | { id: number; err: KernelErrorJSON };

/** Unsolicited async-plane events. */
export type BusEvent =
  | { ev: "signal"; signal: string }
  | { ev: "watch"; path: string; kind: "rename" | "change" }
  | { ev: "child-exit"; pid: number; exitCode: number | null; signal: string | null }
  | { ev: "sock-data"; sock: number; data: ArrayBuffer }
  | { ev: "listening"; pid: number; port: number }
  | { ev: "wake"; token: number };

/** Sync-plane SAB channel layout (plan-defined; spec Appendix C).
 *  i32 status @0 · u16 op @4 · u16 flags @6 · u32 seq @8 ·
 *  u32 payloadLen @12 · u32 chunkOff @16 · payload window @64. */
export declare const SYNC_STATUS: {
  IDLE: 0;
  REQUEST: 1;
  RESPONSE: 2;
  RESPONSE_CHUNK: 3;
  ERROR: 4;
};

export interface KernelOptions {
  /** Mount table; default single { "/": { backend: "mem" } }. */
  mounts?: Record<string, { backend: "mem" | "opfs" | "cas"; key?: string }>;
  /** Root capability profile for the embedder context. */
  caps?: Partial<Capabilities>;
}
