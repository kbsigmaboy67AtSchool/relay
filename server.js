#!/usr/bin/env node
/**
 * Universal WSS Relay v2 — Node
 * TurboWarp-inspired: rooms, ping timeout, rate limits, optional cloud KV.
 *   npm install ws && node server.js [port]
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const PORT = parseInt(process.argv[2] || process.env.PORT || "8787", 10);
const PING_MS = 30_000;
const MAX_MSG_BYTES = 1_048_576;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 120;
const DEFAULT_MAX_CLIENTS = 128;
const MAX_VARS = 128;
const rooms = new Map();

class Room {
  constructor(id, maxClients) {
    this.id = id;
    this.maxClients = maxClients || DEFAULT_MAX_CLIENTS;
    this.clients = new Set();
    this.vars = new Map();
  }
  get size() { return this.clients.size; }
}

function roomOf(path, maxClients) {
  let r = rooms.get(path);
  if (!r) { r = new Room(path, maxClients); rooms.set(path, r); }
  return r;
}
function send(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); } catch (_) {}
}
function broadcast(room, data, isBinary, except, echo) {
  for (const c of room.clients) {
    if (c === except && !echo) continue;
    if (c.readyState === 1) {
      try { c.send(data, { binary: !!isBinary }); } catch (_) {}
    }
  }
}
function rateOk(ws) {
  const now = Date.now();
  if (!ws._rate) ws._rate = { t: now, n: 0 };
  if (now - ws._rate.t > RATE_WINDOW_MS) ws._rate = { t: now, n: 0 };
  ws._rate.n++;
  return ws._rate.n <= RATE_MAX;
}
function validName(n) { return typeof n === "string" && n.length >= 1 && n.length <= 128; }
function validVal(v) { return typeof v === "string" || typeof v === "number"; }

function cloudSnapshot(room, ws) {
  const lines = [];
  for (const [name, value] of room.vars) lines.push(JSON.stringify({ t: "set", method: "set", name, value }));
  if (lines.length) send(ws, lines.join("\n"));
}

function handleCloud(ws, room, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { ws.close(4000, "invalid json"); return; }
  const method = msg.t || msg.method;
  if (!method) return;
  if (method === "handshake") {
    const user = String(msg.user || "").slice(0, 32);
    if (user.length < 1) { ws.close(4002, "username"); return; }
    ws._user = user; ws._handshook = true;
    cloudSnapshot(room, ws);
    send(ws, { t: "_hello", id: ws._id, n: room.size, path: room.id, mode: "cloud", user });
    return;
  }
  if (!ws._handshook) { ws.close(4000, "handshake required"); return; }
  if (method === "set" || method === "create") {
    if (!validName(msg.name) || !validVal(msg.value)) return;
    if (!room.vars.has(msg.name) && room.vars.size >= MAX_VARS) return;
    room.vars.set(msg.name, msg.value);
    broadcast(room, JSON.stringify({ t: "set", method: "set", name: msg.name, value: msg.value }), false, ws, false);
  } else if (method === "delete") {
    if (!validName(msg.name) || !room.vars.has(msg.name)) return;
    room.vars.delete(msg.name);
    broadcast(room, JSON.stringify({ t: "delete", method: "delete", name: msg.name }), false, ws, false);
  } else if (method === "rename") {
    if (!validName(msg.name) || !validName(msg.new_name) || !room.vars.has(msg.name) || room.vars.has(msg.new_name)) return;
    const val = room.vars.get(msg.name);
    room.vars.delete(msg.name); room.vars.set(msg.new_name, val);
    broadcast(room, JSON.stringify({ t: "rename", method: "rename", name: msg.name, new_name: msg.new_name }), false, ws, false);
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
  res.end("Universal WSS Relay v2 (Node)\n  bus: ws://host/room?presence=1\n  cloud: ws://host/p/1?mode=cloud\nSee PROTOCOL.md\n");
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://" + req.headers.host);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const presence = url.searchParams.get("presence") === "1";
  const echo = url.searchParams.get("echo") === "1";
  const mode = (url.searchParams.get("mode") || "bus").toLowerCase() === "cloud" ? "cloud" : "bus";
  const max = parseInt(url.searchParams.get("max") || String(DEFAULT_MAX_CLIENTS), 10) || DEFAULT_MAX_CLIENTS;

  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = roomOf(path, max);
    if (room.size >= room.maxClients) {
      send(ws, { t: "_err", error: "room_full", max: room.maxClients });
      ws.close(4003, "room full");
      return;
    }
    const id = crypto.randomUUID().slice(0, 8);
    ws._id = id; ws._path = path; ws._echo = echo; ws._presence = presence;
    ws._mode = mode; ws._user = ""; ws._handshook = mode !== "cloud"; ws._alive = true;
    room.clients.add(ws);
    send(ws, { t: "_hello", id, n: room.size, path, mode });
    if (presence) broadcast(room, JSON.stringify({ t: "_join", id, user: "", n: room.size }), false, ws, false);
    console.log("[+] " + path + " mode=" + mode + " id=" + id + " n=" + room.size);

    ws.on("pong", () => { ws._alive = true; });
    ws.on("message", (data, isBinary) => {
      if (!rateOk(ws)) { send(ws, { t: "_err", error: "rate_limited" }); return; }
      if (isBinary) {
        if (mode === "cloud") return;
        if (data.byteLength > MAX_MSG_BYTES) return;
        broadcast(room, data, true, ws, ws._echo);
        return;
      }
      const text = data.toString();
      if (text.length > MAX_MSG_BYTES) return;
      if (mode === "cloud") {
        for (const line of text.split("\n")) if (line.trim()) handleCloud(ws, room, line.trim());
        return;
      }
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text);
          if ((msg.t || msg.method) === "handshake") { ws._user = String(msg.user || "").slice(0, 32); return; }
        } catch (_) {}
      }
      broadcast(room, text, false, ws, ws._echo);
    });
    const leave = () => {
      if (!room.clients.has(ws)) return;
      room.clients.delete(ws);
      if (presence) broadcast(room, JSON.stringify({ t: "_leave", id, user: ws._user, n: room.size }), false, null, false);
      console.log("[-] " + path + " id=" + id + " n=" + room.size);
      if (room.size === 0) rooms.delete(path);
    };
    ws.on("close", leave);
    ws.on("error", leave);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.clients) {
      if (!ws._alive) { try { ws.terminate(); } catch (_) {} continue; }
      ws._alive = false;
      try { ws.ping(); } catch (_) {}
    }
  }
}, PING_MS);

server.listen(PORT, () => {
  console.log("Universal WSS Relay v2  ws://0.0.0.0:" + PORT + "/<room>");
  console.log("  bus:   ws://localhost:" + PORT + "/r/chat?presence=1");
  console.log("  cloud: ws://localhost:" + PORT + "/game/1?mode=cloud");
});
