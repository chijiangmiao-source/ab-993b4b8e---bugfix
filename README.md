# 离线探测清单 · 三副本演练（深空协作组）

在一个页面上建立三个副本（A/B/C）的演练，录入**新增、删除、同步确认、重开**事件，
实时查看各副本的可见条目、已知前沿、墓碑、被抑制的迟到消息与压缩记录。

## 要解决的问题

> 已删除条目不得因迟到的旧新增消息在任一终端重新出现；同时避免无限保留删除墓碑。

核心机制：**删除绑定当时观察到的新增点**，墓碑为区间 `[1, upToSeq]`；
乱序投递的旧新增只有在**未被删除上下文覆盖**时才可见；当三个副本都确认越过
同一删除点（三方稳定前沿）后才允许压缩，压缩移除墓碑、仅保留标量水位与证据记录。

## 语义规则

| 场景 | 行为 |
|---|---|
| 新增 `add {id, seq, target}` | `seq` 从 1 起、不得跳跃（`maxSeq+k` 拒绝）；`target` 为任意投递目标，投递顺序任意 |
| 乱序旧新增 `seq ≤ maxSeq` | 合法；`seq ≤ 删除覆盖点` → **抑制**（仅留证据），否则可见 |
| 非连续投递（副本缺中间版本） | 该副本仅实际收到的版本可见；其观察前沿不越过缺口，压缩不得视为已越过删除点 |
| 删除 `delete {id, seq}` | 必须绑定发起副本**当时已观察到**且真实存在的新增点，否则拒绝 |
| 消息重放 | 以 `eventId`（显式或由内容+副本派生）去重，返回 `duplicate`，不产生第二份状态 |
| 同一 `id/seq` 载荷不一致 | `PAYLOAD_CONFLICT` 明确拒绝（即使该点已删除/压缩，仍保留载荷指纹校验） |
| 未知副本 / 非法计数跳跃 / 越界 sync-ack | 明确拒绝（422），记入 rejected 证据，**不污染演练状态** |
| 压缩 | 仅当 A、B、C 的观察点都 `≥ 删除点`；压缩后墓碑删除，仅留 `compactedUpTo` 水位与含三方前沿的压缩记录 |
| 压缩后旧新增重放 | 仍抑制；旧删除重放返回 `delete-obsolete`，**不重建墓碑** |
| 重开 `reopen` | 演练继续录入；已压缩区间不复活、不产生新墓碑 |

## 运行

零第三方依赖，Node ≥ 20。

```bash
npm start                 # 默认 http://localhost:3000
PORT=8080 npm start       # 自定义端口（HOST 可配置，默认 0.0.0.0）
```

打开根路径即为演练页面；`GET /healthz` 返回健康响应。

### Docker Compose

```bash
HOST_PORT=9090 docker compose up --build web     # 可配置宿主端口，默认 8080
```

验收服务（**名为 verify**）：围绕迟到消息与稳定压缩执行构建检查、代码测试与
API/HTTP 冒烟，**执行结束即退出，并以退出码报告结果**（0 通过 / 非 0 失败）：

```bash
docker compose up --build --exit-code-from verify verify
# 或
docker compose run --build verify ; echo "exit=$?"
```

Compose 中 `verify` 通过 `dep_on: service_healthy` 等待 `web` 健康后，
以 `BASE_URL=http://web:3000` 对其冒烟。

### 本地验收

```bash
./verify                  # 构建检查 + node --test + 自行拉起服务 HTTP 冒烟
BASE_URL=http://127.0.0.1:8080 ./verify   # 对已运行服务冒烟
```

## API

| 方法与路径 | 说明 |
|---|---|
| `GET  /healthz` | 健康响应 |
| `POST /api/drills` `{name}` | 建立演练 |
| `GET  /api/drills` | 演练列表 |
| `GET  /api/drills/:id` | 完整视图（可见条目/各副本视角/前沿/墓碑/抑制/拒绝/压缩） |
| `POST /api/drills/:id/events` | 投递 `{event}` 或 `{events:[...]}`；非法事件整体 422，不污染状态 |
| `POST /api/drills/:id/compact` | 三方稳定才压缩（成功 200，未稳定 409） |
| `POST /api/drills/:id/reopen` | 重开演练 |

事件示例：

```json
{"type":"add","replica":"A","id":"probe-7","seq":1,"target":"earth-relay-1"}
{"type":"delete","replica":"A","id":"probe-7","seq":2}
{"type":"sync-ack","replica":"B","id":"probe-7","seq":2}
{"type":"reopen","replica":"A"}
```

## 目录

```
src/core.mjs      状态机（纯函数式事件校验/应用/压缩/视图）
src/server.mjs    零依赖 HTTP 服务与 API
public/index.html 演练页面（录入、一键脚本、证据展示）
test/             状态机测试 12 项 + HTTP 端到端测试 3 项（node --test）
scripts/verify.mjs 验收服务（构建检查 + 代码测试 + HTTP 冒烟，退出码报告）
verify            可执行入口
```
