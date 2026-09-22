/** Universal WSS Relay v2 — Deno (bus + cloud). deno run -A main.ts */
const MAX = 128, MAX_VARS = 128, RATE_W = 10000, RATE_N = 120, MAX_MSG = 1048576;
type C = { ws: WebSocket; id: string; echo: boolean; presence: boolean; mode: string; user: string; handshook: boolean; rateT: number; rateN: number };
type R = { id: string; max: number; clients: Set<C>; vars: Map<string, string|number> };
const rooms = new Map<string, R>();
function roomOf(path: string, max: number) {
  let r = rooms.get(path);
  if (!r) { r = { id: path, max, clients: new Set(), vars: new Map() }; rooms.set(path, r); }
  return r;
}
function send(c: C, o: unknown) { if (c.ws.readyState === 1) try { c.ws.send(typeof o === "string" ? o : JSON.stringify(o)); } catch {} }
function bcast(r: R, data: string|ArrayBuffer, except: C|null, echo: boolean) {
  for (const c of r.clients) { if (c === except && !echo) continue; if (c.ws.readyState === 1) try { c.ws.send(data); } catch {} }
}
function rateOk(c: C) {
  const n = Date.now(); if (n - c.rateT > RATE_W) { c.rateT = n; c.rateN = 0; } c.rateN++; return c.rateN <= RATE_N;
}
function cloudSnap(r: R, c: C) {
  const lines: string[] = []; for (const [name, value] of r.vars) lines.push(JSON.stringify({ t: "set", method: "set", name, value }));
  if (lines.length) send(c, lines.join("\n"));
}
function handleCloud(c: C, r: R, raw: string) {
  let msg: any; try { msg = JSON.parse(raw); } catch { c.ws.close(4000); return; }
  const m = msg.t || msg.method;
  if (m === "handshake") {
    c.user = String(msg.user || "").slice(0, 32); if (!c.user) { c.ws.close(4002); return; }
    c.handshook = true; cloudSnap(r, c); send(c, { t: "_hello", id: c.id, n: r.clients.size, mode: "cloud", user: c.user }); return;
  }
  if (!c.handshook) { c.ws.close(4000); return; }
  if (m === "set" || m === "create") {
    if (!msg.name || (typeof msg.value !== "string" && typeof msg.value !== "number")) return;
    if (!r.vars.has(msg.name) && r.vars.size >= MAX_VARS) return;
    r.vars.set(msg.name, msg.value); bcast(r, JSON.stringify({ t: "set", method: "set", name: msg.name, value: msg.value }), c, false);
  } else if (m === "delete" && r.vars.has(msg.name)) {
    r.vars.delete(msg.name); bcast(r, JSON.stringify({ t: "delete", method: "delete", name: msg.name }), c, false);
  } else if (m === "rename" && r.vars.has(msg.name) && !r.vars.has(msg.new_name)) {
    const v = r.vars.get(msg.name)!; r.vars.delete(msg.name); r.vars.set(msg.new_name, v);
    bcast(r, JSON.stringify({ t: "rename", method: "rename", name: msg.name, new_name: msg.new_name }), c, false);
  }
}
Deno.serve({ port: Number(Deno.env.get("PORT") || 8787) }, (req) => {
  const url = new URL(req.url);
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("Universal WSS Relay v2 (Deno)\n", { headers: { "content-type": "text/plain" } });
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const presence = url.searchParams.get("presence") === "1";
  const echo = url.searchParams.get("echo") === "1";
  const mode = url.searchParams.get("mode") === "cloud" ? "cloud" : "bus";
  const max = parseInt(url.searchParams.get("max") || String(MAX), 10) || MAX;
  const room = roomOf(path, max);
  if (room.clients.size >= room.max) return new Response("room full", { status: 503 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const c: C = { ws: socket, id: crypto.randomUUID().slice(0, 8), echo, presence, mode, user: "", handshook: mode !== "cloud", rateT: Date.now(), rateN: 0 };
  socket.onopen = () => {
    room.clients.add(c);
    send(c, { t: "_hello", id: c.id, n: room.clients.size, path, mode });
    if (presence) bcast(room, JSON.stringify({ t: "_join", id: c.id, user: "", n: room.clients.size }), c, false);
  };
  socket.onmessage = (ev) => {
    if (!rateOk(c)) { send(c, { t: "_err", error: "rate_limited" }); return; }
    if (typeof ev.data !== "string") { if (mode !== "cloud") bcast(room, ev.data, c, echo); return; }
    if (ev.data.length > MAX_MSG) return;
    if (mode === "cloud") { for (const line of ev.data.split("\n")) if (line.trim()) handleCloud(c, room, line.trim()); return; }
    if (ev.data.startsWith("{")) { try { const msg = JSON.parse(ev.data); if ((msg.t||msg.method)==="handshake") { c.user = String(msg.user||"").slice(0,32); return; } } catch {} }
    bcast(room, ev.data, c, echo);
  };
  socket.onclose = () => {
    room.clients.delete(c);
    if (presence) bcast(room, JSON.stringify({ t: "_leave", id: c.id, user: c.user, n: room.clients.size }), null, false);
    if (room.clients.size === 0) rooms.delete(path);
  };
  return response;
});
console.log("Universal WSS Relay v2 (Deno) ready");
