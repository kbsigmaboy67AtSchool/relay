(function (global) {
  class N3xnGameSDK {
    constructor(serverUrl = 'wss://relay.n3xn.dev/ws') {
      this.serverUrl = serverUrl;
      this.ws = null;
      this.identity = null;
      this.callbacks = new Map();
      this.pendingRPCs = new Map();
    }

    connect() {
      return new Promise((resolve, reject) => {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = () => {
          this.ws.send(JSON.stringify({
            opcode: 'SYS_INIT',
            payload: { timezone, userAgent: navigator.userAgent }
          }));
        };

        this.ws.onmessage = (event) => {
          const packet = JSON.parse(event.data);

          if (packet.opcode === 'SYS_INIT') {
            this.identity = packet.payload;
            resolve(this.identity);
            return;
          }

          if (packet.id && this.pendingRPCs.has(packet.id)) {
            const resolver = this.pendingRPCs.get(packet.id);
            this.pendingRPCs.delete(packet.id);
            resolver(packet.payload);
            return;
          }

          const handler = this.callbacks.get(packet.opcode);
          if (handler) handler(packet.payload);
        };

        this.ws.onerror = (err) => reject(err);
      });
    }

    joinRoom(roomId) {
      return this._rpc('GAME_JOIN_ROOM', { roomId });
    }

    sendGameState(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          opcode: 'GAME_STATE_SYNC',
          payload: data
        }));
      }
    }

    onStateUpdate(callback) {
      this.callbacks.set('GAME_STATE_UPDATE', callback);
    }

    onPeerJoin(callback) {
      this.callbacks.set('GAME_PEER_JOINED', callback);
    }

    onPeerLeave(callback) {
      this.callbacks.set('GAME_PEER_LEFT', callback);
    }

    _rpc(opcode, payload) {
      return new Promise((resolve) => {
        const id = crypto.randomUUID();
        this.pendingRPCs.set(id, resolve);
        this.ws.send(JSON.stringify({ id, opcode, payload }));
      });
    }
  }

  global.N3xnGameSDK = N3xnGameSDK;
})(typeof window !== 'undefined' ? window : globalThis);
