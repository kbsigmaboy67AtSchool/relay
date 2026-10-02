export class N3xnDeviceKVHost {
  constructor(transport, deviceName = 'My-Browser-Cloud') {
    this.transport = transport;
    this.deviceName = deviceName;
    this.db = null;
  }

  async init() {
    // Open IndexedDB instance on the hosting device
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('n3xn_device_kv', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv_store');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Register this device with the Cloudflare Worker relay
    await this.transport.rpc('REGISTER_DEVICE_CLOUD', { deviceName: this.deviceName });

    // Listen for incoming P2P requests from remote clients
    this.transport.on('P2P_MESSAGE', async (evt) => {
      const { sender, data } = evt;
      if (!data || !data.rpcId) return;

      const result = await this.handleRPC(data.action, data.key, data.value);
      this.transport.sendP2P(sender, { rpcId: data.rpcId, result });
    });
  }

  async handleRPC(action, key, value) {
    const tx = this.db.transaction('kv_store', action === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('kv_store');

    return new Promise((resolve) => {
      if (action === 'get') {
        const req = store.get(key);
        req.onsuccess = () => resolve({ key, value: req.result ?? null });
      } else if (action === 'set') {
        const req = store.put(value, key);
        req.onsuccess = () => resolve({ key, success: true });
      } else if (action === 'del') {
        const req = store.delete(key);
        req.onsuccess = () => resolve({ key, success: true });
      }
    });
  }
}

// Client Driver to query a remote Device Cloud Host over WebRTC
export class N3xnDeviceKVClient {
  constructor(transport, hostJoinHash) {
    this.transport = transport;
    this.hostJoinHash = hostJoinHash;
    this.pendingRPCs = new Map();

    this.transport.on('P2P_MESSAGE', (evt) => {
      const { data } = evt;
      if (data && data.rpcId && this.pendingRPCs.has(data.rpcId)) {
        const resolver = this.pendingRPCs.get(data.rpcId);
        this.pendingRPCs.delete(data.rpcId);
        resolver(data.result);
      }
    });
  }

  async exec(action, key, value = null) {
    const rpcId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pendingRPCs.set(rpcId, resolve);
      this.transport.sendP2P(this.hostJoinHash, { rpcId, action, key, value });
    });
  }

  get(key) { return this.exec('get', key); }
  set(key, value) { return this.exec('set', key, value); }
  delete(key) { return this.exec('del', key); }
}
