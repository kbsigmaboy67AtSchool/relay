// Cloudflare Worker: WSS Signaling Relay + Device Cloud Gateway
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle WebSocket Upgrade for Relay & Signaling
    if (url.pathname === '/ws' || request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketRelay(request, env);
    }

    // 2. HTTP Endpoint: Health Check & Relay Information
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'online',
        engine: 'n3xn Cloudflare Worker Relay',
        timestamp: Date.now()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. Fallback / CORS Preflight Handler
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Timezone, Authorization'
        }
      });
    }

    return new Response('N3XN Worker Relay Active', { status: 200 });
  }
};

// In-Memory Device & Session Registry (per edge location worker instance)
const activePeers = new Map();

async function handleWebSocketRelay(request, env) {
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);

  serverWs.accept();

  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const clientTimezone = request.headers.get('X-Timezone') || 'UTC';
  
  // Compute deterministic hashes
  const deviceHash = await sha256Hex(`${clientIP}:device`);
  const netHash = await sha256Hex(`${clientIP.split('.').slice(0, 3).join('.')}.0:net`);
  const joinHash = crypto.randomUUID().substring(0, 18);

  const session = {
    ws: serverWs,
    joinHash,
    deviceHash,
    netHash,
    timezone: clientTimezone,
    isDeviceCloudHost: false
  };

  activePeers.set(joinHash, session);

  // Send initialization handshake
  serverWs.send(JSON.stringify({
    opcode: 'SYS_INIT',
    payload: { joinHash, deviceHash, netHash, timezone: clientTimezone }
  }));

  serverWs.addEventListener('message', async (event) => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }

    const { id, opcode, payload } = packet;

    switch (opcode) {
      // Register device as an active "Device-as-Cloud" host node
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

      // WebRTC Signaling Relay (Offers, Answers, ICE Candidates)
      case 'RTC_OFFER':
      case 'RTC_ANSWER':
      case 'RTC_ICE': {
        const targetPeer = activePeers.get(payload.targetJoinHash);
        if (targetPeer && targetPeer.ws.readyState === 1) {
          targetPeer.ws.send(JSON.stringify({
            opcode,
            payload: { ...payload, senderJoinHash: joinHash }
          }));
        }
        break;
      }

      // List available Device Cloud nodes and active peers
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

      // Fallback WSS Message Relay if P2P fails
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

  serverWs.addEventListener('close', () => {
    activePeers.delete(joinHash);
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}
