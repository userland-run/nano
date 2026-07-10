// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// kernel/net/fetch-bridge.mjs — the outbound host-fetch bridge (spec §11.2),
// extracted from container/nanovm.mjs so the VM's /dev/__net__ path and the
// nodert tier's net.fetch_* opcodes share ONE streaming/backpressure
// implementation and one capability chokepoint.
//
// A "net stream" is the plain-object state machine the VM's guest reads
// (and the hub's fetch_read) drain:
//   { chunks: Uint8Array[], pos, ended, error, reader, served,
//     eofDelivered, waker }

const NET_BUFFER_MAX = 256 * 1024;

class FetchBridge {
  constructor() {
    this.corsProxyUrl = null;
    this.disabled = false;
    this.llmBridge = null;
  }

  configure({ corsProxyUrl = null, disabled = false } = {}) {
    this.corsProxyUrl = corsProxyUrl;
    this.disabled = !!disabled;
  }

  setLlmBridge(handler) {
    this.llmBridge = handler || null;
  }

  /**
   * VM entry: parse the guest's raw "METHOD URL\nHeader: v\n\nbody" request
   * bytes and open a net stream for the response.
   */
  async openFromRawRequest(reqBytes) {
    // Parse "METHOD URL\nHeader: v\n...\n\nbody".
    const text = new TextDecoder().decode(reqBytes);
    const sep = text.indexOf("\n\n");
    const head = sep >= 0 ? text.slice(0, sep) : text;
    const body = sep >= 0 ? text.slice(sep + 2) : "";
    const lines = head.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
    const first = (lines.shift() || "GET ").trim().split(/\s+/);
    const method = (first[0] || "GET").toUpperCase();
    const url = first[1];
    const headers = {};
    for (const l of lines) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    if (!url) return this.bufferedStream(this.httpResp(400, "Bad Request", {}, "nano-net: missing URL"));
    return this.open({ method, url, headers, body });
  }

  /**
   * Structured entry (net.fetch_open): open a net stream for the response.
   * Never rejects — transport failures come back as framed 502 responses,
   * exactly like the VM path.
   */
  async open({ method = "GET", url, headers = {}, body = "" }) {
    try {
      // Internal origin: route to the in-page LLM bridge instead of fetch().
      let host = "";
      try { host = new URL(url).hostname; } catch { /* non-URL → let fetch fail */ }
      if (host === "nanoinfer.internal") {
        if (!this.llmBridge) {
          return this.bufferedStream(this.httpResp(502, "Bad Gateway", {}, "nano-net: no LLM bridge registered"));
        }
        const r = await this.llmBridge({ method, url, headers, body });
        return await this.llmResultToStream(r);
      }
      const opts = { method, headers };
      if (method !== "GET" && method !== "HEAD" && body) opts.body = body;
      let resp;
      try {
        resp = await fetch(url, opts);
      } catch (e) {
        // Direct fetch blocked (CORS/network) → retry via the Tier-1.5 proxy if
        // set. This only ever runs before the first response byte exists, so
        // the retry can never interleave with streamed output.
        if (this.corsProxyUrl) {
          const u = this.corsProxyUrl + (this.corsProxyUrl.includes("?") ? "&" : "?") + "apiurl=" + encodeURIComponent(url);
          resp = await fetch(u, opts);
        } else throw e;
      }
      return await this.respToStream(resp);
    } catch (e) {
      return this.bufferedStream(this.httpResp(502, "Bad Gateway", {}, "nano-net: " + (e?.message || String(e))));
    }
  }

  // Turn a fetch()-style Response into a net stream. Small responses with a
  // known Content-Length keep the legacy fully-buffered framing (byte-identical
  // to the pre-streaming bridge); everything else streams and ends with EOF.
  async respToStream(resp) {
    const hdrs = {}; resp.headers.forEach((v, k) => { hdrs[k] = v; });
    const cl = parseInt(resp.headers.get("content-length") ?? "", 10);
    if (!resp.body || (Number.isFinite(cl) && cl <= NET_BUFFER_MAX)) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      return this.bufferedStream(this.httpResp(resp.status, resp.statusText || "", hdrs, buf));
    }
    return this.pumpStream(resp.status, resp.statusText || "", hdrs, resp.body.getReader());
  }

  // Normalize an LLM-bridge handler result into a net stream.
  async llmResultToStream(r) {
    if (typeof Response !== "undefined" && r instanceof Response) return this.respToStream(r);
    if (!r) return this.bufferedStream(this.httpResp(502, "Bad Gateway", {}, "nano-net: empty LLM bridge result"));
    const status = r.status ?? 200;
    const statusText = r.statusText ?? "";
    const hdrs = {};
    const rh = r.headers;
    if (rh && typeof rh.forEach === "function" && typeof rh.get === "function") rh.forEach((v, k) => { hdrs[k] = v; });
    else if (rh) Object.assign(hdrs, rh);
    const b = r.body;
    if (b && typeof b.getReader === "function") return this.pumpStream(status, statusText, hdrs, b.getReader());
    const bytes = b == null ? new Uint8Array(0) : (typeof b === "string" ? new TextEncoder().encode(b) : b);
    return this.bufferedStream(this.httpResp(status, statusText, hdrs, bytes));
  }

  // A net stream whose full framed response is already in memory (legacy path).
  bufferedStream(bytes) {
    return { chunks: [bytes], pos: 0, ended: true, error: null, reader: null,
             served: false, eofDelivered: false, waker: null };
  }

  // Emit the response head immediately (no content-length — the body length is
  // unknown up-front; the reader consumes until EOF), then pump body chunks
  // from `reader` into the queue in the background, waking any parked read.
  pumpStream(status, statusText, headers, reader) {
    const st = { chunks: [], pos: 0, ended: false, error: null, reader,
                 served: false, eofDelivered: false, waker: null };
    let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      const kl = k.toLowerCase();
      // The streamed body is decoded/reframed by the host, so the origin's
      // length/coding headers no longer describe it — drop them.
      if (kl === "content-length" || kl === "transfer-encoding" || kl === "content-encoding") continue;
      head += `${k}: ${v}\r\n`;
    }
    head += `\r\n`;
    st.chunks.push(new TextEncoder().encode(head));
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            st.chunks.push(value);
            if (st.waker) st.waker();
          }
        }
      } catch (e) {
        st.error = e; // surfaced as EIO once the queued chunks are drained
      }
      st.ended = true;
      if (st.waker) st.waker();
    })();
    return st;
  }

  /**
   * Copy up to dest.length queued bytes from the stream. Returns
   * { copied } with copied > 0 for data, { eof: true } / { error } when
   * drained, or { park: true } when the stream is open with nothing queued
   * (the caller parks and retries after `parkStream`).
   */
  readFromStream(st, dest) {
    let copied = 0;
    while (copied < dest.length && st.chunks.length) {
      const c = st.chunks[0];
      const n = Math.min(c.length - st.pos, dest.length - copied);
      dest.set(c.subarray(st.pos, st.pos + n), copied);
      st.pos += n; copied += n;
      if (st.pos >= c.length) { st.chunks.shift(); st.pos = 0; }
    }
    if (copied > 0) {
      st.served = true;
      return { copied };
    }
    if (st.error) {
      st.eofDelivered = true;
      return { error: st.error, copied: 0 };
    }
    if (st.ended) {
      st.eofDelivered = true;
      return { eof: true, copied: 0 };
    }
    return { park: true, copied: 0 };
  }

  /** Resolve when the pump delivers data/EOF/error, or after a short fallback. */
  parkStream(st, fallbackMs = 50) {
    if (!st || st.chunks.length || st.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => { st.waker = null; clearTimeout(timer); resolve(); };
      const timer = setTimeout(wake, fallbackMs);
      st.waker = wake;
    });
  }

  /** Cancel a still-open host stream (early close by the consumer). */
  cancelStream(st) {
    if (!st) return;
    if (!st.ended && st.reader) { try { st.reader.cancel(); } catch { /* already errored/closed */ } }
    st.ended = true;
    if (st.waker) st.waker();
  }

  // Frame a host response as HTTP/1.1 (status line + headers + body).
  httpResp(status, statusText, headers, body) {
    const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    head += `content-length: ${bodyBytes.length}\r\n\r\n`;
    const headBytes = new TextEncoder().encode(head);
    const out = new Uint8Array(headBytes.length + bodyBytes.length);
    out.set(headBytes, 0); out.set(bodyBytes, headBytes.length);
    return out;
  }
}

export { FetchBridge, NET_BUFFER_MAX };
