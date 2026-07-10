// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// nodert/src/platform.mjs — the thin seam between the browser (Web Worker)
// and Node (worker_threads, used for headless tests). The nodert guest and
// the host runtime import only from here so the same code runs in both.
//
// In the browser this module is replaced at build time by a Web Worker
// implementation; the API surface is identical.

const isNode = typeof process !== "undefined" && process.versions?.node;

let nodeWorker = null;
if (isNode) {
  nodeWorker = await import("node:worker_threads");
}

/**
 * Spawn a worker running `entryUrl` (a data: or file: URL). Returns a handle
 * whose { postMessage, onMessage, terminate } is the same in both worlds.
 * `workerData` is passed to the worker at construction (transferables move).
 */
function spawnWorker(entryUrl, workerData, transfer = []) {
  if (isNode) {
    const w = new nodeWorker.Worker(new URL(entryUrl), { workerData, transferList: transfer });
    return {
      postMessage: (msg, t) => w.postMessage(msg, t),
      onMessage: (fn) => w.on("message", fn),
      onError: (fn) => w.on("error", fn),
      terminate: () => w.terminate(),
    };
  }
  const w = new Worker(entryUrl, { type: "module" });
  w.postMessage({ __workerData: workerData }, transfer);
  return {
    postMessage: (msg, t) => w.postMessage(msg, t ? { transfer: t } : undefined),
    onMessage: (fn) => w.addEventListener("message", (e) => fn(e.data)),
    onError: (fn) => w.addEventListener("error", fn),
    terminate: () => w.terminate(),
  };
}

/** Inside a worker: get the workerData and the parent message port. */
async function workerContext() {
  if (isNode) {
    const { workerData, parentPort } = nodeWorker;
    return {
      workerData,
      post: (msg, t) => parentPort.postMessage(msg, t),
      onMessage: (fn) => parentPort.on("message", fn),
    };
  }
  // Browser: workerData arrives as the first { __workerData } message.
  return await new Promise((resolve) => {
    self.addEventListener(
      "message",
      (e) => {
        resolve({
          workerData: e.data.__workerData,
          post: (msg, t) => self.postMessage(msg, t ? { transfer: t } : undefined),
          onMessage: (fn) => self.addEventListener("message", (ev) => fn(ev.data)),
        });
      },
      { once: true }
    );
  });
}

// Create a JS module URL for `source` that host import() can evaluate. The
// browser uses blob: URLs (flat, short references); Node has no
// URL.createObjectURL, so it uses data: URLs (imports must be inlined
// bottom-up by the caller). Returns { url, revoke }.
function createModuleUrl(source) {
  if (!isNode && typeof URL !== "undefined" && URL.createObjectURL) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  const url = "data:text/javascript;charset=utf-8," + encodeURIComponent(source);
  return { url, revoke: () => {} };
}

const supportsBlobUrls = () => !isNode && typeof URL !== "undefined" && !!URL.createObjectURL;

export { isNode, spawnWorker, workerContext, createModuleUrl, supportsBlobUrls };
