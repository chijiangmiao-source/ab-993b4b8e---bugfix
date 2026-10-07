import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let base;
let proc;

async function waitHealthy(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 未就绪，重试 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪: ${url}`);
}

before(async () => {
  const port = 31000 + Math.floor(Math.random() * 4000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitHealthy(`${base}/healthz`);
});

after(() => proc?.kill('SIGTERM'));

async function call(method, p, body) {
  const opt = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(base + p, opt);
  return { status: r.status, json: await r.json() };
}

test('健康响应与页面', async () => {
  const h = await call('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.json.status, 'ok');

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /三副本演练/);
});

test('端到端：迟到消息抑制 → 未稳定拒绝压缩 → 三方稳定压缩 → 重放不复活 → 非法事件 422', async () => {
  const created = await call('POST', '/api/drills', { name: 'http-smoke' });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const ep = `/api/drills/${id}`;
  const ev = (event) => call('POST', `${ep}/events`, { event });

  const effects = [];
  for (const e of [
    { type: 'add', replica: 'A', id: 'p', seq: 1, target: 't1' },
    { type: 'add', replica: 'A', id: 'p', seq: 2, target: 't2' },
    { type: 'add', replica: 'A', id: 'p', seq: 3, target: 't3' },
    { type: 'delete', replica: 'A', id: 'p', seq: 2 },
  ]) {
    const r = await ev(e);
    effects.push(r.json.results[0].effect);
  }
  assert.deepEqual(effects, ['added', 'added', 'added', 'deleted']);

  // 迟到旧新增 → 抑制
  const late = await ev({ type: 'add', replica: 'B', id: 'p', seq: 1, target: 't1' });
  assert.equal(late.json.results[0].effect, 'suppressed');

  // 未三方稳定 → 压缩 409
  let c = await call('POST', `${ep}/compact`, { by: 'A' });
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'FRONTIER_NOT_STABLE');

  // 精确消息重放 → duplicate，无第二份状态
  const msg = { type: 'add', replica: 'A', id: 'p', seq: 1, target: 't1', eventId: 'fixed-1' };
  // 先以该身份补一次不存在的交付路径不合适（seq1 已被墓碑覆盖）→ suppressed；
  // 再用同一 eventId 重放必须 duplicate
  const first = await ev(msg);
  assert.equal(first.json.results[0].effect, 'suppressed');
  const replay = await ev(msg);
  assert.equal(replay.json.results[0].effect, 'duplicate');
  assert.equal(replay.json.view.suppressed.length, 2, '重放不得追加第二份抑制记录');

  // B/C 越过删除点后压缩成功
  await ev({ type: 'sync-ack', replica: 'B', id: 'p', seq: 2 });
  await ev({ type: 'sync-ack', replica: 'C', id: 'p', seq: 2 });
  c = await call('POST', `${ep}/compact`, { by: 'A' });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.compacted, ['p']);
  assert.equal(c.json.view.tombstones.length, 0);
  assert.deepEqual(c.json.view.compactions[0].items[0].observed, { A: 3, B: 2, C: 2 });

  // 压缩后旧新增仍抑制、旧删除不重建墓碑
  assert.equal((await ev({ type: 'add', replica: 'C', id: 'p', seq: 2, target: 't2' })).json.results[0].effect, 'suppressed');
  assert.equal((await ev({ type: 'delete', replica: 'C', id: 'p', seq: 2 })).json.results[0].effect, 'delete-obsolete');
  const finalView = (await call('GET', ep)).json.view;
  assert.equal(finalView.tombstones.length, 0);
  assert.deepEqual(finalView.visible.map((x) => x.seq), [3]);

  // 非法事件 → 422 且不污染
  const bad1 = await ev({ type: 'add', replica: 'Z', id: 'q', seq: 1, target: 'x' });
  assert.equal(bad1.status, 422);
  assert.equal(bad1.json.results[0].code, 'UNKNOWN_REPLICA');
  const bad2 = await ev({ type: 'add', replica: 'A', id: 'q', seq: 4, target: 'x' });
  assert.equal(bad2.json.results[0].code, 'SEQ_GAP');
  assert.equal((await call('GET', ep)).json.view.knownFrontier.q, undefined);

  // 重开
  const ro = await call('POST', `${ep}/reopen`, { replica: 'A' });
  assert.equal(ro.json.view.reopened, 1);
});

test('未知路由与未知演练返回明确错误', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/api/drills/does-not-exist')).status, 404);
});
