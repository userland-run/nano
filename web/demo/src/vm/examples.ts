// VFS seed data — all example files for the NanoVM demo.

import * as opfs from "./opfs";

interface ExampleFile {
  path: string;
  content: string;
}

const EXAMPLES: ExampleFile[] = [
  // ============================================================
  // 01-basic
  // ============================================================
  {
    path: "/examples/01-basic/demo.json",
    content: JSON.stringify({
      name: "Basic Node.js",
      description: "Fundamental Node.js examples",
      command: "node /examples/01-basic/hello.js",
    }, null, 2),
  },
  {
    path: "/examples/01-basic/hello.js",
    content: `// Hello World — NanoVM running Node.js in WebAssembly
console.log("Hello from NanoVM!");
console.log("Platform:", process.platform);
console.log("Arch:", process.arch);
console.log("Node version:", process.version);
console.log("2 + 2 =", 2 + 2);
console.log("JSON:", JSON.stringify({ nanovm: true, wasm: true }));
console.log("Math.PI:", Math.PI);
console.log("Date:", new Date().toISOString());
`,
  },
  {
    path: "/examples/01-basic/argv-env.js",
    content: `// Process arguments and environment
console.log("argv:", process.argv);
console.log("cwd:", process.cwd());
console.log("pid:", process.pid);
console.log("env.HOME:", process.env.HOME || "(not set)");
console.log("env.PATH:", process.env.PATH || "(not set)");
console.log("env.USER:", process.env.USER || "(not set)");
`,
  },
  {
    path: "/examples/01-basic/fs-readwrite.js",
    content: `// File system read/write
const fs = require("fs");

// Write a file
fs.writeFileSync("/tmp/hello.txt", "Hello from NanoVM filesystem!\\n");
console.log("Wrote /tmp/hello.txt");

// Read it back
const content = fs.readFileSync("/tmp/hello.txt", "utf8");
console.log("Read back:", content.trim());

// List directory
const files = fs.readdirSync("/tmp");
console.log("/tmp contents:", files);

// Check if file exists
console.log("Exists:", fs.existsSync("/tmp/hello.txt"));

// File stats
const stat = fs.statSync("/tmp/hello.txt");
console.log("Size:", stat.size, "bytes");
`,
  },
  {
    path: "/examples/01-basic/path-url.js",
    content: `// Path and URL utilities
const path = require("path");
const url = require("url");

console.log("join:", path.join("/usr", "bin", "node"));
console.log("resolve:", path.resolve(".", "src", "index.js"));
console.log("dirname:", path.dirname("/usr/bin/node"));
console.log("basename:", path.basename("/usr/bin/node"));
console.log("extname:", path.extname("index.html"));

const parsed = url.parse("https://example.com:8080/api/users?page=1");
console.log("URL host:", parsed.host);
console.log("URL path:", parsed.pathname);
console.log("URL query:", parsed.query);
`,
  },
  {
    path: "/examples/01-basic/timers.js",
    content: `// Timers and async/await
console.log("Start");

// Promise
const p = new Promise((resolve) => {
  setTimeout(() => resolve("Promise resolved!"), 100);
});

p.then((msg) => console.log(msg));

// Async/await
async function main() {
  const result = await new Promise((resolve) => {
    setTimeout(() => resolve(42), 50);
  });
  console.log("Async result:", result);

  // Promise.all
  const results = await Promise.all([
    Promise.resolve("a"),
    Promise.resolve("b"),
    Promise.resolve("c"),
  ]);
  console.log("Promise.all:", results);
}

main().then(() => console.log("Done"));
`,
  },

  // ============================================================
  // 02-advanced
  // ============================================================
  {
    path: "/examples/02-advanced/demo.json",
    content: JSON.stringify({
      name: "Advanced Node.js",
      description: "Advanced Node.js features",
      command: "node /examples/02-advanced/streams.js",
    }, null, 2),
  },
  {
    path: "/examples/02-advanced/streams.js",
    content: `// Readable/Writable streams
const { Readable, Writable, Transform } = require("stream");

// Create a readable stream from an array
const input = Readable.from(["Hello ", "streaming ", "world!\\n"]);

// Create a transform that uppercases
const upper = new Transform({
  transform(chunk, encoding, callback) {
    callback(null, chunk.toString().toUpperCase());
  },
});

// Pipe through transform to stdout
input.pipe(upper).pipe(process.stdout);
`,
  },
  {
    path: "/examples/02-advanced/crypto-hash.js",
    content: `// Crypto hashing
const crypto = require("crypto");

const data = "Hello NanoVM!";

// SHA-256
const sha256 = crypto.createHash("sha256").update(data).digest("hex");
console.log("SHA-256:", sha256);

// MD5
const md5 = crypto.createHash("md5").update(data).digest("hex");
console.log("MD5:", md5);

// Random bytes
const bytes = crypto.randomBytes(16).toString("hex");
console.log("Random:", bytes);

// HMAC
const hmac = crypto.createHmac("sha256", "secret").update(data).digest("hex");
console.log("HMAC:", hmac);
`,
  },
  {
    path: "/examples/02-advanced/buffer-ops.js",
    content: `// Buffer operations
// Allocate
const buf = Buffer.alloc(16, 0xFF);
console.log("Alloc:", buf.toString("hex"));

// From string
const strBuf = Buffer.from("Hello NanoVM!");
console.log("From string:", strBuf.toString("hex"));
console.log("Back to string:", strBuf.toString("utf8"));

// Slice
const slice = strBuf.subarray(0, 5);
console.log("Slice:", slice.toString());

// Concat
const combined = Buffer.concat([Buffer.from("Nano"), Buffer.from("VM")]);
console.log("Concat:", combined.toString());

// Base64
const b64 = Buffer.from("Hello World").toString("base64");
console.log("Base64:", b64);
console.log("Decoded:", Buffer.from(b64, "base64").toString());
`,
  },
  {
    path: "/examples/02-advanced/event-emitter.js",
    content: `// EventEmitter patterns
const EventEmitter = require("events");

class Logger extends EventEmitter {
  log(msg) {
    this.emit("log", { level: "info", message: msg, time: Date.now() });
  }
  error(msg) {
    this.emit("log", { level: "error", message: msg, time: Date.now() });
  }
}

const logger = new Logger();

logger.on("log", (event) => {
  const prefix = event.level === "error" ? "[ERROR]" : "[INFO]";
  console.log(prefix, event.message);
});

logger.once("log", () => {
  console.log("(first log event received)");
});

logger.log("Application started");
logger.log("Processing data...");
logger.error("Something went wrong");
logger.log("Recovered successfully");

console.log("Listener count:", logger.listenerCount("log"));
`,
  },

  // ============================================================
  // 03-real-apps
  // ============================================================
  {
    path: "/examples/03-real-apps/http-server/demo.json",
    content: JSON.stringify({
      name: "HTTP Server",
      description: "Minimal Node.js HTTP server",
      command: "node /examples/03-real-apps/http-server/server.js",
      previewPort: 8080,
      previewPath: "/",
    }, null, 2),
  },
  {
    path: "/examples/03-real-apps/http-server/server.js",
    content: `// Minimal HTTP server using Node.js built-in http module
const http = require("http");

const server = http.createServer((req, res) => {
  console.log(req.method, req.url);

  if (req.url === "/api/time") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ time: new Date().toISOString() }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(\`<!DOCTYPE html>
<html>
<head><title>NanoVM HTTP Server</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px;">
  <h1>Hello from NanoVM!</h1>
  <p>This page is served by Node.js running inside a RISC-V emulator compiled to WebAssembly.</p>
  <p>Server time: <span id="time">loading...</span></p>
  <script>
    fetch("/api/time")
      .then(r => r.json())
      .then(d => document.getElementById("time").textContent = d.time);
  </script>
</body>
</html>\`);
});

server.listen(8080, () => {
  console.log("Server listening on port 8080");
});
`,
  },
  {
    path: "/examples/03-real-apps/express-api/demo.json",
    content: JSON.stringify({
      name: "Express-like REST API",
      description: "REST API with a lightweight Express-like router",
      command: "node /examples/03-real-apps/express-api/server.js",
      previewPort: 8080,
      previewPath: "/api/users",
    }, null, 2),
  },
  {
    path: "/examples/03-real-apps/express-api/server.js",
    content: `// Express-like REST API using a minimal router
const http = require("http");

// Mini-router
const routes = [];
function get(path, handler) { routes.push({ method: "GET", path, handler }); }
function post(path, handler) { routes.push({ method: "POST", path, handler }); }

// In-memory data
const users = [
  { id: 1, name: "Alice", email: "alice@nanovm.dev" },
  { id: 2, name: "Bob", email: "bob@nanovm.dev" },
  { id: 3, name: "Charlie", email: "charlie@nanovm.dev" },
];

// Routes
get("/api/users", (req, res) => {
  res.json(users);
});

get("/api/users/:id", (req, res) => {
  const user = users.find((u) => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), platform: "nanovm-wasm" });
});

get("/", (req, res) => {
  res.type("html").send(\`<!DOCTYPE html>
<html>
<head><title>NanoVM REST API</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 40px auto;">
  <h1>NanoVM REST API</h1>
  <ul>
    <li><a href="/api/users">/api/users</a></li>
    <li><a href="/api/users/1">/api/users/1</a></li>
    <li><a href="/api/health">/api/health</a></li>
  </ul>
  <pre id="out"></pre>
  <script>
    fetch("/api/users").then(r=>r.json()).then(d=>{
      document.getElementById("out").textContent = JSON.stringify(d, null, 2);
    });
  </script>
</body>
</html>\`);
});

// Request handler with mini-router
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  console.log(req.method, url);

  // Add helpers to res
  res.json = (data) => {
    res.writeHead(res.statusCode || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = (t) => {
    const types = { html: "text/html", json: "application/json", text: "text/plain" };
    res._contentType = types[t] || t;
    return res;
  };
  res.send = (body) => {
    res.writeHead(res.statusCode || 200, { "Content-Type": res._contentType || "text/plain" });
    res.end(body);
  };

  // Match route
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const paramMatch = matchRoute(route.path, url);
    if (paramMatch !== null) {
      req.params = paramMatch;
      return route.handler(req, res);
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

function matchRoute(pattern, url) {
  const patParts = pattern.split("/");
  const urlParts = url.split("/");
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = urlParts[i];
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

server.listen(8080, () => {
  console.log("API server listening on port 8080");
});
`,
  },
  {
    path: "/examples/03-real-apps/react-spa/demo.json",
    content: JSON.stringify({
      name: "React SPA (Static)",
      description: "Pre-built React app served by Node.js HTTP server",
      command: "node /examples/03-real-apps/react-spa/server.js",
      previewPort: 3000,
      previewPath: "/",
    }, null, 2),
  },
  {
    path: "/examples/03-real-apps/react-spa/server.js",
    content: `// Static file server for the React SPA
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIST = "/examples/03-real-apps/react-spa/dist";

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let filePath = path.join(DIST, req.url === "/" ? "/index.html" : req.url);
  console.log(req.method, req.url, "->", filePath);

  try {
    const data = fs.readFileSync(filePath, "utf8");
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  } catch (e) {
    // SPA fallback — serve index.html for all routes
    try {
      const data = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

server.listen(3000, () => {
  console.log("Static server listening on port 3000");
});
`,
  },
  {
    path: "/examples/03-real-apps/react-spa/dist/index.html",
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NanoVM React App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }
    #root { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    h1 { color: #00d4ff; margin-bottom: 16px; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin: 12px 0; border: 1px solid #0f3460; }
    .card h3 { color: #e94560; margin-bottom: 8px; }
    button { background: #e94560; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 4px; }
    button:hover { background: #c73650; }
    .counter { font-size: 48px; text-align: center; margin: 20px 0; color: #00d4ff; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/app.js"></script>
</body>
</html>`,
  },
  {
    path: "/examples/03-real-apps/react-spa/dist/app.js",
    content: `// Minimal React-like app (no build step needed)
const root = document.getElementById("root");

let count = 0;
let items = ["Learn NanoVM", "Build something cool", "Share with friends"];

function render() {
  root.innerHTML = \`
    <h1>NanoVM React App</h1>
    <p>This React-like SPA is served by Node.js running in WebAssembly.</p>

    <div class="card">
      <h3>Counter</h3>
      <div class="counter">\${count}</div>
      <div style="text-align:center">
        <button onclick="decrement()">-</button>
        <button onclick="increment()">+</button>
        <button onclick="resetCount()">Reset</button>
      </div>
    </div>

    <div class="card">
      <h3>Todo List</h3>
      <ul style="list-style:none;padding:0">
        \${items.map((item, i) => \`
          <li style="padding:8px 0;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between">
            <span>\${item}</span>
            <button onclick="removeItem(\${i})" style="background:#333;font-size:12px">x</button>
          </li>
        \`).join("")}
      </ul>
      <div style="margin-top:12px">
        <input id="newItem" placeholder="Add item..." style="background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;padding:8px;border-radius:4px;width:70%">
        <button onclick="addItem()">Add</button>
      </div>
    </div>

    <div class="card">
      <h3>System Info</h3>
      <p>Rendered at: \${new Date().toLocaleTimeString()}</p>
      <p>Items: \${items.length} | Counter: \${count}</p>
    </div>
  \`;
}

window.increment = () => { count++; render(); };
window.decrement = () => { count--; render(); };
window.resetCount = () => { count = 0; render(); };
window.removeItem = (i) => { items.splice(i, 1); render(); };
window.addItem = () => {
  const input = document.getElementById("newItem");
  if (input.value.trim()) {
    items.push(input.value.trim());
    render();
  }
};

render();
`,
  },

  // ============================================================
  // 04-devtools — Dev toolchain demos (TypeScript, ESLint, Prettier, npm)
  // ============================================================
  {
    path: "/examples/04-devtools/demo.json",
    content: JSON.stringify({
      name: "Dev Tools",
      description: "TypeScript, ESLint, Prettier & npm running in NanoVM",
      command: "node /examples/04-devtools/typescript.js",
    }, null, 2),
  },

  // --- TypeScript: parse and analyze AST ---
  {
    path: "/examples/04-devtools/typescript.js",
    content: `// TypeScript compiler — parse TS source and analyze the AST
const ts = require("/usr/local/lib/node_modules/typescript");

console.log("TypeScript", ts.version);
console.log("");

// TypeScript source with interfaces, type annotations, and generics
const sourceCode = [
  'interface User {',
  '  id: number;',
  '  name: string;',
  '  email: string;',
  '}',
  '',
  'function greet(user: User): string {',
  '  return "Hello, " + user.name + " (" + user.email + ")!";',
  '}',
  '',
  'const users: User[] = [',
  '  { id: 1, name: "Alice", email: "alice@nanovm.dev" },',
  '  { id: 2, name: "Bob",   email: "bob@nanovm.dev" },',
  '];',
  '',
  'for (const u of users) {',
  '  console.log(greet(u));',
  '}',
  '',
  'const map = new Map<string, number>();',
  'map.set("a", 1);',
  'map.set("b", 2);',
  'console.log("Map size:", map.size);',
].join("\\n");

console.log("=== TypeScript source ===");
console.log(sourceCode);
console.log("");

// Parse into AST (no type-checker, just the parser)
const sourceFile = ts.createSourceFile(
  "demo.ts", sourceCode, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS
);

// Walk the AST and report what we find
console.log("=== AST analysis ===");
console.log("Statements:", sourceFile.statements.length);
console.log("");

function analyze(node, depth) {
  const indent = "  ".repeat(depth);
  if (ts.isInterfaceDeclaration(node)) {
    const members = node.members.map(function(m) {
      return m.name ? m.name.getText(sourceFile) : "?";
    });
    console.log(indent + "interface " + node.name.getText(sourceFile) + " { " + members.join(", ") + " }");
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    const params = node.parameters.map(function(p) {
      var name = p.name.getText(sourceFile);
      var type = p.type ? p.type.getText(sourceFile) : "any";
      return name + ": " + type;
    });
    var ret = node.type ? node.type.getText(sourceFile) : "void";
    console.log(indent + "function " + node.name.getText(sourceFile) + "(" + params.join(", ") + "): " + ret);
  } else if (ts.isVariableStatement(node)) {
    for (var d of node.declarationList.declarations) {
      var type = d.type ? d.type.getText(sourceFile) : "(inferred)";
      console.log(indent + "const " + d.name.getText(sourceFile) + ": " + type);
    }
  } else if (ts.isForOfStatement(node)) {
    console.log(indent + "for...of loop");
  } else if (ts.isExpressionStatement(node)) {
    var text = node.getText(sourceFile).slice(0, 60);
    console.log(indent + "expr: " + text + (text.length >= 60 ? "..." : ""));
  }
}

for (var stmt of sourceFile.statements) {
  analyze(stmt, 0);
}

// Count node types in the AST
var nodeCount = 0;
var kindCounts = {};
function countNodes(node) {
  nodeCount++;
  var kind = ts.SyntaxKind[node.kind];
  kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  ts.forEachChild(node, countNodes);
}
countNodes(sourceFile);

console.log("");
console.log("Total AST nodes:", nodeCount);
console.log("Top node kinds:");
var sorted = Object.entries(kindCounts).sort(function(a, b) { return b[1] - a[1]; });
for (var i = 0; i < Math.min(8, sorted.length); i++) {
  console.log("  " + sorted[i][0] + ": " + sorted[i][1]);
}
`,
  },

  // --- ESLint: lint JavaScript code ---
  {
    path: "/examples/04-devtools/eslint.js",
    content: `// ESLint — lint JavaScript for common issues
const { Linter } = require("/usr/local/lib/node_modules/eslint");
const linter = new Linter();

console.log("ESLint", Linter.version);
console.log("");

// Code with intentional issues
const code = \`
var x = 1;
var y = 2;
console.log(x);
if (x == 1) {
  console.log("yes")
}
function unused() {
  return 42;
}
\`;

console.log("=== Source code ===");
console.log(code.trim());
console.log("");

// Lint with common rules
const messages = linter.verify(code, {
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  rules: {
    "no-var": "warn",
    "eqeqeq": "error",
    "semi": ["warn", "always"],
    "no-unused-vars": "warn",
  },
});

console.log("=== Lint results ===");
if (messages.length === 0) {
  console.log("No issues found!");
} else {
  for (const msg of messages) {
    const level = msg.severity === 2 ? "ERROR" : "WARN ";
    console.log(\`  \${level} line \${msg.line}:\${msg.column} — \${msg.message} [\${msg.ruleId}]\`);
  }
  const errors = messages.filter(m => m.severity === 2).length;
  const warnings = messages.filter(m => m.severity === 1).length;
  console.log(\`\\n  \${errors} error(s), \${warnings} warning(s)\`);
}
`,
  },

  // --- Toolchain: show all installed dev tool versions ---
  {
    path: "/examples/04-devtools/toolchain.js",
    content: `// Toolchain — display all dev tools installed in NanoVM
const fs = require("fs");
const path = require("path");

console.log("=== NanoVM JavaScript Toolchain ===");
console.log("Node.js", process.version, "(" + process.arch + ")");
console.log("");

// Read tool versions from package.json files
const tools = [
  { name: "npm",        path: "npm" },
  { name: "TypeScript",  path: "typescript" },
  { name: "ESLint",      path: "eslint" },
  { name: "Prettier",    path: "prettier" },
  { name: "pnpm",        path: "pnpm" },
  { name: "tsx",          path: "tsx" },
  { name: "Vitest",      path: "vitest" },
];

console.log("=== Installed tools ===");
for (const tool of tools) {
  try {
    const pkgJson = fs.readFileSync(
      "/usr/local/lib/node_modules/" + tool.path + "/package.json", "utf8"
    );
    const pkg = JSON.parse(pkgJson);
    console.log("  " + tool.name.padEnd(14) + "v" + pkg.version);
  } catch (e) {
    console.log("  " + tool.name.padEnd(14) + "(not installed)");
  }
}

// Check for scoped packages
const scoped = [
  { name: "@rsbuild/core", display: "Rsbuild" },
];
for (const tool of scoped) {
  try {
    const pkgJson = fs.readFileSync(
      "/usr/local/lib/node_modules/" + tool.name + "/package.json", "utf8"
    );
    const pkg = JSON.parse(pkgJson);
    console.log("  " + tool.display.padEnd(14) + "v" + pkg.version);
  } catch {
    console.log("  " + tool.display.padEnd(14) + "(not installed)");
  }
}

console.log("");

// Show disk usage of node_modules
var totalSize = 0;
var fileCount = 0;
function walk(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else { totalSize += st.size; fileCount++; }
      } catch {}
    }
  } catch {}
}
walk("/usr/local/lib/node_modules");

console.log("=== Environment stats ===");
console.log("  Files in node_modules: " + fileCount.toLocaleString());
console.log("  Total size:            " + (totalSize / 1024 / 1024).toFixed(1) + " MB");
console.log("  Platform:              " + process.platform + "/" + process.arch);
console.log("  Node.js:               " + process.version);
`,
  },

  // --- npm: explore installed packages ---
  {
    path: "/examples/04-devtools/npm-info.js",
    content: `// npm — explore globally installed packages
const fs = require("fs");
const path = require("path");

const npmPkg = JSON.parse(
  fs.readFileSync("/usr/local/lib/node_modules/npm/package.json", "utf8")
);
console.log("npm", npmPkg.version);
console.log("");

// List all globally installed packages
const modulesDir = "/usr/local/lib/node_modules";
const entries = fs.readdirSync(modulesDir).sort();

console.log("=== Globally installed packages ===");
for (const name of entries) {
  try {
    const pkgPath = name.startsWith("@")
      ? fs.readdirSync(path.join(modulesDir, name)).map(sub => path.join(name, sub))
      : [name];
    for (const p of pkgPath) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(modulesDir, p, "package.json"), "utf8")
      );
      const desc = (pkg.description || "").slice(0, 50);
      console.log(\`  \${p.padEnd(24)} v\${(pkg.version || "?").padEnd(10)} \${desc}\`);
    }
  } catch {}
}

// Count total files
let totalFiles = 0;
function countFiles(dir) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) countFiles(full);
        else totalFiles++;
      } catch {}
    }
  } catch {}
}
countFiles(modulesDir);
console.log(\`\\nTotal files in node_modules: \${totalFiles.toLocaleString()}\`);
`,
  },

  // --- TypeScript: AST parsing and analysis ---
  {
    path: "/examples/04-devtools/typecheck.js",
    content: `// TypeScript — parse source code into an AST and analyze it
const ts = require("/usr/local/lib/node_modules/typescript");

console.log("TypeScript", ts.version, "— AST parser");
console.log("");

const code = [
  'interface User {',
  '  id: number;',
  '  name: string;',
  '  role: "admin" | "user";',
  '}',
  '',
  'function createUser(name: string, role: "admin" | "user" = "user"): User {',
  '  return { id: Math.random(), name, role };',
  '}',
  '',
  'async function fetchUsers(): Promise<User[]> {',
  '  return [createUser("Alice", "admin"), createUser("Bob")];',
  '}',
  '',
  'const greet = (u: User): string => "Hello " + u.name;',
].join("\\n");

console.log("=== Source ===");
console.log(code);
console.log("");

// Parse into AST
const sourceFile = ts.createSourceFile("demo.ts", code, ts.ScriptTarget.ES2020, true);

// Walk the AST and collect declarations
const declarations = [];
function visit(node) {
  if (ts.isInterfaceDeclaration(node)) {
    const members = node.members.map(m => m.name ? m.name.getText(sourceFile) : "?");
    declarations.push({ kind: "interface", name: node.name.getText(sourceFile), members });
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    const params = node.parameters.map(p => p.name.getText(sourceFile));
    const isAsync = !!(node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
    declarations.push({ kind: "function", name: node.name.getText(sourceFile), params, async: isAsync });
  } else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isArrowFunction(decl.initializer)) {
        const params = decl.initializer.parameters.map(p => p.name.getText(sourceFile));
        declarations.push({ kind: "arrow fn", name: decl.name.getText(sourceFile), params });
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);

console.log("=== AST analysis ===");
for (const d of declarations) {
  if (d.kind === "interface") {
    console.log("  interface " + d.name + " { " + d.members.join(", ") + " }");
  } else if (d.kind === "function") {
    console.log("  " + (d.async ? "async " : "") + "function " + d.name + "(" + d.params.join(", ") + ")");
  } else {
    console.log("  const " + d.name + " = (" + d.params.join(", ") + ") => ...");
  }
}
console.log("");
console.log("Total statements:", sourceFile.statements.length);
console.log("Declarations found:", declarations.length);

// Emit JS from the AST (no type checker needed)
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const jsOutput = printer.printFile(sourceFile);
console.log("");
console.log("=== Emitted as JavaScript ===");
console.log(jsOutput.trim());
`,
  },

  // --- ESLint: auto-fix pipeline ---
  {
    path: "/examples/04-devtools/lint-and-format.js",
    content: `// ESLint auto-fix — find issues and automatically repair them
const { Linter } = require("/usr/local/lib/node_modules/eslint");

const linter = new Linter();

// Messy code with both style and logic issues
const input = \`
var items =   ["apple","banana",   "cherry"]
var total=0
for(var i=0;i<items.length;i++){
  if(items[i]=="banana"){
    total = total +1
  }
}
function   getTotal(  ){return total}
console.log( "total:" ,getTotal() )
\`;

console.log("=== Original code ===");
console.log(input.trim());
console.log("");

// Step 1: Find all issues
const rules = {
  "no-var": "warn",
  "eqeqeq": "error",
  "semi": ["error", "always"],
  "no-unused-vars": "warn",
  "no-multi-spaces": "warn",
  "space-infix-ops": "warn",
};

const messages = linter.verify(input, {
  languageOptions: { ecmaVersion: 2022 },
  rules,
});

console.log("=== Issues found (" + messages.length + ") ===");
for (const msg of messages) {
  const level = msg.severity === 2 ? "ERROR" : "WARN ";
  const fixable = msg.fix ? " [fixable]" : "";
  console.log(\`  \${level} line \${msg.line}:\${msg.column} \${msg.message}\${fixable}\`);
}

const errors = messages.filter(m => m.severity === 2).length;
const warnings = messages.filter(m => m.severity === 1).length;
const fixable = messages.filter(m => m.fix).length;
console.log(\`\\n  \${errors} error(s), \${warnings} warning(s), \${fixable} auto-fixable\`);
console.log("");

// Step 2: Auto-fix everything ESLint can
const result = linter.verifyAndFix(input, {
  languageOptions: { ecmaVersion: 2022 },
  rules,
});

console.log("=== After auto-fix (" + result.messages.length + " remaining) ===");
console.log(result.output.trim());

if (result.messages.length > 0) {
  console.log("");
  console.log("Remaining issues (not auto-fixable):");
  for (const msg of result.messages) {
    const level = msg.severity === 2 ? "ERROR" : "WARN ";
    console.log(\`  \${level} line \${msg.line}:\${msg.column} \${msg.message}\`);
  }
}
`,
  },
];

export function getExamples(): ExampleFile[] {
  return EXAMPLES;
}

export async function loadExamples(vm: any): Promise<void> {
  for (const example of EXAMPLES) {
    vm.addFile(example.path, example.content);
  }
}

/** Seed example files into OPFS if not already done. */
export async function seedOpfsExamples(): Promise<void> {
  if (await opfs.isSeeded()) return;
  for (const example of EXAMPLES) {
    await opfs.writeFile(example.path, example.content);
  }
  await opfs.markSeeded();
}
