/**
 * net/http server: create HTTP server, make request, parse response.
 * Tests in-process loopback networking via NanoVM's socket layer.
 */
const http = require('http');
const url = require('url');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

const PORT = 18923;

// Create server
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/echo') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        path: parsed.pathname,
        query: parsed.query,
        body: body
      }));
    });
  } else if (parsed.pathname === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello NanoVM');
  } else if (parsed.pathname === '/status') {
    const code = parseInt(parsed.query.code) || 200;
    res.writeHead(code);
    res.end('status ' + code);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  check('server-listening', true);
  runTests();
});

server.on('error', (e) => {
  process.stderr.write('  FAIL server-listen: ' + e.message + '\n');
  console.log('PASS: net-http ' + ok + '/' + total);
  process.exit(1);
});

function makeRequest(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function runTests() {
  try {
    // GET /hello
    const r1 = await makeRequest('/hello');
    check('get-status', r1.statusCode === 200);
    check('get-body', r1.data === 'Hello NanoVM');
    check('get-content-type', r1.headers['content-type'] === 'text/plain');

    // POST /echo with body
    const r2 = await makeRequest('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'test123' },
      body: '{"key":"value"}'
    });
    check('post-status', r2.statusCode === 200);
    const echo = JSON.parse(r2.data);
    check('echo-method', echo.method === 'POST');
    check('echo-path', echo.path === '/echo');
    check('echo-body', echo.body === '{"key":"value"}');

    // GET /echo?foo=bar&num=42
    const r3 = await makeRequest('/echo?foo=bar&num=42');
    const q = JSON.parse(r3.data);
    check('query-foo', q.query.foo === 'bar');
    check('query-num', q.query.num === '42');

    // 404 on unknown path
    const r4 = await makeRequest('/unknown');
    check('unknown-404', r4.statusCode === 404);

  } catch (e) {
    process.stderr.write('  FAIL request: ' + e.message + '\n');
  }

  server.close(() => {
    console.log('PASS: net-http ' + ok + '/' + total);
    process.exit(ok === total ? 0 : 1);
  });
}

// Safety timeout
setTimeout(() => {
  process.stderr.write('  TIMEOUT: net-http tests exceeded 30s\n');
  console.log('PASS: net-http ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
}, 30000);
