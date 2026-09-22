/**
 * Universal WSS Relay — Bun
 *   bun run index.ts
 */
const port = Number(process.env.PORT || 8787);
const rooms = new Map<string, Set<any>>();

function roomOf(path: string) {
  if (!rooms.has(path)) rooms.set(path, new Set());
  return rooms.get(path)!;
}

function broadcast(path: string, data: any, except?: any, echo = false) {
  const room = rooms.get(path);
  if (!room) return;
  for (const c of room) {
    if (c === except && !echo) continue;
    try { c.send(data); } catch {}
  }
}

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const presence = url.searchParams.get("presence") === "1";
    const echo = url.searchParams.get("echo") === "1";
    const max = parseInt(url.searchParams.get("max") || "0", 10) || 0;
    const room = roomOf(path);
    if (max > 0 && room.size >= max) return new Response("room full", { status: 503 });

    if (server.upgrade(req, { data: { path, presence, echo, id: crypto.randomUUID().slice(0, 8) } })) {
      return undefined as any;
    }
    return new Response("Universal WSS Relay (Bun) — path = room\n");
  },
  websocket: {
    open(ws) {
      const { path, presence, id } = ws.data as any;
      const room = roomOf(path);
      room.add(ws);
      ws.send(JSON.stringify({ t: "_hello", id, n: room.size, path }));
      if (presence) {
        broadcast(path, JSON.stringify({ t: "_join", id, n: room.size }), ws, false);
      }
    },
    message(ws, message) {
      const { path, echo } = ws.data as any;
      broadcast(path, message, ws, echo);
    },
    close(ws) {
      const { path, presence, id } = ws.data as any;
      const room = rooms.get(path);
      room?.delete(ws);
      if (presence && room) {
        broadcast(path, JSON.stringify({ t: "_leave", id, n: room.size }), undefined, false);
      }
      if (room && room.size === 0) rooms.delete(path);
    },
  },
});

console.log(`Universal WSS Relay (Bun) ws://0.0.0.0:${port}/<room>`);
