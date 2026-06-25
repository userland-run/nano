// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// OPFS (Origin Private File System) helper module.
// Provides persistent browser-side storage for user files under /examples/.

let rootHandle: FileSystemDirectoryHandle | null = null;

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!rootHandle) {
    rootHandle = await navigator.storage.getDirectory();
  }
  return rootHandle;
}

/** Navigate to (or create) nested directory handles for a path like "/examples/01-basic". */
async function getDirHandle(
  dirPath: string,
  create = false,
): Promise<FileSystemDirectoryHandle | null> {
  const root = await getRoot();
  const parts = dirPath.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return current;
}

/** Split a path into (parentDir, fileName). */
function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return { dir: "/", name: path.replace(/^\//, "") };
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

// ---- Public API ----

export async function writeFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const { dir, name } = splitPath(path);
  const dirHandle = await getDirHandle(dir, true);
  if (!dirHandle) throw new Error(`OPFS: cannot create dir for ${path}`);
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  if (typeof content === "string") {
    await writable.write(content);
  } else {
    await writable.write(content.buffer as ArrayBuffer);
  }
  await writable.close();
}

export async function readFile(path: string): Promise<string | null> {
  const { dir, name } = splitPath(path);
  const dirHandle = await getDirHandle(dir);
  if (!dirHandle) return null;
  try {
    const fileHandle = await dirHandle.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function listDir(
  path: string,
): Promise<{ name: string; type: "file" | "dir" }[] | null> {
  const dirHandle = await getDirHandle(path);
  if (!dirHandle) return null;
  const entries: { name: string; type: "file" | "dir" }[] = [];
  for await (const [name, handle] of (dirHandle as any).entries()) {
    entries.push({ name, type: handle.kind === "directory" ? "dir" : "file" });
  }
  return entries;
}

export async function exists(path: string): Promise<boolean> {
  const { dir, name } = splitPath(path);
  const dirHandle = await getDirHandle(dir);
  if (!dirHandle) return false;
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    try {
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

export async function deleteFile(path: string): Promise<void> {
  const { dir, name } = splitPath(path);
  const dirHandle = await getDirHandle(dir);
  if (!dirHandle) return;
  try {
    await dirHandle.removeEntry(name);
  } catch {}
}

export async function deleteDir(path: string): Promise<void> {
  const { dir, name } = splitPath(path);
  const dirHandle = await getDirHandle(dir);
  if (!dirHandle) return;
  try {
    await dirHandle.removeEntry(name, { recursive: true });
  } catch {}
}

/** Recursively walk all files under basePath, returning {path, content} pairs. */
export async function walkFiles(
  basePath: string,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];

  async function walk(dirHandle: FileSystemDirectoryHandle, currentPath: string) {
    for await (const [name, handle] of (dirHandle as any).entries()) {
      const fullPath = currentPath + "/" + name;
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        const text = await file.text();
        results.push({ path: fullPath, content: text });
      } else {
        await walk(handle as FileSystemDirectoryHandle, fullPath);
      }
    }
  }

  const dirHandle = await getDirHandle(basePath);
  if (dirHandle) {
    await walk(dirHandle, basePath);
  }
  return results;
}

const SEEDED_SENTINEL = ".opfs-seeded";

export async function isSeeded(): Promise<boolean> {
  const root = await getRoot();
  try {
    await root.getFileHandle(SEEDED_SENTINEL);
    return true;
  } catch {
    return false;
  }
}

export async function markSeeded(): Promise<void> {
  const root = await getRoot();
  const fh = await root.getFileHandle(SEEDED_SENTINEL, { create: true });
  const w = await fh.createWritable();
  await w.write("1");
  await w.close();
}

/** Remove the examples directory and the seeded sentinel. */
export async function clearAll(): Promise<void> {
  const root = await getRoot();
  try {
    await root.removeEntry("examples", { recursive: true });
  } catch {}
  try {
    await root.removeEntry(SEEDED_SENTINEL);
  } catch {}
}
