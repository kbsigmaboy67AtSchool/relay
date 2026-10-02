// Cloudflare Worker: Universal Gateway, Multi-Store Engine, & WebRTC Relay
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Upgrade HTTP request to WebSocket for WSS communications & signaling
    if (url.pathname === '/ws' || request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketRelay(request, env);
    }

    // 2. Direct HTTP REST fallback endpoints for external clients
    if (url.pathname.startsWith('/api/kv/')) {
      return handleKvHttp(request, env);
    }

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'online',
        engine: 'n3xn Cloudflare Edge Relay',
        timestamp: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. Preflight CORS handler for universal cross-origin compatibility
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Timezone, Authorization'
        }
      });
    }

    return new Response('N3XN Unified Relay Active', { status: 200 });
  }
};

// In-Memory Active Session Registry per Edge Node
const activePeers = new Map();

async function handleWebSocketRelay(request, env) {
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);
  serverWs.accept();

  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const clientTimezone = request.headers.get('X-Timezone') || 'UTC';

  // Compute deterministic, non-reversible identity hashes
  const deviceHash = await sha256Hex(`${clientIP}:device`);
  const netHash = await sha256Hex(`${clientIP.split('.').slice(0, 3).join('.')}.0:net`);
  const joinHash = crypto.randomUUID().substring(0, 18);

  const session = {
    ws: serverWs,
    joinHash,
    deviceHash,
    netHash,
    timezone: clientTimezone,
    isDeviceCloudHost: false,
    deviceName: null
  };

  activePeers.set(joinHash, session);

  // Send handshake packet back to connected client
  serverWs.send(JSON.stringify({
    opcode: 'SYS_INIT',
    payload: { joinHash, deviceHash, netHash, timezone: clientTimezone }
  }));

  serverWs.addEventListener('message', async (event) => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }

    const { id, opcode, payload } = packet;

    switch (opcode) {
      // --- Device Cloud Node Registration ---
      case 'REGISTER_DEVICE_CLOUD': {
        session.isDeviceCloudHost = true;
        session.deviceName = payload.deviceName || 'Anonymous-Device-Cloud';
        serverWs.send(JSON.stringify({
          id,
          opcode: 'DEVICE_CLOUD_REGISTERED',
          payload: { joinHash, status: 'ready' }
        }));
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
            isSameNet: peer.netHash === netHash
          }));

        serverWs.send(JSON.stringify({ id, opcode: 'DEVICE_CLOUD_LIST', payload: hosts }));
        break;
      }

      // --- Cloudflare Workers KV Operations ---
      case 'CF_KV_GET': {
        const kv = payload.target === 'cache' ? env.CACHE_KV : env.PRIMARY_KV;
        const value = await kv.get(payload.key, payload.type || 'json');
        serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { key: payload.key, value } }));
        break;
      }

      case 'CF_KV_SET': {
        const kv = payload.target === 'cache' ? env.CACHE_KV : env.PRIMARY_KV;
        const valStr = typeof payload.value === 'object' ? JSON.stringify(payload.value) : String(payload.value);
        await kv.put(payload.key, valStr, { expirationTtl: payload.ttl || undefined });
        serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { success: true } }));
        break;
      }

      // --- Cloudflare D1 SQL Queries ---
      case 'CF_D1_QUERY': {
        try {
          const stmt = env.DB.prepare(payload.query);
          const bound = payload.params ? stmt.bind(...payload.params) : stmt;
          const result = payload.isExec ? await bound.run() : await bound.all();
          serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { result } }));
        } catch (err) {
          serverWs.send(JSON.stringify({ id, opcode: 'ERROR', payload: { error: err.message } }));
        }
        break;
      }

      // --- Cloudflare R2 Object Storage ---
      case 'CF_R2_PUT': {
        await env.BUCKET.put(payload.key, payload.data, { customMetadata: { uploadedBy: joinHash } });
        serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { success: true, key: payload.key } }));
        break;
      }

      case 'CF_R2_GET': {
        const object = await env.BUCKET.get(payload.key);
        if (!object) {
          serverWs.send(JSON.stringify({ id, opcode: 'ERROR', payload: { error: 'Object not found' } }));
          break;
        }
        const text = await object.text();
        serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { key: payload.key, data: text } }));
        break;
      }

      // --- Secure Git KV Proxy (GitHub Token is kept server-side) ---
      case 'GIT_KV_SET': {
        const path = `kv/${payload.key.replace(/[^a-zA-Z0-9_\-\/]/g, '_')}.json`;
        const res = await fetch(`https://api.github.com/repos/${env.GIT_OWNER}/${env.GIT_REPO}/contents/${path}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'User-Agent': 'n3xn-relay-worker',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `[N3XN GIT KV] Set key ${payload.key}`,
            content: btoa(JSON.stringify(payload.value))
          })
        });
        serverWs.send(JSON.stringify({ id, opcode: 'STORAGE_RESP', payload: { success: res.ok } }));
        break;
      }

      // --- WebRTC / P2P Signaling Relay ---
      case 'RTC_OFFER':
      case 'RTC_ANSWER':
      case 'RTC_ICE': {
        const targetPeer = activePeers.get(payload.targetJoinHash);
        if (targetPeer && targetPeer.ws.readyState === 1) {
          targetPeer.ws.send(JSON.stringify({ opcode, payload: { ...payload, senderJoinHash: joinHash } }));
        }
        break;
      }

      // --- Fallback WSS Message Relay ---
      case 'WSS_RELAY_MSG': {
        const targetPeer = activePeers.get(payload.targetJoinHash);
        if (targetPeer && targetPeer.ws.readyState === 1) {
          targetPeer.ws.send(JSON.stringify({
            opcode: 'WSS_RELAY_MSG',
            payload: { senderJoinHash: joinHash, message: payload.message }
          }));
        }
        break;
      }
    }
  });

  serverWs.addEventListener('close', () => activePeers.delete(joinHash));
  return new Response(null, { status: 101, webSocket: clientWs });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

async function handleKvHttp(request, env) {
  const url = new URL(request.url);
  const key = url.pathname.replace('/api/kv/', '');
  if (request.method === 'GET') {
    const val = await env.PRIMARY_KV.get(key);
    return new Response(val || 'null', { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('Method not allowed', { status: 405 });
}
