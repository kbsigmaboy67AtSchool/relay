/*
 * Copyright 2026 Xclounkit234X
 * Developer Contact: xclounkit234x@gmail.com | kbsigmaboy67@gmail.com
 * GitHub: kbsigmaboy67AtSchool, kbsigmaboy67, xclounkit234x
 * YouTube: xclounkit234x
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * n3xn Unified Relay — special branch + V0RT3X chat / public rooms
 */
// Cloudflare Worker: Universal Gateway, Multi-Store Engine, WebRTC + Chat Rooms
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/') ||
        request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketRelay(request, env, url);
    }

    if (url.pathname.startsWith('/api/kv/')) {
      return handleKvHttp(request, env);
    }

    if (url.pathname === '/api/public') {
      return handlePublicHttp(request, env);
    }

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'online',
        engine: 'n3xn Cloudflare Edge Relay',
        features: ['chat-rooms', 'public-directory', 'webrtc', 'kv', 'd1', 'r2', 'git-kv'],
        timestamp: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Timezone, Authorization'
        }
      });
    }

    return new Response('N3XN Unified Relay Active · chat+public ready', { status: 200 });
  }
};

/** @type {Map<string, object>} */
const activePeers = new Map();

/** In-isolate public directory (also mirrored to KV when available) */
const publicRoomsMem = new Map(); // url/key -> room meta
const PUBLIC_KV_KEY = 'n3xn:public-rooms:v1';
const PUBLIC_TTL_MS = 1000 * 60 * 60 * 6; // 6h

function safeRoomId(raw) {
  const s = String(raw || 'default').trim().slice(0, 96);
  return s.replace(/[^a-zA-Z0-9_\-.:]/g, '_') || 'default';
}

function peersInRoom(roomId) {
  const out = [];
  for (const peer of activePeers.values()) {
    if (peer.roomId === roomId) out.push(peer);
  }
  return out;
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function broadcastRoom(roomId, packet, exceptJoinHash) {
  for (const peer of peersInRoom(roomId)) {
    if (exceptJoinHash && peer.joinHash === exceptJoinHash) continue;
    sendJson(peer.ws, packet);
  }
}

async function loadPublicFromKv(env) {
  if (!env || !env.PRIMARY_KV) return;
  try {
    const data = await env.PRIMARY_KV.get(PUBLIC_KV_KEY, 'json');
    if (data && typeof data === 'object') {
      const now = Date.now();
      for (const [k, room] of Object.entries(data)) {
        if (room && room.ts && now - room.ts < PUBLIC_TTL_MS) {
          publicRoomsMem.set(k, room);
        }
      }
    }
  } catch (_) {}
}

async function savePublicToKv(env) {
  if (!env || !env.PRIMARY_KV) return;
  try {
    const obj = {};
    const now = Date.now();
    for (const [k, room] of publicRoomsMem.entries()) {
      if (room && room.ts && now - room.ts < PUBLIC_TTL_MS) obj[k] = room;
    }
    await env.PRIMARY_KV.put(PUBLIC_KV_KEY, JSON.stringify(obj), {
      expirationTtl: Math.ceil(PUBLIC_TTL_MS / 1000)
    });
  } catch (_) {}
}

function listPublicRooms() {
  const now = Date.now();
  const rooms = [];
  for (const [k, room] of [...publicRoomsMem.entries()]) {
    if (!room || !room.ts || now - room.ts > PUBLIC_TTL_MS) {
      publicRoomsMem.delete(k);
      continue;
    }
    rooms.push(room);
  }
  rooms.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rooms;
}

function broadcastPublicDirectory() {
  const rooms = listPublicRooms();
  const packet = { opcode: 'PUBLIC_LIST', payload: { rooms } };
  // Classic V0RT3X shape too
  const classic = { t: 'public-list', rooms };
  for (const peer of activePeers.values()) {
    if (peer.subscribedPublic) {
      sendJson(peer.ws, packet);
      sendJson(peer.ws, classic);
    }
  }
}

async function handleWebSocketRelay(request, env, url) {
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);
  serverWs.accept();

  // Warm public directory from KV once per isolate when possible
  if (publicRoomsMem.size === 0) {
    try { await loadPublicFromKv(env); } catch (_) {}
  }

  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const clientTimezone = request.headers.get('X-Timezone') || 'UTC';

  const deviceHash = await sha256Hex(`${clientIP}:device`);
  // IPv4 subnet /24 or fallback full string for IPv6-ish
  const parts = clientIP.split('.');
  const subnet = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : clientIP;
  const netHash = await sha256Hex(`${subnet}:net`);
  const joinHash = crypto.randomUUID().substring(0, 18);

  // Room from path /ws/<room> or ?room=
  let pathRoom = null;
  if (url.pathname.startsWith('/ws/')) {
    pathRoom = safeRoomId(decodeURIComponent(url.pathname.slice(4)));
  }
  const queryRoom = url.searchParams.get('room');
  if (queryRoom) pathRoom = safeRoomId(queryRoom);

  const session = {
    ws: serverWs,
    joinHash,
    deviceHash,
    netHash,
    timezone: clientTimezone,
    isDeviceCloudHost: false,
    deviceName: null,
    roomId: pathRoom || null,
    chatName: null,
    chatMeta: null,
    subscribedPublic: false,
    classic: false
  };

  activePeers.set(joinHash, session);

  // n3xn handshake
  sendJson(serverWs, {
    opcode: 'SYS_INIT',
    payload: { joinHash, deviceHash, netHash, timezone: clientTimezone, pathRoom }
  });

  // Classic V0RT3X hello (so older clients still light up)
  sendJson(serverWs, {
    t: 'hello',
    sid: joinHash,
    ipId: netHash,
    deviceHash,
    joinHash,
    netHash,
    timezone: clientTimezone
  });

  // If connected with path room, auto-enter lobby
  if (session.roomId) {
    // silent — client still sends CHAT_JOIN / join
  }

  serverWs.addEventListener('message', async (event) => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (!packet || typeof packet !== 'object') return;

    // ---- Classic V0RT3X packets { t: ... } ----
    if (packet.t && !packet.opcode) {
      return handleClassicPacket(session, packet, env);
    }

    const { id, opcode, payload = {} } = packet;
    if (!opcode) return;

    switch (opcode) {
      case 'SYS_INIT':
      case 'SYS_INIT_CLIENT': {
        if (payload.timezone) session.timezone = payload.timezone;
        sendJson(serverWs, {
          id,
          opcode: 'SYS_INIT',
          payload: {
            joinHash,
            deviceHash: session.deviceHash,
            netHash: session.netHash,
            timezone: session.timezone,
            pathRoom: session.roomId
          }
        });
        break;
      }

      // --- Device Cloud ---
      case 'REGISTER_DEVICE_CLOUD': {
        session.isDeviceCloudHost = true;
        session.deviceName = (payload && payload.deviceName) || 'Anonymous-Device-Cloud';
        sendJson(serverWs, {
          id,
          opcode: 'DEVICE_CLOUD_REGISTERED',
          payload: { joinHash, status: 'ready' }
        });
        break;
      }

      case 'LIST_DEVICE_CLOUDS': {
        const hosts = Array.from(activePeers.values())
          .filter(peer => peer.isDeviceCloudHost)
          .map(peer => ({
            joinHash: peer.joinHash,
            deviceHash: peer.deviceHash,
            deviceName: peer.deviceName,
            timezone: peer.timezone,
            isSameNet: peer.netHash === session.netHash
          }));
        sendJson(serverWs, { id, opcode: 'DEVICE_CLOUD_LIST', payload: hosts });
        break;
      }

      // --- KV / D1 / R2 / Git (guarded if bindings missing) ---
      case 'CF_KV_GET': {
        try {
          const kv = payload.target === 'cache' ? env.CACHE_KV : env.PRIMARY_KV;
          if (!kv) throw new Error('KV binding missing');
          const value = await kv.get(payload.key, payload.type || 'json');
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { key: payload.key, value } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      case 'CF_KV_SET': {
        try {
          const kv = payload.target === 'cache' ? env.CACHE_KV : env.PRIMARY_KV;
          if (!kv) throw new Error('KV binding missing');
          const valStr = typeof payload.value === 'object' ? JSON.stringify(payload.value) : String(payload.value);
          await kv.put(payload.key, valStr, { expirationTtl: payload.ttl || undefined });
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { success: true } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      case 'CF_D1_QUERY': {
        try {
          if (!env.DB) throw new Error('D1 binding missing');
          const stmt = env.DB.prepare(payload.query);
          const bound = payload.params ? stmt.bind(...payload.params) : stmt;
          const result = payload.isExec ? await bound.run() : await bound.all();
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { result } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      case 'CF_R2_PUT': {
        try {
          if (!env.BUCKET) throw new Error('R2 binding missing');
          await env.BUCKET.put(payload.key, payload.data, {
            customMetadata: { uploadedBy: joinHash }
          });
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { success: true, key: payload.key } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      case 'CF_R2_GET': {
        try {
          if (!env.BUCKET) throw new Error('R2 binding missing');
          const object = await env.BUCKET.get(payload.key);
          if (!object) {
            sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: 'Object not found' } });
            break;
          }
          const text = await object.text();
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { key: payload.key, data: text } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      case 'GIT_KV_SET': {
        try {
          if (!env.GITHUB_TOKEN || !env.GIT_OWNER || !env.GIT_REPO) {
            throw new Error('Git KV not configured');
          }
          const path = `kv/${String(payload.key).replace(/[^a-zA-Z0-9_\-\/]/g, '_')}.json`;
          const res = await fetch(
            `https://api.github.com/repos/${env.GIT_OWNER}/${env.GIT_REPO}/contents/${path}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                'User-Agent': 'n3xn-relay-worker',
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                message: `[N3XN GIT KV] Set key ${payload.key}`,
                content: btoa(JSON.stringify(payload.value))
              })
            }
          );
          sendJson(serverWs, { id, opcode: 'STORAGE_RESP', payload: { success: res.ok } });
        } catch (err) {
          sendJson(serverWs, { id, opcode: 'ERROR', payload: { error: err.message } });
        }
        break;
      }

      // --- WebRTC signaling ---
      case 'RTC_OFFER':
      case 'RTC_ANSWER':
      case 'RTC_ICE': {
        const targetPeer = activePeers.get(payload.targetJoinHash);
        if (targetPeer) {
          sendJson(targetPeer.ws, {
            opcode,
            payload: { ...payload, senderJoinHash: joinHash }
          });
        }
        break;
      }

      case 'WSS_RELAY_MSG': {
        const targetPeer = activePeers.get(payload.targetJoinHash);
        if (targetPeer) {
          sendJson(targetPeer.ws, {
            opcode: 'WSS_RELAY_MSG',
            payload: { senderJoinHash: joinHash, message: payload.message }
          });
        }
        break;
      }

      // ========== V0RT3X / chat rooms ==========
      case 'CHAT_JOIN': {
        const roomId = safeRoomId(payload.roomId || session.roomId || 'default');
        const prev = session.roomId;
        if (prev && prev !== roomId) {
          broadcastRoom(prev, {
            opcode: 'CHAT_PEER',
            payload: { type: 'leave', joinHash, u: session.chatName }
          }, joinHash);
        }
        session.roomId = roomId;
        session.chatName = (payload.u || 'anon').slice(0, 48);
        session.chatMeta = {
          deviceHash: payload.deviceHash || session.deviceHash,
          netHash: payload.netHash || session.netHash,
          timezone: payload.timezone || session.timezone
        };

        const roster = peersInRoom(roomId)
          .filter(p => p.joinHash !== joinHash)
          .map(p => ({
            joinHash: p.joinHash,
            u: p.chatName || '?',
            deviceHash: (p.chatMeta && p.chatMeta.deviceHash) || p.deviceHash,
            netHash: p.netHash,
            timezone: p.timezone
          }));

        sendJson(serverWs, {
          id,
          opcode: 'CHAT_PEER',
          payload: { type: 'roster', roomId, peers: roster }
        });

        broadcastRoom(roomId, {
          opcode: 'CHAT_PEER',
          payload: {
            type: 'join',
            roomId,
            joinHash,
            u: session.chatName,
            deviceHash: session.chatMeta.deviceHash,
            netHash: session.netHash,
            timezone: session.timezone
          }
        }, joinHash);

        // Classic mirror for mixed clients
        broadcastRoom(roomId, {
          t: 'join',
          id: joinHash,
          u: session.chatName,
          ipId: session.netHash,
          deviceHash: session.chatMeta.deviceHash,
          netHash: session.netHash
        }, joinHash);
        break;
      }

      case 'CHAT_MSG': {
        const roomId = safeRoomId(payload.roomId || session.roomId || 'default');
        if (!session.roomId) session.roomId = roomId;
        const message = payload.message || payload;
        // n3xn envelope
        broadcastRoom(roomId, {
          opcode: 'CHAT_MSG',
          payload: {
            roomId,
            senderJoinHash: joinHash,
            message
          }
        }, joinHash);
        // If message is classic-shaped, also emit raw classic for dual clients
        if (message && message.t) {
          const classic = { ...message };
          if (!classic.id) classic.id = joinHash;
          broadcastRoom(roomId, classic, joinHash);
        }
        break;
      }

      case 'CHAT_LEAVE': {
        leaveChatRoom(session);
        if (id) sendJson(serverWs, { id, opcode: 'CHAT_PEER', payload: { type: 'left' } });
        break;
      }

      // ========== Public directory ==========
      case 'PUBLIC_SUBSCRIBE':
      case 'PUBLIC_REFRESH': {
        session.subscribedPublic = true;
        const rooms = listPublicRooms();
        sendJson(serverWs, { id, opcode: 'PUBLIC_LIST', payload: { rooms } });
        sendJson(serverWs, { t: 'public-list', rooms });
        break;
      }

      case 'PUBLIC_ANNOUNCE': {
        session.subscribedPublic = true;
        const room = normalizePublicRoom(payload.room || payload, joinHash);
        if (!room) break;
        publicRoomsMem.set(room.key, room);
        await savePublicToKv(env);
        broadcastPublicDirectory();
        if (id) sendJson(serverWs, { id, opcode: 'PUBLIC_LIST', payload: { rooms: listPublicRooms() } });
        break;
      }

      case 'PUBLIC_UNPUBLISH': {
        const key = String((payload && (payload.key || payload.url)) || '');
        if (key) {
          const existing = publicRoomsMem.get(key);
          // Only publisher (or same join) can remove — soft check
          if (!existing || !existing.publisherJoinHash || existing.publisherJoinHash === joinHash) {
            publicRoomsMem.delete(key);
            await savePublicToKv(env);
            broadcastPublicDirectory();
          }
        }
        if (id) sendJson(serverWs, { id, opcode: 'PUBLIC_LIST', payload: { rooms: listPublicRooms() } });
        break;
      }

      case 'PUBLIC_LIST': {
        session.subscribedPublic = true;
        const rooms = listPublicRooms();
        sendJson(serverWs, { id, opcode: 'PUBLIC_LIST', payload: { rooms } });
        sendJson(serverWs, { t: 'public-list', rooms });
        break;
      }

      default:
        // ignore unknown opcodes
        break;
    }
  });

  serverWs.addEventListener('close', () => {
    leaveChatRoom(session);
    activePeers.delete(joinHash);
  });

  serverWs.addEventListener('error', () => {
    try { leaveChatRoom(session); } catch (_) {}
    activePeers.delete(joinHash);
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

function leaveChatRoom(session) {
  const roomId = session.roomId;
  if (!roomId) return;
  broadcastRoom(roomId, {
    opcode: 'CHAT_PEER',
    payload: { type: 'leave', joinHash: session.joinHash, u: session.chatName }
  }, session.joinHash);
  broadcastRoom(roomId, {
    t: 'leave',
    id: session.joinHash,
    u: session.chatName
  }, session.joinHash);
  session.roomId = null;
}

function normalizePublicRoom(raw, publisherJoinHash) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || raw.relay || '').trim();
  if (!url) return null;
  const key = url.slice(0, 256);
  return {
    key,
    url: key,
    title: String(raw.title || 'Chat').slice(0, 80),
    note: String(raw.note || '').slice(0, 200),
    encrypted: !!raw.encrypted,
    keyInNote: !!raw.keyInNote,
    ts: Date.now(),
    publisherJoinHash: publisherJoinHash || null,
    occupants: typeof raw.occupants === 'number' ? raw.occupants : undefined
  };
}

/** Classic V0RT3X JSON protocol bridge */
function handleClassicPacket(session, data, env) {
  session.classic = true;
  const roomId = session.roomId || safeRoomId(data.roomId || data.room || 'default');

  if (data.t === 'join') {
    session.roomId = roomId;
    session.chatName = (data.u || 'anon').slice(0, 48);
    session.chatMeta = {
      deviceHash: data.deviceHash || session.deviceHash,
      netHash: data.netHash || data.ipId || session.netHash
    };
    // Roster-ish: just announce
    broadcastRoom(roomId, {
      t: 'join',
      id: session.joinHash,
      u: session.chatName,
      ipId: session.netHash,
      deviceHash: session.chatMeta.deviceHash,
      netHash: session.netHash
    }, session.joinHash);
    broadcastRoom(roomId, {
      opcode: 'CHAT_PEER',
      payload: {
        type: 'join',
        roomId,
        joinHash: session.joinHash,
        u: session.chatName,
        deviceHash: session.chatMeta.deviceHash,
        netHash: session.netHash
      }
    }, session.joinHash);
    return;
  }

  // Public directory classic
  if (data.t === 'public-subscribe' || data.t === 'public-refresh' || data.t === 'public-list-req') {
    session.subscribedPublic = true;
    sendJson(session.ws, { t: 'public-list', rooms: listPublicRooms() });
    return;
  }
  if (data.t === 'public-announce' && data.room) {
    session.subscribedPublic = true;
    const room = normalizePublicRoom(data.room, session.joinHash);
    if (room) {
      publicRoomsMem.set(room.key, room);
      savePublicToKv(env);
      broadcastPublicDirectory();
    }
    return;
  }
  if (data.t === 'public-unpublish') {
    const key = String(data.url || data.key || '');
    if (key) {
      publicRoomsMem.delete(key);
      savePublicToKv(env);
      broadcastPublicDirectory();
    }
    return;
  }

  // Ensure room membership for any chat traffic
  if (!session.roomId) session.roomId = roomId;

  // Fan-out classic packet to room (msg, signal, voice-*, settings, creator, etc.)
  if (data.t === 'leave') {
    leaveChatRoom(session);
    return;
  }

  const out = { ...data };
  if (!out.id) out.id = session.joinHash;
  broadcastRoom(session.roomId, out, session.joinHash);

  // Also wrap as CHAT_MSG for n3xn-only clients
  broadcastRoom(session.roomId, {
    opcode: 'CHAT_MSG',
    payload: {
      roomId: session.roomId,
      senderJoinHash: session.joinHash,
      message: out
    }
  }, session.joinHash);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}

async function handleKvHttp(request, env) {
  const url = new URL(request.url);
  const key = url.pathname.replace('/api/kv/', '');
  if (!env.PRIMARY_KV) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), { status: 503 });
  }
  if (request.method === 'GET') {
    const val = await env.PRIMARY_KV.get(key);
    return new Response(val || 'null', {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
  return new Response('Method not allowed', { status: 405 });
}

async function handlePublicHttp(request, env) {
  try { await loadPublicFromKv(env); } catch (_) {}
  return new Response(JSON.stringify({ rooms: listPublicRooms() }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
