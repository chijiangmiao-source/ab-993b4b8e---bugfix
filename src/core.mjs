/**
 * 离线探测清单 · 三副本状态机
 *
 * 语义约定
 * --------
 * 1. 新增 (add)：载荷 { id, seq, target }。seq 为该 id 的递增计数。
 *    - seq 必须从 1 开始，且不得凭空跳跃（maxSeq+k, k>1 → 非法跳跃拒绝）；
 *    - 投递目标任意、投递顺序任意：seq 小于全局最高新增点的“迟到旧新增”
 *      是合法消息，由删除上下文判定去留；
 *    - 同一 seq 重放必须载荷一致，冲突即拒（同一标识载荷不一致）；
 *    - 同一消息重放（eventId 去重）不产生第二份状态。
 * 2. 删除 (delete)：必须绑定“当时观察到的新增点” upToSeq ——
 *    发起副本必须已观察到该点，墓碑为区间 [1, upToSeq]。
 * 3. 乱序旧新增：seq <= 当前删除覆盖点（墓碑或已压缩水位）时被删除
 *    上下文覆盖，一律抑制（只记 suppressed 证据，不成可见条目、不建墓碑）；
 *    seq > 覆盖点才可见。
 * 4. 压缩 (compaction)：只有三个副本都确认越过同一删除点（各自
 *    observedSeq >= upToSeq）才允许；压缩后墓碑被移除（不无限保留），
 *    仅留压缩水位 compactedUpTo（标量）与 compaction 证据记录。
 *    压缩点之后重放旧新增仍抑制，重放旧删除不重建墓碑。
 * 5. 同步确认 (sync-ack)：某副本声明已观察到某 id 的某个新增点。
 * 6. 重开 (reopen)：演练可重开继续录入；已压缩历史不复活。
 *
 * 非法事件以 { ok:false, code, error } 拒绝并记入 rejected，且不修改状态。
 */

export const REPLICAS = Object.freeze(['A', 'B', 'C']);

export const ERROR_CODES = Object.freeze({
  UNKNOWN_REPLICA: 'UNKNOWN_REPLICA',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  BAD_SEQ: 'BAD_SEQ',
  SEQ_GAP: 'SEQ_GAP',
  PAYLOAD_CONFLICT: 'PAYLOAD_CONFLICT',
  DELETE_NO_ADD: 'DELETE_NO_ADD',
  DELETE_BEYOND_KNOWN: 'DELETE_BEYOND_KNOWN',
  BAD_TARGET: 'BAD_TARGET',
  MISSING_FIELD: 'MISSING_FIELD',
});

/**
 * @typedef {Object} Envelope
 * @property {string} type     add | delete | sync-ack | reopen
 * @property {string} replica  A | B | C（投递/观察该事件的副本）
 * @property {string} [id]     条目标识（add/delete/sync-ack）
 * @property {number} [seq]    add 的计数 / delete 绑定的新增点 / sync-ack 观察点
 * @property {string} [target] add 的任意投递目标
 * @property {string} [eventId] 去重标识；缺省由内容派生
 */

/** 规范化事件（派生 eventId），不做合法性判断 */
export function normalizeEvent(ev) {
  const e = { ...ev };
  if (e.type === 'add') {
    e.eventId = ev.eventId || `add:${e.replica}:${e.id}:${e.seq}:${ev.target ?? ''}`;
  } else if (e.type === 'delete' || e.type === 'sync-ack') {
    e.eventId = ev.eventId || `${e.type}:${e.replica}:${e.id}:${e.seq}`;
  } else if (e.type === 'reopen') {
    // reopen 是生命周期事件：未显式给 eventId 时每次调用都是独立事件；
    // 显式相同 eventId 的重放仍幂等。
    e.eventId =
      ev.eventId || `reopen:${e.replica}:${ev.at ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }
  return e;
}

/** 纯校验：返回 { ok:true, ev } 或 { ok:false, code, error }。不触碰状态。 */
export function validateEvent(rawEv, state) {
  if (!rawEv || typeof rawEv !== 'object') {
    return { ok: false, code: ERROR_CODES.UNKNOWN_TYPE, error: '事件必须是对象' };
  }
  const ev = normalizeEvent(rawEv);
  const { type, replica } = ev;

  if (!REPLICAS.includes(replica)) {
    return {
      ok: false,
      code: ERROR_CODES.UNKNOWN_REPLICA,
      error: `未知副本: ${JSON.stringify(replica)}，合法副本为 ${REPLICAS.join('/')}`,
    };
  }

  if (!['add', 'delete', 'sync-ack', 'reopen'].includes(type)) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_TYPE, error: `未知事件类型: ${type}` };
  }

  if (type === 'reopen') return { ok: true, ev };

  if (typeof ev.id !== 'string' || ev.id.length === 0) {
    return { ok: false, code: ERROR_CODES.MISSING_FIELD, error: '缺少条目标识 id' };
  }

  if (!Number.isInteger(ev.seq) || ev.seq < 1) {
    return {
      ok: false,
      code: ERROR_CODES.BAD_SEQ,
      error: `seq 必须是 >=1 的整数，收到 ${JSON.stringify(ev.seq)}`,
    };
  }

  if (type === 'add') {
    if (typeof ev.target !== 'string' || ev.target.length === 0) {
      return { ok: false, code: ERROR_CODES.BAD_TARGET, error: 'add 事件需要非空 target（任意投递目标）' };
    }
    const entry = state.entries[ev.id];
    if (entry) {
      // 同一 seq 的载荷指纹（可见版本或被删除/压缩封存的版本）
      const known = entry.versions.get(ev.seq) ?? entry.sealed.get(ev.seq);
      if (known !== undefined) {
        const knownTarget = typeof known === 'string' ? known : known.target;
        if (knownTarget !== ev.target) {
          return {
            ok: false,
            code: ERROR_CODES.PAYLOAD_CONFLICT,
            error: `id=${ev.id} seq=${ev.seq} 已封存 target=${JSON.stringify(
              knownTarget,
            )}，冲突载荷 ${JSON.stringify(ev.target)} 被拒绝`,
          };
        }
        // 同副本重复收到同一 seq 即消息重放；另一副本首次收到则是新交付
        const duplicate = (state.observed[ev.id]?.[replica] ?? 0) >= ev.seq;
        return { ok: true, ev, duplicate };
      }
      // 从未见过的 seq：
      //  - seq > maxSeq+1：非法计数跳跃（中间计数无据）
      //  - seq = maxSeq+1：正常递增
      //  - seq <= maxSeq ：乱序投递的迟到旧新增，合法，由删除上下文裁决
      const expected = entry.maxSeq + 1;
      if (ev.seq > expected) {
        return {
          ok: false,
          code: ERROR_CODES.SEQ_GAP,
          error: `id=${ev.id} 计数非法跳跃: 全局最高新增点 ${entry.maxSeq}，期望 seq=${expected}，收到 ${ev.seq}`,
        };
      }
    } else if (ev.seq !== 1) {
      return {
        ok: false,
        code: ERROR_CODES.SEQ_GAP,
        error: `id=${ev.id} 首次新增必须从 seq=1 开始，收到 ${ev.seq}`,
      };
    }
    return { ok: true, ev };
  }

  if (type === 'delete') {
    const entry = state.entries[ev.id];
    // 删除点必须真实存在过（可见版本、被封存指纹或已压缩水位均可为据）
    const everExisted =
      entry !== undefined &&
      (entry.versions.has(ev.seq) ||
        entry.sealed.has(ev.seq) ||
        entry.maxSeq >= ev.seq ||
        (entry.compactedUpTo ?? 0) >= ev.seq);
    if (!everExisted) {
      return {
        ok: false,
        code: ERROR_CODES.DELETE_NO_ADD,
        error: `删除无法绑定新增点: id=${ev.id} seq=${ev.seq} 在任何已观察记录中都不存在`,
      };
    }
    // 发起删除的副本必须已观察到该点（删除绑定“当时观察到的新增点”）
    const observed = state.observed[ev.id]?.[replica] ?? 0;
    if (observed < ev.seq) {
      return {
        ok: false,
        code: ERROR_CODES.DELETE_BEYOND_KNOWN,
        error: `副本 ${replica} 尚未观察到 id=${ev.id} seq=${ev.seq}（仅观察到 ${observed}），删除不得绑定未观察到的新增点`,
      };
    }
    return { ok: true, ev };
  }

  // sync-ack：观察点不能凭空超过集群已知最高新增点
  const entry = state.entries[ev.id];
  const knownMax = entry ? Math.max(entry.maxSeq, entry.compactedUpTo ?? 0) : 0;
  if (ev.seq > knownMax) {
    return {
      ok: false,
      code: ERROR_CODES.DELETE_BEYOND_KNOWN,
      error: `sync-ack 越界: id=${ev.id} 集群已知最高新增点为 ${knownMax}，收到 ${ev.seq}`,
    };
  }
  return { ok: true, ev };
}

/** 创建全新演练状态 */
export function createDrill(name = '未命名演练') {
  return {
    name,
    createdAt: new Date().toISOString(),
    reopened: 0,
    // id -> { versions: Map<seq,{target,firstSeenReplica,ts}>（当前活跃版本）,
    //         sealed: Map<seq,targetStr>（曾出现过的全部载荷指纹，用于冲突识别）,
    //         maxSeq, compactedUpTo }
    entries: Object.create(null),
    observed: Object.create(null), // id -> { A:n, B:n, C:n }
    tombstones: Object.create(null), // id -> { upToSeq, by:[...], at }
    suppressed: [], // 被抑制的迟到旧新增（证据）
    rejected: [], // 被明确拒绝的非法事件（证据）
    compactions: [], // 压缩记录（含三方前沿证据）
    log: [], // 已接受事件的有序日志
    seenEventIds: new Set(),
    stableFrontierSnapshot: null,
  };
}

function entryOf(state, id) {
  if (!state.entries[id]) {
    state.entries[id] = {
      versions: new Map(),
      sealed: new Map(),
      maxSeq: 0,
      compactedUpTo: 0,
    };
    state.observed[id] = { A: 0, B: 0, C: 0 };
  }
  return state.entries[id];
}

/** 某 id 当前删除覆盖点：墓碑优先，否则取已压缩水位 */
export function deletionCover(state, id) {
  if (state.tombstones[id]) return state.tombstones[id].upToSeq;
  return state.entries[id]?.compactedUpTo ?? 0;
}

/**
 * 投递/录入事件。
 * 返回 { ok:true, effect, ev } 或 { ok:false, code, error }。
 * 非法事件不修改状态（仅追加 rejected 证据）。
 */
export function applyEvent(state, rawEv) {
  const v = validateEvent(rawEv, state);
  if (!v.ok) {
    state.rejected.push({
      at: new Date().toISOString(),
      event: sanitize(rawEv),
      code: v.code,
      error: v.error,
    });
    return v;
  }
  const ev = v.ev;

  // 同一消息重放：以消息身份 eventId（显式提供或由 类型+副本+id+seq
  // [+target] 派生）为准。幂等返回，不产生第二份状态。
  // 注意：sync-ack 越过某点后再收到该点的新增，属于“迟到的旧新增”，
  // 仍要进入 applyAdd 由删除上下文裁决（作为抑制证据），不算静默重放。
  if (state.seenEventIds.has(ev.eventId)) {
    return { ok: true, effect: 'duplicate', ev };
  }

  let effect;
  switch (ev.type) {
    case 'add':
      effect = applyAdd(state, ev);
      break;
    case 'delete':
      effect = applyDelete(state, ev);
      break;
    case 'sync-ack':
      effect = applySyncAck(state, ev);
      break;
    case 'reopen':
      state.reopened += 1;
      effect = 'reopen';
      break;
  }

  state.seenEventIds.add(ev.eventId);
  state.log.push({ ...ev, at: new Date().toISOString(), effect });
  return { ok: true, effect, ev };
}

function applyAdd(state, ev) {
  const { id, seq, target, replica } = ev;
  const entry = entryOf(state, id);

  // 先记录“该副本是否已持有此版本”（必须在更新 observed 之前判断）
  const alreadyHeld = entry.versions.has(seq) && state.observed[id][replica] >= seq;
  // 投递即观察：即便消息随后被抑制，副本也确实收到了该新增点
  state.observed[id][replica] = Math.max(state.observed[id][replica], seq);

  // 被删除上下文覆盖（墓碑区间或已压缩水位）→ 抑制，不成可见条目不建墓碑。
  // 即使该副本已通过 sync-ack 越过此点，迟到的旧新增仍作为抑制证据留痕。
  const cover = deletionCover(state, id);
  if (seq <= cover) {
    if (!entry.sealed.has(seq)) entry.sealed.set(seq, target);
    state.suppressed.push({
      at: new Date().toISOString(),
      id,
      seq,
      target,
      replica,
      coverSeq: cover,
      reason: state.tombstones[id] ? 'tombstone' : 'compacted',
    });
    return 'suppressed';
  }

  // 未被覆盖且该副本已持有此版本 → 纯重放，不产生第二份状态
  if (alreadyHeld) return 'duplicate';

  // 新版本或同版本向另一副本的首次交付：补齐版本与观察关系，
  // 不覆盖版本首见元数据、不产生第二条版本记录
  if (!entry.versions.has(seq)) {
    entry.versions.set(seq, {
      target,
      firstSeenReplica: replica,
      ts: new Date().toISOString(),
    });
  }
  entry.sealed.set(seq, target);
  entry.maxSeq = Math.max(entry.maxSeq, seq);
  return 'added';
}

function applyDelete(state, ev) {
  const { id, seq, replica } = ev;
  const entry = entryOf(state, id);
  state.observed[id][replica] = Math.max(state.observed[id][replica], seq);

  // 已压缩：旧删除重放不得重建墓碑
  if ((entry.compactedUpTo ?? 0) >= seq && !state.tombstones[id]) {
    return 'delete-obsolete';
  }

  const existing = state.tombstones[id];
  if (existing) {
    if (!existing.by.includes(replica)) existing.by.push(replica);
    if (seq <= existing.upToSeq) return 'delete-duplicate'; // 不产生第二份墓碑
    existing.upToSeq = seq;
    pruneCoveredVersions(state, id, seq);
    return 'delete-advanced';
  }

  state.tombstones[id] = {
    id,
    upToSeq: seq,
    by: [replica],
    at: new Date().toISOString(),
  };
  pruneCoveredVersions(state, id, seq);
  return 'deleted';
}

function pruneCoveredVersions(state, id, upToSeq) {
  const entry = state.entries[id];
  if (!entry) return;
  for (const s of [...entry.versions.keys()]) {
    if (s <= upToSeq) entry.versions.delete(s);
  }
}

function applySyncAck(state, ev) {
  const { id, seq, replica } = ev;
  entryOf(state, id);
  const prev = state.observed[id][replica];
  if (seq <= prev) return 'sync-duplicate';
  state.observed[id][replica] = seq;
  return 'synced';
}

/**
 * 三方稳定前沿：对每个待压缩墓碑，三个副本 observedSeq 都 >= 删除点。
 */
export function stableFrontier(state) {
  const items = [];
  for (const id of Object.keys(state.tombstones)) {
    const upToSeq = state.tombstones[id].upToSeq;
    const obs = state.observed[id];
    const observed = { A: obs.A ?? 0, B: obs.B ?? 0, C: obs.C ?? 0 };
    items.push({
      id,
      deletePoint: upToSeq,
      observed,
      min: Math.min(observed.A, observed.B, observed.C),
      confirmed: REPLICAS.every((r) => observed[r] >= upToSeq),
    });
  }
  const pending = items.filter((x) => !x.confirmed);
  return {
    ready: items.length > 0 && pending.length === 0,
    items,
    pending,
  };
}

/**
 * 压缩：仅当三个副本都确认越过同一删除点。
 * 成功后移除墓碑（不无限保留），以标量水位 compactedUpTo 取代，
 * 并保留含三方前沿的压缩记录作为证据。
 */
export function compact(state, opts = {}) {
  const sf = stableFrontier(state);
  if (sf.items.length === 0) {
    return { ok: false, code: 'NOTHING_TO_COMPACT', error: '没有任何墓碑，无需压缩' };
  }
  if (sf.pending.length > 0) {
    return {
      ok: false,
      code: 'FRONTIER_NOT_STABLE',
      error: `三方稳定前沿未达成: ${sf.pending
        .map((p) => `${p.id}@${p.deletePoint}(三方观测 ${p.observed.A}/${p.observed.B}/${p.observed.C})`)
        .join('; ')}`,
      frontier: sf,
    };
  }

  const record = {
    at: new Date().toISOString(),
    index: state.compactions.length + 1,
    trigger: opts.by ? `replica:${opts.by}` : 'manual',
    items: sf.items.map((x) => ({ id: x.id, deletePoint: x.deletePoint, observed: { ...x.observed }, min: x.min })),
  };

  for (const item of sf.items) {
    const entry = state.entries[item.id];
    entry.compactedUpTo = Math.max(entry.compactedUpTo, item.deletePoint);
    pruneCoveredVersions(state, item.id, item.deletePoint);
    delete state.tombstones[item.id];
  }

  state.compactions.push(record);
  state.stableFrontierSnapshot = { at: record.at, items: record.items.map((x) => ({ ...x })) };
  return { ok: true, compacted: record.items.map((x) => x.id), record };
}

/** 视图：页面/API 需要展示的全部内容 */
export function view(state) {
  const visible = [];
  for (const [id, entry] of Object.entries(state.entries)) {
    const cover = deletionCover(state, id);
    for (const [seq, v] of entry.versions.entries()) {
      if (seq > cover) {
        visible.push({ id, seq: Number(seq), target: v.target, firstSeenReplica: v.firstSeenReplica });
      }
    }
  }
  visible.sort((a, b) => (a.id === b.id ? a.seq - b.seq : a.id < b.id ? -1 : 1));

  // 各副本视角：版本已被该副本观察到（observed >= seq）且高于删除覆盖点
  const visibleAt = { A: [], B: [], C: [] };
  for (const item of visible) {
    for (const r of REPLICAS) {
      if ((state.observed[item.id]?.[r] ?? 0) >= item.seq) {
        visibleAt[r].push(item);
      }
    }
  }

  const knownFrontier = {};
  for (const [id, obs] of Object.entries(state.observed)) {
    const entry = state.entries[id];
    knownFrontier[id] = {
      A: obs.A,
      B: obs.B,
      C: obs.C,
      maxKnownAdd: Math.max(entry?.maxSeq ?? 0, entry?.compactedUpTo ?? 0),
      compactedUpTo: entry?.compactedUpTo ?? 0,
    };
  }

  return {
    name: state.name,
    createdAt: state.createdAt,
    reopened: state.reopened,
    visible,
    visibleAt,
    knownFrontier,
    tombstones: Object.values(state.tombstones),
    suppressed: state.suppressed,
    rejected: state.rejected,
    compactions: state.compactions,
    stableFrontier: stableFrontier(state),
    lastStable: state.stableFrontierSnapshot,
    eventCount: state.log.length,
    log: state.log.map(({ at, effect, ...rest }) => ({ at, effect, ...rest })),
  };
}

function sanitize(ev) {
  try {
    return JSON.parse(JSON.stringify(ev ?? null));
  } catch {
    return String(ev);
  }
}
