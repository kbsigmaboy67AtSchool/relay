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
export class N3xnTransport {
  constructor(relayUrl = 'wss://relay.n3xn.dev/ws') {
    this.relayUrl = relayUrl;
    this.ws = null;
    this.identity = null;
    this.peerConnections = new Map();
    this.dataChannels = new Map();
    this.pendingRPCs = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.relayUrl);

      this.ws.onopen = () => {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        this.send('SYS_INIT_CLIENT', { timezone });
      };

      this.ws.onmessage = async (event) => {
        const packet = JSON.parse(event.data);

        if (packet.opcode === 'SYS_INIT') {
          this.identity = packet.payload;
          this.setupSignaling();
          resolve(this.identity);
          return;
        }

        if (packet.id && this.pendingRPCs.has(packet.id)) {
          const resolver = this.pendingRPCs.get(packet.id);
          this.pendingRPCs.delete(packet.id);
          resolver(packet.payload);
          return;
        }

        const handler = this.eventListeners.get(packet.opcode);
        if (handler) handler(packet.payload);
      };

      this.ws.onerror = (err) => reject(err);
    });
  }

  setupSignaling() {
    this.on('RTC_OFFER', async (data) => {
      const pc = this._createPeerConnection(data.senderJoinHash);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.send('RTC_ANSWER', { targetJoinHash: data.senderJoinHash, answer });
    });

    this.on('RTC_ANSWER', async (data) => {
      const pc = this.peerConnections.get(data.senderJoinHash);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    this.on('RTC_ICE', async (data) => {
      const pc = this.peerConnections.get(data.senderJoinHash);
      if (pc && data.candidate) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    });
  }

  async connectToPeer(targetJoinHash) {
    const pc = this._createPeerConnection(targetJoinHash);
    const dc = pc.createDataChannel('n3xn-kv-channel');
    this._bindDataChannel(targetJoinHash, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.send('RTC_OFFER', { targetJoinHash, offer });
  }

  _createPeerConnection(targetJoinHash) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send('RTC_ICE', { targetJoinHash, candidate: e.candidate });
      }
    };

    pc.ondatachannel = (e) => {
      this._bindDataChannel(targetJoinHash, e.channel);
    };

    this.peerConnections.set(targetJoinHash, pc);
    return pc;
  }

  _bindDataChannel(joinHash, channel) {
    this.dataChannels.set(joinHash, channel);
    channel.onmessage = (event) => {
      const handler = this.eventListeners.get('P2P_MESSAGE');
      if (handler) handler({ sender: joinHash, data: JSON.parse(event.data) });
    };
  }

  sendP2P(targetJoinHash, payload) {
    const dc = this.dataChannels.get(targetJoinHash);
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(payload));
      return 'webrtc-p2p';
    }

    this.send('WSS_RELAY_MSG', { targetJoinHash, message: payload });
    return 'wss-relay';
  }

  send(opcode, payload, id = crypto.randomUUID()) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ id, opcode, payload }));
    }
  }

  on(opcode, callback) {
    this.eventListeners.set(opcode, callback);
  }

  rpc(opcode, payload) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.pendingRPCs.set(id, resolve);
      this.send(opcode, payload, id);
    });
  }
}
