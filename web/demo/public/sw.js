// NanoVM Service Worker — intercepts /sw/PORT/path and routes to VirtualServer
// via postMessage to the main page. Also injects COOP/COEP headers on all
// responses so SharedArrayBuffer works on hosts without custom header support
// (e.g. GitHub Pages).

// Derive base path from SW location so it works at any mount point
const BASE = new URL("./", self.location).pathname; // e.g. "/nano/"
const SCOPE_PREFIX = BASE + "sw/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Direct /sw/PORT/path requests (e.g. iframe src="/nano/sw/8080/")
  if (url.pathname.startsWith(SCOPE_PREFIX)) {
    const rest = url.pathname.slice(SCOPE_PREFIX.length);
    const slashIdx = rest.indexOf("/");
    const port = parseInt(slashIdx === -1 ? rest : rest.slice(0, slashIdx), 10);
    const path = slashIdx === -1 ? "/" : rest.slice(slashIdx);
    if (!isNaN(port)) {
      event.respondWith(handleRequest(event.request, port, path));
      return;
    }
  }

  // Sub-requests from iframe: referrer contains /sw/PORT/
  const referrer = event.request.referrer;
  if (referrer) {
    try {
      const refUrl = new URL(referrer);
      if (refUrl.pathname.startsWith(SCOPE_PREFIX)) {
        const rest = refUrl.pathname.slice(SCOPE_PREFIX.length);
        const slashIdx = rest.indexOf("/");
        const port = parseInt(slashIdx === -1 ? rest : rest.slice(0, slashIdx), 10);
        if (!isNaN(port)) {
          event.respondWith(handleRequest(event.request, port, url.pathname));
          return;
        }
      }
    } catch {}
  }

  // All other requests: fetch from network and inject COOP/COEP headers
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only modify same-origin or CORS responses we can read
        if (response.type === "opaque") return response;

        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(() => fetch(event.request))
  );
});

async function handleRequest(request, port, path) {
  // Build a minimal HTTP/1.1 request string to inject into the guest
  const method = request.method;
  const headers = [];
  for (const [key, value] of request.headers) {
    headers.push(`${key}: ${value}`);
  }

  let body = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await request.text();
    } catch {}
  }

  // Filter out any existing connection header and force close
  const filtered = headers.filter(h => !/^connection:/i.test(h));
  const requestLines = [
    `${method} ${path} HTTP/1.1`,
    `Host: localhost:${port}`,
    "Connection: close",
    ...filtered,
  ];
  if (body) {
    requestLines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  }
  // Headers end with \r\n\r\n — the blank line is the HTTP separator
  const httpRequest = requestLines.join("\r\n") + "\r\n\r\n" + body;

  // Send to main page and wait for response
  const clients = await self.clients.matchAll({ type: "window" });
  if (clients.length === 0) {
    return new Response("No active client", {
      status: 502,
      headers: { "Cross-Origin-Resource-Policy": "same-origin" },
    });
  }

  const client = clients[0];

  return new Promise((resolve) => {
    const channel = new MessageChannel();

    channel.port1.onmessage = (event) => {
      const { status, statusText, headers: respHeaders, body: respBody } = event.data;
      // Merge COEP/CORP headers so the iframe response is allowed by the parent's require-corp policy
      const finalHeaders = Object.assign({}, respHeaders || {}, {
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      resolve(new Response(respBody, {
        status: status || 200,
        statusText: statusText || "OK",
        headers: finalHeaders,
      }));
    };

    // Timeout after 30 seconds
    setTimeout(() => {
      resolve(new Response("Gateway Timeout", {
        status: 504,
        headers: { "Cross-Origin-Resource-Policy": "same-origin" },
      }));
    }, 30000);

    client.postMessage(
      { type: "sw-request", port, path, httpRequest },
      [channel.port2]
    );
  });
}
