#!/usr/bin/env node
/**
 * verify —— 离线探测清单三副本演练验收服务
 *
 * 执行顺序（任一步失败则最终以非零退出码报告）：
 *   1. 构建检查：所有源文件 node --check 语法校验、package.json 合法性、页面存在
 *   2. 代码测试：node --test 运行围绕迟到消息与稳定压缩的状态机测试
 *   3. API/HTTP 冒烟：
 *      - BASE_URL 已设置 → 对该地址（如 Compose 中的 web 服务）冒烟
 *      - 未设置 → 自行拉起 src/server.mjs 冒烟，结束后关闭
 *
 * 用法： node scripts/verify.mjs   （或 ./verify）
 */
import { spawn } from 'node:child_process';
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.BASE_URL || '';

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};
const useColor = process.stdout.isTTY || process.env.FORCE_COLOR;
for (const k of Object.keys(c)) {
  if (!useColor) c[k] = (s) => s;
}

let failures = 0;
function step(title) {
  console.log(`\n${c.cyan('▶ ' + title)}`);
}
function ok(msg) {
  console.log('  ' + c.green('✓') + ' ' + msg);
}
function bad(msg) {
  failures += 1;
  console.log('  ' + c.red('✗ ' + msg));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

async function listJs(dir) {
  const out = [];
  async function walk(d) {
    let items;
    try {
      items = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) await walk(full);
      else if (it.name.endsWith('.mjs') || it.name.endsWith('.js')) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

// ---------- 1. 构建检查 ----------
async function buildChecks() {
  step('构建检查：语法 / 清单 / 页面');
  const files = [...(await listJs(path.join(ROOT, 'src'))), ...(await listJs(path.join(ROOT, 'scripts')))];
  for (const f of files) {
    const code = await run(process.execPath, ['--check', f], { stdio: 'pipe' });
    if (code === 0) ok(`语法检查通过 ${path.relative(ROOT, f)}`);
    else bad(`语法错误 ${path.relative(ROOT, f)}`);
  }

  try {
    const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.type === 'module') ok('package.json 合法（ESM）');
    else bad('package.json 缺少 type=module');
  } catch (e) {
    bad(`package.json 不合法: ${e.message}`);
  }

  try {
    await access(path.join(ROOT, 'public', 'index.html'));
    ok('演练页面 public/index.html 存在');
  } catch {
    bad('缺少 public/index.html');
  }
}

// ---------- 2. 代码测试 ----------
async function codeTests() {
  step('代码测试：迟到消息抑制 / 重放幂等 / 非法拒绝 / 三方稳定压缩 / 重开不复活');
  const code = await run(process.execPath, ['--test', 'test/core.test.mjs']);
  if (code === 0) ok('状态机代码测试全部通过');
  else bad(`状态机代码测试失败（退出码 ${code}）`);
}

// ---------- 3. API/HTTP 冒烟 ----------
async function waitHealthy(url, ms = 8000) {
  const deadline = Date.now() + ms;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/healthz');
      if (r.ok) return true;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`服务未就绪 (${url}): ${lastErr}`);
}

async function startServer() {
  const port = 32000 + Math.floor(Math.random() * 4000);
  const url = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitHealthy(url);
  return { url, stop: () => p.kill('SIGTERM') };
}

async function httpSmoke(base) {
  const call = async (method, p, body) => {
    const opt = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(base + p, opt);
    return { status: r.status, json: await r.json() };
  };
  const expect = (cond, msg) => (cond ? ok(msg) : bad(msg));

  // 健康与页面
  const h = await call('GET', '/healthz');
  expect(h.status === 200 && h.json.status === 'ok', `GET /healthz → 200 ok（目标 ${base}）`);
  const page = await fetch(base + '/');
  expect(page.status === 200 && (await page.text()).includes('三副本演练'), 'GET / → 演练页面可访问');

  // 建演练
  const created = await call('POST', '/api/drills', { name: 'verify-smoke' });
  expect(created.status === 201 && created.json.id, 'POST /api/drills → 创建演练');
  const id = created.json.id;
  const ep = `/api/drills/${id}`;
  const ev = (event) => call('POST', `${ep}/events`, { event });

  // 新增 1/2/3 + A 绑定 seq=2 删除
  const seq = [];
  for (const e of [
    { type: 'add', replica: 'A', id: 'p', seq: 1, target: 't1' },
    { type: 'add', replica: 'A', id: 'p', seq: 2, target: 't2' },
    { type: 'add', replica: 'A', id: 'p', seq: 3, target: 't3' },
  ]) seq.push((await ev(e)).json.results[0].effect);
  expect(JSON.stringify(seq) === JSON.stringify(['added', 'added', 'added']), '新增 seq=1,2,3 全部接受');

  const d = await ev({ type: 'delete', replica: 'A', id: 'p', seq: 2 });
  expect(d.json.results[0].effect === 'deleted', '删除绑定当时观察到的新增点 seq=2');

  // 迟到旧新增 → 抑制
  const late = await ev({ type: 'add', replica: 'B', id: 'p', seq: 1, target: 't1' });
  expect(late.json.results[0].effect === 'suppressed', '乱序迟到的旧新增 seq=1 被墓碑覆盖并抑制');
  expect(late.json.view.suppressed.length === 1, '抑制记录作为证据留存 1 条');

  // 同消息重放 → duplicate，无第二份（回放完全相同的事件，派生 eventId 一致）
  const replay = await ev({ type: 'add', replica: 'B', id: 'p', seq: 1, target: 't1' });
  expect(replay.json.results[0].effect === 'duplicate', '同一消息重放返回 duplicate');
  expect(replay.json.view.suppressed.length === 1, '重放不产生第二份状态（抑制证据仍为 1 条）');

  // 载荷不一致 → 拒绝
  const conflict = await ev({ type: 'add', replica: 'C', id: 'p', seq: 1, target: 'WRONG' });
  expect(conflict.status === 422 && conflict.json.results[0].code === 'PAYLOAD_CONFLICT', '同一标识载荷不一致 → 422 拒绝');

  // 未三方稳定 → 压缩拒绝
  let c0 = await call('POST', `${ep}/compact`, { by: 'A' });
  expect(c0.status === 409 && c0.json.code === 'FRONTIER_NOT_STABLE', '三方未全部越过删除点 → 压缩 409 拒绝');

  // 非法事件不污染
  const badReplica = await ev({ type: 'add', replica: 'Z', id: 'q', seq: 1, target: 'x' });
  expect(badReplica.status === 422 && badReplica.json.results[0].code === 'UNKNOWN_REPLICA', '未知副本 → 422 拒绝');
  await ev({ type: 'add', replica: 'A', id: 'q', seq: 1, target: 'x' });
  const gap = await ev({ type: 'add', replica: 'A', id: 'q', seq: 3, target: 'x' });
  expect(gap.json.results[0].code === 'SEQ_GAP', '非法计数跳跃 1→3 拒绝');

  // B/C sync-ack 越过删除点
  await ev({ type: 'sync-ack', replica: 'B', id: 'p', seq: 2 });
  await ev({ type: 'sync-ack', replica: 'C', id: 'p', seq: 2 });
  const c1 = await call('POST', `${ep}/compact`, { by: 'A' });
  expect(c1.status === 200, '三方稳定前沿达成 → 压缩成功 200');
  expect(c1.json.compacted?.includes('p'), '压缩记录包含 id=p');
  expect(c1.json.view.tombstones.length === 0, '压缩后墓碑已移除（不无限保留）');
  const frontier = c1.json.record.items[0].observed;
  expect(JSON.stringify(frontier) === JSON.stringify({ A: 3, B: 2, C: 2 }), `压缩记录含三方稳定前沿 A/B/C = 3/2/2`);
  expect(JSON.stringify(c1.json.view.visible.filter((x) => x.id === 'p').map((x) => x.seq)) === '[3]', '删除点之上的 p#3 保持可见');

  // 压缩后重放
  const r1 = await ev({ type: 'add', replica: 'C', id: 'p', seq: 2, target: 't2' });
  expect(r1.json.results[0].effect === 'suppressed', '压缩后重放旧新增 seq=2 仍抑制');
  const r2 = await ev({ type: 'delete', replica: 'C', id: 'p', seq: 2 });
  expect(r2.json.results[0].effect === 'delete-obsolete', '压缩后重放旧删除不重建墓碑');
  const v2 = (await call('GET', ep)).json.view;
  expect(v2.tombstones.length === 0, '最终视图墓碑数仍为 0');

  // 重开后重放已压缩旧新增：C 首次交付 p#1 一致载荷 → 抑制；再发同事件 → 幂等
  await call('POST', `${ep}/reopen`, { replica: 'A' });
  const ro1 = await ev({ type: 'add', replica: 'C', id: 'p', seq: 1, target: 't1' });
  expect(ro1.json.results[0].effect === 'suppressed', '重开后重放已压缩旧新增 seq=1 仍抑制');
  const ro2 = await ev({ type: 'add', replica: 'C', id: 'p', seq: 1, target: 't1' });
  expect(ro2.json.results[0].effect === 'duplicate', '重开后同事件再次重放仍幂等');
  const v3 = (await call('GET', ep)).json.view;
  expect(v3.reopened === 1 && v3.tombstones.length === 0, '重开计数=1 且未产生新墓碑或可见复活条目');

  // 未知路由
  expect((await call('GET', '/no-such-path')).status === 404, '未知路由 → 404');
}

async function main() {
  console.log(c.yellow('════════ 离线探测清单三副本演练 · verify 验收 ════════'));
  console.log(c.gray(`时间 ${new Date().toISOString()}`));

  await buildChecks();
  await codeTests();

  step('API/HTTP 冒烟');
  let spawned = null;
  let base = BASE_URL;
  if (!base) {
    console.log('  ' + c.gray('（未设置 BASE_URL，自行拉起服务）'));
    spawned = await startServer();
    base = spawned.url;
  }
  try {
    await waitHealthy(base);
    await httpSmoke(base);
  } catch (e) {
    bad(`HTTP 冒烟异常: ${e.message}`);
  } finally {
    spawned?.stop();
  }

  console.log('\n' + c.yellow('════════ 验收结果 ════════'));
  if (failures === 0) {
    console.log(c.green('全部通过：构建检查 / 代码测试 / API·HTTP 冒烟'));
    process.exit(0);
  } else {
    console.log(c.red(`存在 ${failures} 项失败`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(c.red('verify 致命错误: ' + (e?.stack || e)));
  process.exit(2);
});
