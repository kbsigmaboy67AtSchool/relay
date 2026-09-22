#!/usr/bin/env python3
"""Universal WSS Relay v2 — Python. pip install websockets && python server.py [port]"""
from __future__ import annotations
import asyncio, json, sys, uuid
from collections import defaultdict
from urllib.parse import urlparse, parse_qs

try:
    from websockets.asyncio.server import serve
except ImportError:
    from websockets.server import serve  # type: ignore

PORT = int(sys.argv[1] if len(sys.argv) > 1 else 8787)
MAX_CLIENTS, MAX_VARS, RATE_W, RATE_N, MAX_MSG = 128, 128, 10.0, 120, 1_048_576
rooms: dict[str, set] = defaultdict(set)
vars_map: dict[str, dict] = defaultdict(dict)
meta: dict = {}

def rate_ok(ws) -> bool:
    import time
    m = meta.setdefault(ws, {"t": time.time(), "n": 0, "user": "", "handshook": True, "mode": "bus", "echo": False, "presence": False, "id": ""})
    now = time.time()
    if now - m["t"] > RATE_W:
        m["t"], m["n"] = now, 0
    m["n"] += 1
    return m["n"] <= RATE_N

async def bcast(path, data, except_ws=None, echo=False):
    for ws in list(rooms.get(path, ())):
        if ws is except_ws and not echo:
            continue
        try:
            await ws.send(data)
        except Exception:
            pass

async def handle_cloud(ws, path, raw):
    m = meta[ws]
    try:
        msg = json.loads(raw)
    except Exception:
        await ws.close(code=4000); return
    method = msg.get("t") or msg.get("method")
    if method == "handshake":
        user = str(msg.get("user") or "")[:32]
        if not user:
            await ws.close(code=4002); return
        m["user"], m["handshook"] = user, True
        lines = [json.dumps({"t": "set", "method": "set", "name": k, "value": v}) for k, v in vars_map[path].items()]
        if lines:
            await ws.send("\n".join(lines))
        await ws.send(json.dumps({"t": "_hello", "id": m["id"], "n": len(rooms[path]), "mode": "cloud", "user": user}))
        return
    if not m["handshook"]:
        await ws.close(code=4000); return
    if method in ("set", "create"):
        name, value = msg.get("name"), msg.get("value")
        if not isinstance(name, str) or not (1 <= len(name) <= 128):
            return
        if not isinstance(value, (str, int, float)):
            return
        if name not in vars_map[path] and len(vars_map[path]) >= MAX_VARS:
            return
        vars_map[path][name] = value
        await bcast(path, json.dumps({"t": "set", "method": "set", "name": name, "value": value}), except_ws=ws)
    elif method == "delete" and msg.get("name") in vars_map[path]:
        del vars_map[path][msg["name"]]
        await bcast(path, json.dumps({"t": "delete", "method": "delete", "name": msg["name"]}), except_ws=ws)

async def handler(ws):
    path, query = "/", ""
    try:
        req = ws.request
        path = (req.path or "/").split("?")[0].rstrip("/") or "/"
        query = req.path.split("?", 1)[1] if "?" in (req.path or "") else ""
    except Exception:
        pass
    qs = parse_qs(query)
    presence = qs.get("presence", ["0"])[0] == "1"
    echo = qs.get("echo", ["0"])[0] == "1"
    mode = "cloud" if qs.get("mode", ["bus"])[0] == "cloud" else "bus"
    max_n = int(qs.get("max", [str(MAX_CLIENTS)])[0] or MAX_CLIENTS)
    if len(rooms[path]) >= max_n:
        await ws.send(json.dumps({"t": "_err", "error": "room_full"}))
        await ws.close(code=4003)
        return
    cid = str(uuid.uuid4())[:8]
    meta[ws] = {"t": __import__("time").time(), "n": 0, "user": "", "handshook": mode != "cloud", "mode": mode, "echo": echo, "presence": presence, "id": cid}
    rooms[path].add(ws)
    await ws.send(json.dumps({"t": "_hello", "id": cid, "n": len(rooms[path]), "path": path, "mode": mode}))
    if presence:
        await bcast(path, json.dumps({"t": "_join", "id": cid, "user": "", "n": len(rooms[path])}), except_ws=ws)
    print(f"[+] {path} mode={mode} id={cid} n={len(rooms[path])}")
    try:
        async for raw in ws:
            if not rate_ok(ws):
                await ws.send(json.dumps({"t": "_err", "error": "rate_limited"}))
                continue
            if isinstance(raw, bytes):
                if mode == "cloud":
                    continue
                await bcast(path, raw, except_ws=ws, echo=echo)
                continue
            if len(raw) > MAX_MSG:
                continue
            if mode == "cloud":
                for line in raw.split("\n"):
                    if line.strip():
                        await handle_cloud(ws, path, line.strip())
                continue
            if raw.startswith("{"):
                try:
                    msg = json.loads(raw)
                    if (msg.get("t") or msg.get("method")) == "handshake":
                        meta[ws]["user"] = str(msg.get("user") or "")[:32]
                        continue
                except Exception:
                    pass
            await bcast(path, raw, except_ws=ws, echo=echo)
    finally:
        rooms[path].discard(ws)
        m = meta.pop(ws, {})
        if presence:
            await bcast(path, json.dumps({"t": "_leave", "id": cid, "user": m.get("user", ""), "n": len(rooms[path])}))
        if not rooms[path]:
            rooms.pop(path, None)
            vars_map.pop(path, None)
        print(f"[-] {path} id={cid}")

async def main():
    print(f"Universal WSS Relay v2 (Python) ws://0.0.0.0:{PORT}/<room>")
    async with serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
