import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  compact,
  createDrill,
  deletionCover,
  stableFrontier,
  view,
  ERROR_CODES,
} from '../src/core.mjs';

const add = (replica, id, seq, target, eventId) => ({ type: 'add', replica, id, seq, target, eventId });
const del = (replica, id, seq, eventId) => ({ type: 'delete', replica, id, seq, eventId });
const ack = (replica, id, seq) => ({ type: 'sync-ack', replica, id, seq });

function visIds(v, id) {
  return v.visible.filter((x) => x.id === id).map((x) => x.seq);
}

test('乱序迟到的旧新增：被删除上下文覆盖时抑制，不复活；之后的新高版本仍可见', () => {
  const s = createDrill();
  assert.equal(applyEvent(s, add('A', 'p', 1, 't1')).effect, 'added');
  assert.equal(applyEvent(s, add('A', 'p', 2, 't2')).effect, 'added');
  // A 删除时必须观察到 seq=2（投递即观察），绑定删除点 2
  assert.equal(applyEvent(s, del('A', 'p', 2)).effect, 'deleted');
  // B 迟到的旧新增 seq=1（已删除）→ 抑制
  const r1 = applyEvent(s, add('B', 'p', 1, 't1'));
  assert.equal(r1.effect, 'suppressed');
  // 另一副本迟到 seq=2 也抑制
  assert.equal(applyEvent(s, add('C', 'p', 2, 't2')).effect, 'suppressed');
  const v = view(s);
  assert.deepEqual(visIds(v, 'p'), []);
  assert.equal(v.suppressed.length, 2);
  assert.equal(v.tombstones.length, 1);
  // 删除点之后的新增可见
  assert.equal(applyEvent(s, add('C', 'p', 3, 't3')).effect, 'added');
  assert.deepEqual(visIds(view(s), 'p'), [3]);
});

test('乱序旧新增在未被删除覆盖时可见', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  // B 观察点为 0，迟到投递 seq=1、seq=2（无删除）→ 合法且可见
  assert.equal(applyEvent(s, add('B', 'p', 1, 't1')).effect, 'added');
  assert.equal(applyEvent(s, add('B', 'p', 2, 't2')).effect, 'added');
  const v = view(s);
  assert.deepEqual(visIds(v, 'p'), [1, 2]);
  // 副本视角：B 两条都可见；C 一条未见
  assert.equal(v.visibleAt.B.length, 2);
  assert.equal(v.visibleAt.C.length, 0);
});

test('同一消息重放不产生第二份状态（add/delete/sync-ack）', () => {
  const s = createDrill();
  const a1 = add('A', 'p', 1, 't1', 'msg-uuid-1');
  assert.equal(applyEvent(s, a1).effect, 'added');
  assert.equal(applyEvent(s, a1).effect, 'duplicate');
  assert.equal(applyEvent(s, add('A', 'p', 1, 't1')).effect, 'duplicate'); // 派生 eventId 亦同
  assert.equal(view(s).visible.length, 1);

  applyEvent(s, add('A', 'p', 2, 't2'));
  const d = del('A', 'p', 2, 'del-uuid');
  applyEvent(s, d);
  assert.equal(applyEvent(s, d).effect, 'duplicate'); // 同一消息精确重放
  // 内容相同、身份不同的删除消息：同样不得产生第二份墓碑
  assert.equal(applyEvent(s, del('A', 'p', 2)).effect, 'delete-duplicate');
  assert.equal(view(s).tombstones.length, 1);

  const k = ack('B', 'p', 2);
  assert.equal(applyEvent(s, k).effect, 'synced');
  assert.equal(applyEvent(s, k).effect, 'duplicate'); // 精确重放
  assert.equal(view(s).knownFrontier.p.B, 2); // 观察点不被重复推进
  // 同点确认身份不同时也是幂等的
  assert.equal(applyEvent(s, { ...ack('B', 'p', 2), eventId: 'ack-again' }).effect, 'sync-duplicate');
});

test('非法计数跳跃被拒绝且不污染状态', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  const r = applyEvent(s, add('A', 'p', 3, 't3'));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.SEQ_GAP);
  // 拒绝后状态不被污染：seq=2 仍可正常录入，maxSeq 仍为 1
  assert.equal(applyEvent(s, add('A', 'p', 2, 't2')).effect, 'added');
  const v = view(s);
  assert.deepEqual(visIds(v, 'p'), [1, 2]);
  assert.equal(v.rejected.length, 1);

  // 首次不从 1 开始
  const r2 = applyEvent(s, add('B', 'q', 5, 'x'));
  assert.equal(r2.code, ERROR_CODES.SEQ_GAP);
  assert.equal(view(s).knownFrontier.q, undefined);
});

test('同一标识载荷不一致被拒绝（含被删除/压缩封存的 seq）', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  const bad = applyEvent(s, add('B', 'p', 1, 'OTHER'));
  assert.equal(bad.code, ERROR_CODES.PAYLOAD_CONFLICT);
  // 删除后，封存指纹仍能识别冲突
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, del('A', 'p', 2));
  const bad2 = applyEvent(s, add('C', 'p', 2, 'HAX'));
  assert.equal(bad2.code, ERROR_CODES.PAYLOAD_CONFLICT);
  // 一致载荷的迟到重放 → 抑制而非拒绝
  assert.equal(applyEvent(s, add('C', 'p', 1, 't1')).effect, 'suppressed');
});

test('未知副本 / 未知类型 / 畸形 seq 被明确拒绝', () => {
  const s = createDrill();
  assert.equal(applyEvent(s, add('X', 'p', 1, 't')).code, ERROR_CODES.UNKNOWN_REPLICA);
  assert.equal(applyEvent(s, { type: 'nuke', replica: 'A', id: 'p', seq: 1 }).code, ERROR_CODES.UNKNOWN_TYPE);
  assert.equal(applyEvent(s, { type: 'add', replica: 'A', id: 'p', seq: 0, target: 't' }).code, ERROR_CODES.BAD_SEQ);
  assert.equal(applyEvent(s, { type: 'add', replica: 'A', id: 'p', seq: 1, target: '' }).code, ERROR_CODES.BAD_TARGET);
  assert.equal(view(s).visible.length, 0);
  assert.equal(view(s).rejected.length, 4);
});

test('删除必须绑定当时观察到的新增点', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  // B 尚未观察到任何点 → 拒绝其删除
  assert.equal(applyEvent(s, del('B', 'p', 2)).code, ERROR_CODES.DELETE_BEYOND_KNOWN);
  // 绑定不存在的点
  assert.equal(applyEvent(s, del('A', 'p', 9)).code, ERROR_CODES.DELETE_NO_ADD);
  // B 经 sync-ack 越过后可删
  applyEvent(s, ack('B', 'p', 2));
  assert.equal(applyEvent(s, del('B', 'p', 2)).effect, 'deleted');
});

test('乱序非连续投递：副本仅可见实际收到的版本，未越过删除点的副本阻止压缩', () => {
  const s = createDrill();
  // A 依次录入 p 的第 1、2、3 版
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, add('A', 'p', 3, 't3'));
  // B 只收到第 3 版（非连续投递：未收到 1、2）
  assert.equal(applyEvent(s, add('B', 'p', 3, 't3')).effect, 'added');

  const v1 = view(s);
  // B 只能显示自己实际收到的第 3 版，不得显示未收到的 1、2
  assert.deepEqual(v1.visibleAt.B.map((x) => x.seq), [3]);
  // 非连续投递不得推进 B 的连续观察前沿
  assert.equal(v1.knownFrontier.p.B, 0);
  // A 连续录入，三个版本均可见
  assert.deepEqual(v1.visibleAt.A.map((x) => x.seq), [1, 2, 3]);

  // A 删除至第 2 版；仅 C 对该点发出同步确认
  assert.equal(applyEvent(s, del('A', 'p', 2)).effect, 'deleted');
  assert.equal(applyEvent(s, ack('C', 'p', 2)).effect, 'synced');

  // B 未收到也未确认第 2 版 → 不能视为已越过该删除点 → 压缩必须被拒绝
  const sf = stableFrontier(s);
  assert.equal(sf.ready, false);
  assert.deepEqual(sf.items[0].observed, { A: 3, B: 0, C: 2 });
  const r = compact(s);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FRONTIER_NOT_STABLE');

  // 删除后 B 的视图仍只含实际投递的第 3 版
  assert.deepEqual(view(s).visibleAt.B.map((x) => x.seq), [3]);

  // B 补齐迟到的 1、2（被墓碑覆盖 → 抑制，但投递即观察）后前沿连续推进，压缩放行
  assert.equal(applyEvent(s, add('B', 'p', 1, 't1')).effect, 'suppressed');
  assert.equal(applyEvent(s, add('B', 'p', 2, 't2')).effect, 'suppressed');
  assert.equal(view(s).knownFrontier.p.B, 3);
  assert.equal(compact(s).ok, true);
});

test('只有三方都越过同一删除点才能压缩，压缩移除墓碑并保留证据', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, add('A', 'p', 3, 't3'));
  applyEvent(s, del('A', 'p', 2));

  // 无三方确认 → 压缩拒绝
  let r = compact(s);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FRONTIER_NOT_STABLE');
  assert.equal(stableFrontier(s).ready, false);

  applyEvent(s, ack('B', 'p', 2));
  assert.equal(compact(s).code, 'FRONTIER_NOT_STABLE'); // 仍缺 C
  applyEvent(s, ack('C', 'p', 2));

  const sf = stableFrontier(s);
  assert.equal(sf.ready, true);
  assert.deepEqual(sf.items[0].observed, { A: 3, B: 2, C: 2 });

  r = compact(s, { by: 'A' });
  assert.equal(r.ok, true);
  const v = view(s);
  assert.equal(v.tombstones.length, 0, '墓碑必须被移除（不无限保留）');
  assert.equal(v.compactions.length, 1);
  assert.deepEqual(v.compactions[0].items[0].observed, { A: 3, B: 2, C: 2 });
  // 压缩点之上的 seq=3 仍可见
  assert.deepEqual(visIds(v, 'p'), [3]);
  // 压缩水位
  assert.equal(v.knownFrontier.p.compactedUpTo, 2);
});

test('压缩后重放旧新增仍抑制且不建新墓碑；旧删除不复活墓碑', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, del('A', 'p', 2));
  applyEvent(s, ack('B', 'p', 2));
  applyEvent(s, ack('C', 'p', 2));
  compact(s);
  assert.equal(view(s).tombstones.length, 0);

  // 重放已压缩的旧新增（任意副本、任意目标一致）→ 抑制
  const r = applyEvent(s, add('C', 'p', 1, 't1'));
  assert.equal(r.effect, 'suppressed');
  assert.equal(applyEvent(s, add('B', 'p', 2, 't2')).effect, 'suppressed');
  // 重放旧删除 → 不重建墓碑
  assert.equal(applyEvent(s, del('A', 'p', 1)).effect, 'delete-obsolete');
  assert.equal(applyEvent(s, del('C', 'p', 2)).effect, 'delete-obsolete');

  const v = view(s);
  assert.equal(v.tombstones.length, 0);
  assert.equal(v.suppressed.length, 2);
  assert.deepEqual(visIds(v, 'p'), []);
  // 压缩点之上新增照常
  assert.equal(applyEvent(s, add('A', 'p', 3, 't3')).effect, 'added');
});

test('重开后重放已压缩旧新增仍不生成可见条目或新墓碑', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, add('A', 'p', 3, 't3'));
  applyEvent(s, del('A', 'p', 2));
  applyEvent(s, ack('B', 'p', 2));
  applyEvent(s, ack('C', 'p', 2));
  compact(s);
  assert.equal(s.reopened, 0);

  const r = applyEvent(s, { type: 'reopen', replica: 'A' });
  assert.equal(r.effect, 'reopen');
  assert.equal(s.reopened, 1);

  // 重放压缩区间旧新增
  assert.equal(applyEvent(s, add('C', 'p', 1, 't1')).effect, 'suppressed');
  assert.equal(applyEvent(s, add('C', 'p', 2, 't2')).effect, 'suppressed');
  // 旧删除
  assert.equal(applyEvent(s, del('C', 'p', 2)).effect, 'delete-obsolete');

  const v = view(s);
  assert.equal(v.tombstones.length, 0);
  assert.deepEqual(visIds(v, 'p'), [3]);
  assert.equal(v.compactions.length, 1);
});

test('多 id 混合：一个未稳定则整体拒绝压缩；全部稳定后压缩且不影响新删除', () => {
  const s = createDrill();
  for (const id of ['x', 'y']) {
    applyEvent(s, add('A', id, 1, 't'));
    applyEvent(s, del('A', id, 1));
  }
  applyEvent(s, ack('B', 'x', 1));
  applyEvent(s, ack('C', 'x', 1));
  // y 只有 A 越过 → 不得压缩
  assert.equal(compact(s).code, 'FRONTIER_NOT_STABLE');
  applyEvent(s, ack('B', 'y', 1));
  applyEvent(s, ack('C', 'y', 1));
  const r = compact(s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.compacted.sort(), ['x', 'y']);
  assert.equal(deletionCover(s, 'x'), 1);
  assert.equal(view(s).tombstones.length, 0);
});

test('墓碑推进：更高删除点扩展覆盖；同步确认不能越过已知最高新增点', () => {
  const s = createDrill();
  applyEvent(s, add('A', 'p', 1, 't1'));
  applyEvent(s, add('A', 'p', 2, 't2'));
  applyEvent(s, add('A', 'p', 3, 't3'));
  applyEvent(s, del('A', 'p', 1));
  assert.equal(applyEvent(s, del('A', 'p', 3)).effect, 'delete-advanced');
  assert.equal(view(s).tombstones[0].upToSeq, 3);
  const bad = applyEvent(s, ack('B', 'p', 9));
  assert.equal(bad.code, ERROR_CODES.DELETE_BEYOND_KNOWN);
});
