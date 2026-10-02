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
 */
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
