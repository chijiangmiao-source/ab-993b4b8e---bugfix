/**
 * 离线探测清单三副本演练 · HTTP 服务（零依赖 Node http）
 *
 * 环境变量：
 *   PORT  监听端口（默认 3000）
 *   HOST  监听地址（默认 0.0.0.0）
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

import { applyEvent, compact, createDrill, view } from './core.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** id -> state */
const drills = new Map();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const limit = 1_000_000;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/healthz') {
      json(res, 200, {
        status: 'ok',
        service: 'offline-checklist-drill',
        drills: drills.size,
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'GET' && p === '/') {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ---- API ----
    const apiDrills = p === '/api/drills';
    const sub = p.match(/^\/api\/drills\/([A-Za-z0-9_-]+)(\/(events|compact|reopen))?$/);

    if (req.method === 'POST' && apiDrills) {
      const body = await readJson(req);
      const name = String(body.name || '未命名演练').slice(0, 120);
      const id = crypto.randomUUID();
      drills.set(id, createDrill(name));
      json(res, 201, { ok: true, id, view: view(drills.get(id)) });
      return;
    }

    if (req.method === 'GET' && apiDrills) {
      json(res, 200, {
        ok: true,
        drills: [...drills].map(([id, s]) => ({ id, name: s.name, eventCount: s.log.length, createdAt: s.createdAt })),
      });
      return;
    }

    if (sub) {
      const [, id, , action] = sub;
      const state = drills.get(id);
      if (!state) {
        json(res, 404, { ok: false, code: 'DRILL_NOT_FOUND', error: `演练 ${id} 不存在` });
        return;
      }

      if (req.method === 'GET' && !action) {
        json(res, 200, { ok: true, id, view: view(state) });
        return;
      }

      if (req.method === 'POST' && action === 'events') {
        const body = await readJson(req);
        const events = Array.isArray(body.events) ? body.events : [body.event];
        if (events.some((e) => e === undefined || e === null)) {
          json(res, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 event 或 events[]' });
          return;
        }
        const results = events.map((ev) => applyEvent(state, ev));
        const ok = results.every((r) => r.ok);
        json(res, ok ? 200 : 422, {
          ok,
          results: results.map((r) =>
            r.ok
              ? { ok: true, effect: r.effect, eventId: r.ev?.eventId }
              : { ok: false, code: r.code, error: r.error },
          ),
          view: view(state),
        });
        return;
      }

      if (req.method === 'POST' && action === 'compact') {
        const body = await readJson(req).catch(() => ({}));
        const r = compact(state, { by: body.by });
        json(res, r.ok ? 200 : 409, { ok: r.ok, code: r.code, error: r.error, compacted: r.compacted, record: r.record, frontier: r.frontier, view: view(state) });
        return;
      }

      if (req.method === 'POST' && action === 'reopen') {
        const body = await readJson(req).catch(() => ({}));
        const r = applyEvent(state, { type: 'reopen', replica: body.replica ?? 'A', at: body.at });
        json(res, r.ok ? 200 : 422, { ok: r.ok, code: r.code, error: r.error, effect: r.effect, view: view(state) });
        return;
      }
    }

    json(res, 404, { ok: false, code: 'NOT_FOUND', error: `${p} 不存在` });
  } catch (err) {
    json(res, err.status || 500, {
      ok: false,
      code: err.status ? 'BAD_REQUEST' : 'INTERNAL',
      error: err.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[offline-checklist-drill] listening on http://${HOST}:${PORT}`);
});

export { server };
