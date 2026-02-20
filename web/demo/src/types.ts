export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  path: string;
  children?: FileEntry[];
}

export interface RunResult {
  exitCode: number;
  stdout: string;
}

export interface DemoManifest {
  name: string;
  description: string;
  command: string;
  previewPort?: number;
  previewPath?: string;
}

export type RuntimeMode = "busybox" | "node";

export type RightPanelTab = "console" | "preview";
