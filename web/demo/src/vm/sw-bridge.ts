// Service Worker bridge — registers SW and routes HTTP requests from the
// iframe preview to NanoVM's VirtualServer.

import { getVM } from "./runtime";

let swRegistered = false;

export async function registerServiceWorker(): Promise<boolean> {
  if (swRegistered) return true;
  if (!("serviceWorker" in navigator)) return false;

  // On first visit there's no SW controller yet — we need to install the SW
  // and then reload so its COOP/COEP header injection takes effect.
  const needsReload = !navigator.serviceWorker.controller;

  try {
    const base = import.meta.env.BASE_URL; // e.g. "/nano/"
    const reg = await navigator.serviceWorker.register(base + "sw.js", {
      scope: base,
      updateViaCache: "none",
    });
    if (reg.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    await navigator.serviceWorker.ready;

    if (needsReload) {
      // SW just installed — reload so COOP/COEP headers are active
      console.log("[sw-bridge] SW installed, reloading for COOP/COEP headers");
      window.location.reload();
      return false;
    }

    // CRITICAL: startMessages() is required or messages from SW are queued forever
    navigator.serviceWorker.startMessages();

    // Listen for requests from the SW
    navigator.serviceWorker.addEventListener("message", handleSWMessage);

    swRegistered = true;
    console.log("[sw-bridge] Service Worker registered and active");
    return true;
  } catch (err) {
    console.warn("[sw-bridge] SW registration failed:", err);
    return false;
  }
}

function handleSWMessage(event: MessageEvent) {
  if (event.data?.type !== "sw-request") return;

  const { port, path, httpRequest } = event.data;
  const replyPort = event.ports[0];

  if (!replyPort) {
    console.warn("[sw-bridge] No reply port in SW message");
    return;
  }

  const vm = getVM();
  if (!vm || !vm.virtualServer) {
    console.warn("[sw-bridge] VM or virtualServer not available");
    replyPort.postMessage({
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/plain" },
      body: "NanoVM not running",
    });
    return;
  }

  // Inject the connection into the virtual server
  vm.virtualServer
    .injectConnection(port, httpRequest)
    .then((responseBytes: Uint8Array) => {
      const responseText = new TextDecoder().decode(responseBytes);
      const parsed = parseHTTPResponse(responseText);
      replyPort.postMessage(parsed);
    })
    .catch((err: Error) => {
      console.error("[sw-bridge] injectConnection error:", err);
      replyPort.postMessage({
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/plain" },
        body: err.message,
      });
    });
}

function parseHTTPResponse(raw: string): {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
} {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return { status: 200, statusText: "OK", headers: {}, body: raw };
  }

  const headerSection = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd + 4);

  const lines = headerSection.split("\r\n");
  const statusLine = lines[0] || "";
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)(?: (.*))?/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;
  const statusText = statusMatch?.[2] || "OK";

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  // Decode chunked transfer encoding
  if (headers["Transfer-Encoding"]?.toLowerCase() === "chunked") {
    body = decodeChunked(body);
    delete headers["Transfer-Encoding"];
  }

  return { status, statusText, headers, body };
}

function decodeChunked(raw: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const sizeStr = raw.slice(pos, lineEnd).trim();
    const chunkSize = parseInt(sizeStr, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    const chunkStart = lineEnd + 2;
    parts.push(raw.slice(chunkStart, chunkStart + chunkSize));
    pos = chunkStart + chunkSize + 2; // skip chunk data + trailing \r\n
  }
  return parts.join("");
}
