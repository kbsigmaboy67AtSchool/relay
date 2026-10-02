# n3xn Servers & Unified Transport Relay 🚀

> **Made by Xclounkit234X** :)
> **Repository:** `kbsigmaboy67AtSchool/relay` | **Current Active Branch:** `special`
> *(Note: Make sure you switch to the `special` branch for this latest version! Other branches like `deno`, `cf`, etc., hold older builds or alternative environment setups xD)*

An EaglercraftX-inspired, origin-agnostic networking transport, multi-store key-value engine, and WebRTC P2P mesh designed for web games, local-first apps, and browser-bound execution environments like **n3xn VFS**.

---

## Key Capabilities

* **Origin-Agnostic WSS Gateway**: Connect seamlessly from any origin (`https://`, `http://`, `file://`, sandboxed `iframe`, or embedded webviews) without CORS issues.
* **Identity & Privacy Hashing**: Automatically derives SHA-256 device hashes (`deviceHash`) and network subnet hashes (`netHash`). It also exposes client timezones (`timezone`) so latency calculations and game time sync are super easy :)
* **Device-as-Cloud KV Engine**: Turns connected client browsers into active distributed storage nodes backed by IndexedDB and connected via WebRTC DataChannels (with automatic WSS fallback).
* **Zero-Exposure Token Security**: GitHub Access Tokens, Cloudflare API credentials, and database keys stay strictly on the worker side. The client never touches raw secrets!
* **Multi-Store Infrastructure**: Native bindings for Cloudflare Workers KV (multi-namespace), D1 Serverless SQL, R2 Object Storage, and GitHub Repositories (Git KV).
* **Smart P2P Mesh Routing**: Automatically routes data through WebRTC DataChannels, tab `BroadcastChannel` instances, or WSS relay connections depending on what's available and fastest.

---

## Architecture & Security

```
                                  +---------------------------------------+
                                  |     Cross-Origin Client Instances     |
                                  | (file://, https://, webview, iframe)  |
                                  +-------------------|-------------------+
                                                      |
                                            WSS Duplex / JSON RPC
                                                      |
                                  +-------------------v-------------------+
                                  |     n3xn Cloudflare Edge Worker       |
                                  |  - Strips credentials from frontend   |
                                  |  - Hashes IP & Subnet -> Hashes       |
                                  |  - Relays WebRTC signaling offers     |
                                  +---------+---------+---------+---------+
                                            |         |         |
                    +-----------------------+         |         +-----------------------+
                    |                                 |                                 |
          +---------v---------+             +---------v---------+             +---------v---------+
          | Cloudflare Stores |             |   Git KV Proxy    |             |Device-as-Cloud Host|
          | (KV / D1 SQL / R2)|             | (GitHub API/Token)|             |(WebRTC + IndexedDB)|
          +-------------------+             +-------------------+             +-------------------+

```

### Identity & Privacy Model

We protect raw IP addresses while still enabling matchmaking, LAN detection, and device identification:

| Identifier | Generation Logic | Purpose |
| --- | --- | --- |
| `deviceHash` | `SHA256(Client_IP + ":device")` | Fingerprints hardware/device without leaking raw IPs. |
| `netHash` | `SHA256(Client_Subnet + ":net")` | Detects peers on the same local network (LAN) for fast P2P routing. |
| `joinHash` | `UUIDv4` (Truncated) | Ephemeral session ID used for WebRTC signaling and peer targeting. |
| `timezone` | `Intl.DateTimeFormat` | Client timezone string (e.g., `America/New_York`) for game time matching & sync. |

### Token Security Guarantee

Secrets like `GITHUB_TOKEN` and database credentials are stored solely in your Cloudflare environment variables or Wrangler secrets. The browser sends actions/queries over WSS, and the edge worker validates and executes them on the backend :)

---

## Quick Start (Client Integration)

### 1. Basic Game / App Connection (`n3xn-sdk.js`)

Drop `n3xn-sdk.js` into your project (works great with local `file://` games too xD):

```html
<script src="src/n3xn-sdk.js"></script>
<script>
  // Point this to your deployed worker URL!
  const sdk = new N3xnGameSDK('wss://<your-worker-subdomain>.workers.dev/ws');

  async function start() {
    // 1. Connect and grab client identity
    const identity = await sdk.connect();
    console.log(`Connected! Device Hash: ${identity.deviceHash}, TZ: ${identity.timezone}`);

    // 2. Join a multiplayer room
    const room = await sdk.joinRoom('global-arena');
    console.log('Room members:', room.occupants);

    // 3. Listen for state updates from peers
    sdk.onStateUpdate((evt) => {
      console.log(`Player ${evt.sender} moved:`, evt.data);
    });

    // 4. Send game state
    sdk.sendGameState({ x: 120, y: 340, state: 'running' });
  }

  start();
</script>

```

### 2. Multi-Store Data Operations (`n3xn-store.js`)

Talk to KV, D1 SQL, R2, or Git KV straight over WebSocket:

```javascript
import { N3xnTransport } from './src/n3xn-transport.js';
import { N3xnStoreClient } from './src/n3xn-store.js';

const transport = new N3xnTransport('wss://<your-worker-subdomain>.workers.dev/ws');
await transport.connect();

const store = new N3xnStoreClient(transport);

// Write to Cloudflare KV
await store.kvSet('high_score', { score: 9950, player: 'Ace' });

// Query Cloudflare D1 Serverless SQL
const leaderboard = await store.sqlQuery('SELECT * FROM leaderboards ORDER BY score DESC LIMIT 10');

// Save a savefile blob to Cloudflare R2
await store.r2Put('savegames/slot1.json', JSON.stringify({ level: 5, inventory: ['sword', 'shield'] }));

```

### 3. Hosting a "Device Cloud" Node (`device-kv.js`)

Turn any browser tab into a living database server for other peers:

```javascript
import { N3xnTransport } from './src/n3xn-transport.js';
import { N3xnDeviceKVHost, N3xnDeviceKVClient } from './src/device-kv.js';

const transport = new N3xnTransport('wss://<your-worker-subdomain>.workers.dev/ws');
await transport.connect();

// HOST SIDE: Register this browser tab as a storage node
const hostNode = new N3xnDeviceKVHost(transport, 'Browser-Node-Alpha');
await hostNode.init(); // Opens IndexedDB and starts listening

// CLIENT SIDE: Connect to the remote node over WebRTC
const targetJoinHash = 'target-peer-join-hash';
const deviceDb = new N3xnDeviceKVClient(transport, targetJoinHash);

// Read/Write directly over WebRTC DataChannel!
await deviceDb.set('player_data', { hp: 100 });
const data = await deviceDb.get('player_data');

```

---

## Forking & Setup Guide

Want to run your own instance? Make sure you check out the `special` branch!

### 1. Clone & Switch to `special` Branch

```bash
git clone https://github.com/kbsigmaboy67AtSchool/relay.git
cd relay
git checkout special
npm install

```

*(Note: Other branches like `deno` or `cf` are older or alternative variants—`special` is where the current version lives!)*

### 2. Provision Cloudflare Resources

Create your KV namespaces, D1 SQL database, and R2 bucket via Wrangler CLI:

```bash
# Create KV Namespaces
wrangler kv namespace create PRIMARY_KV
wrangler kv namespace create CACHE_KV

# Create D1 SQL Database
wrangler d1 create n3xn-db

# Create R2 Storage Bucket
wrangler r2 bucket create n3xn-storage-bucket

```

Update your `wrangler.toml` with the generated IDs:

```toml
name = "n3xn-relay-worker"
main = "src/worker.js"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "PRIMARY_KV"
id = "<YOUR_PRIMARY_KV_NAMESPACE_ID>"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "<YOUR_CACHE_KV_NAMESPACE_ID>"

[[d1_databases]]
binding = "DB"
database_name = "n3xn-db"
database_id = "<YOUR_D1_DATABASE_ID>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "n3xn-storage-bucket"

[vars]
GIT_OWNER = "kbsigmaboy67AtSchool"
GIT_REPO = "relay"

```

### 3. Set GitHub Token Secret (Git KV)

If you're using Git KV proxying, set your secret so the worker can write commits on your behalf:

```bash
wrangler secret put GITHUB_TOKEN

```

### 4. Deploy to Cloudflare Edge

```bash
wrangler deploy

```

Your WSS Gateway will be live at `wss://<your-worker-subdomain>.workers.dev/ws` :)

### 5. Deploying on Cloudflare Pages (`public/_routes.json`)

If you host static frontend files on Cloudflare Pages, `public/_routes.json` will route `/ws` and `/api/*` traffic automatically to your edge worker:

```json
{
  "version": 1,
  "include": ["/ws", "/api/*"],
  "exclude": ["/static/*", "/*.html", "/*.css", "/*.js"]
}

```

---

## Recommended Games & Use Cases

Here are a few awesome things you can build or pair with this relay:

| Category | Description | Suggested Modules |
| --- | --- | --- |
| **WebMC / Minecraft Web Clients** | EaglercraftX-style client-server signaling, server lists, and cross-origin player syncing. | `N3xnGameSDK` + WSS Relay |
| **Retro Emulators & ROM Stores** | Sync emulator save states across devices with Device-as-Cloud or Cloudflare R2 storage xD | `N3xnDeviceKVHost` + R2 Storage |
| **HTML5 / WebGL Multiplayer** | Position syncing, lobby matchmaking, and P2P room data for Phaser, Three.js, or Godot Web builds. | `N3xnTransport` + WebRTC P2P |
| **P2P File & Asset Sharing** | Direct high-speed asset transfer between browser tabs without hitting server bandwidth caps. | WebRTC DataChannels (`sendP2P`) |
| **Virtual Filesystems (VFS)** | Encrypted cloud sync, remote file execution, and collaborative workspace tools. | `N3xnStoreClient` + Git KV |

---

## Project Structure

```
.
├── wrangler.toml         # Cloudflare Worker config & store bindings
├── public/
│   └── _routes.json      # Cloudflare Pages routing configuration
└── src/
    ├── worker.js         # Edge gateway, WebSocket router & storage API
    ├── n3xn-transport.js # Universal client transport (WSS + WebRTC)
    ├── n3xn-store.js     # Multi-store client wrapper (KV, D1, R2, Git)
    ├── device-kv.js      # Device-as-Cloud IndexedDB server & client
    └── n3xn-sdk.js       # Game SDK for state sync & room lobbies

```

---

*Made with ❤ by Xclounkit234X. Happy coding! :)*
