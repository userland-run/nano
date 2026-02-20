// HTTP server throughput: count requests completed in a fixed time window
const http = require('http');
const N_REQUESTS = 50;
const t0 = Date.now();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.listen(19876, '127.0.0.1', () => {
  let completed = 0;

  function makeReq() {
    if (completed >= N_REQUESTS) {
      server.close(() => {
        const ms = Date.now() - t0;
        const rps = Math.round(completed / (ms / 1000));
        console.log(`BENCH: http-throughput reqs=${completed} rps=${rps} ${ms}ms`);
      });
      return;
    }
    http.get('http://127.0.0.1:19876/', (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        completed++;
        makeReq();
      });
    }).on('error', (e) => {
      completed++;
      makeReq();
    });
  }

  // Sequential requests
  makeReq();
});

server.on('error', (e) => {
  const ms = Date.now() - t0;
  console.log(`BENCH: http-throughput reqs=0 rps=0 ${ms}ms`);
});

setTimeout(() => {
  process.exit(0);
}, 60000);
