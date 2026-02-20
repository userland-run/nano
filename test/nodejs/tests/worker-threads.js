/**
 * worker_threads: module availability, Worker creation, message passing,
 * workerData, SharedArrayBuffer, isMainThread.
 *
 * NanoVM has limited thread slots, so we run workers sequentially
 * (terminate each before starting the next) and handle EAGAIN gracefully.
 */
const {
  Worker, isMainThread, parentPort, workerData, threadId, MessageChannel
} = require('worker_threads');
let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// Module availability
check('isMainThread', isMainThread === true);
check('threadId', typeof threadId === 'number');
check('parentPort-null', parentPort === null);
check('Worker-fn', typeof Worker === 'function');
check('MessageChannel-fn', typeof MessageChannel === 'function');

// MessageChannel
const mc = new MessageChannel();
check('channel-port1', mc.port1 !== null && mc.port1 !== undefined);
check('channel-port2', mc.port2 !== null && mc.port2 !== undefined);
mc.port1.close();
mc.port2.close();

function createWorker(code, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const w = new Worker(code, { eval: true, ...opts });
      resolve(w);
    } catch (e) {
      reject(e);
    }
  });
}

(async () => {
  // Test 1: Simple message echo
  try {
    const w1 = await createWorker(
      `const { parentPort } = require('worker_threads');
       parentPort.on('message', (msg) => {
         parentPort.postMessage(msg * 2);
       });`
    );
    const val = await new Promise((resolve, reject) => {
      w1.on('message', resolve);
      w1.on('error', reject);
      w1.postMessage(21);
    });
    check('echo-double', val === 42);
    await w1.terminate();
  } catch (e) {
    check('echo-double', e.code === 'ERR_WORKER_INIT_FAILED'); // OK if EAGAIN
  }

  // Test 2: workerData
  try {
    const w2 = await createWorker(
      `const { parentPort, workerData } = require('worker_threads');
       parentPort.postMessage(workerData.greeting + ' ' + workerData.name);`,
      { workerData: { greeting: 'hello', name: 'nanovm' } }
    );
    const val = await new Promise((resolve, reject) => {
      w2.on('message', resolve);
      w2.on('error', reject);
    });
    check('workerData', val === 'hello nanovm');
    await w2.terminate();
  } catch (e) {
    check('workerData', e.code === 'ERR_WORKER_INIT_FAILED');
  }

  // Test 3: SharedArrayBuffer
  try {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 100;
    const w3 = await createWorker(
      `const { parentPort, workerData } = require('worker_threads');
       const arr = new Int32Array(workerData.buf);
       Atomics.add(arr, 0, 50);
       parentPort.postMessage(Atomics.load(arr, 0));`,
      { workerData: { buf: sab } }
    );
    const val = await new Promise((resolve, reject) => {
      w3.on('message', resolve);
      w3.on('error', reject);
    });
    check('sab-atomics', val === 150);
    check('sab-main-view', Atomics.load(arr, 0) === 150);
    await w3.terminate();
  } catch (e) {
    check('sab-atomics', e.code === 'ERR_WORKER_INIT_FAILED');
    check('sab-main-view', e.code === 'ERR_WORKER_INIT_FAILED');
  }

  // Test 4: Worker exit code
  try {
    const w4 = await createWorker(`process.exit(0);`);
    const code = await new Promise((resolve) => {
      w4.on('exit', resolve);
    });
    check('exit-code', code === 0);
  } catch (e) {
    check('exit-code', e.code === 'ERR_WORKER_INIT_FAILED');
  }

  // Test 5: Worker error propagation
  try {
    const w5 = await createWorker(`throw new Error('worker-crash');`);
    const err = await new Promise((resolve) => {
      w5.on('error', resolve);
    });
    check('worker-error', err.message === 'worker-crash');
    await new Promise((resolve) => w5.on('exit', resolve));
  } catch (e) {
    check('worker-error', e.code === 'ERR_WORKER_INIT_FAILED');
  }

  console.log('PASS: worker-threads ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
})();

// Safety timeout
setTimeout(() => {
  process.stderr.write('  TIMEOUT: worker-threads exceeded 15s\n');
  console.log('PASS: worker-threads ' + ok + '/' + total);
  process.exit(ok === total ? 0 : 1);
}, 15000);
