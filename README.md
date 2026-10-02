# n3xn Servers & Unified Transport Relay

An EaglercraftX-inspired, origin-agnostic networking transport, multi-store key-value engine, and WebRTC P2P mesh designed for web games, local-first apps, and browser-bound execution environments like **n3xn VFS**.

---

## Key Capabilities

* **Origin-Agnostic WSS Gateway**: Native support for cross-origin client connections (`https://`, `http://`, `file://`, `iframe` sandboxes, and webviews).
* **Identity & Privacy Hashing**: Generates non-reversible SHA-256 device hashes (`deviceHash`) and network subnet hashes (`netHash`). Client timezones are explicitly exposed (`timezone`) for latency calculation and game time synchronization.
* **Device-as-Cloud KV Engine**: Turns any connected client device into an active cloud storage node using local IndexedDB, served to peers via WebRTC DataChannels with WSS fallback.
* **Server-Side Token Security**: GitHub Access Tokens and Cloudflare API keys are kept strictly on the server/worker side. The client never handles sensitive API credentials.
* **Multi-Store Infrastructure**: Integrates Cloudflare Workers KV (multi-namespace), Cloudflare D1 (Serverless SQL), Cloudflare R2 (Object Storage), and GitHub Repositories (Git KV).
* **Multi-Transport P2P Mesh**: Auto-routes payloads through WebRTC DataChannels, local tab `BroadcastChannel` instances, or WSS relay connections.

---

## Security & Architecture

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
                                  +---------+-------------------+---------+
                                            |                   |
            +-------------------------------+                   +-------------------------------+
            |                               |                                                   |
+-----------v-----------+       +-----------v-----------+                           +-----------v-----------+
|   Cloudflare Stores   |       |      Git KV Proxy     |                           |   Device-as-Cloud Host|
| (KV / D1 SQL / R2)    |       | (GitHub API + Tokens) |                           | (WebRTC + IndexedDB)  |
+-----------------------+       +-----------------------+                           +-----------------------+

```

### Identity & Privacy Model

To protect user IP addresses while enabling match-making, LAN detection, and device identification:

| Identifier | Generation Logic | Purpose |
| --- | --- | --- |
| `deviceHash` | `SHA256(Client_IP + ":device")` | Unique hardware/device fingerprint without exposing raw IP addresses. |
| `netHash` | `SHA256(Client_Subnet + ":net")` | Identifies peers on the same local network (LAN) for low-latency routing. |
| `joinHash` | `UUIDv4` (Truncated) | Per-session ephemeral identifier for WebRTC signaling and messaging. |
| `timezone` | `Intl.DateTimeFormat` | Exposed timezone ID (e.g., `America/New_York`) for time-zone matching and game sync. |

### Zero-Exposure Token Guarantee

GitHub Personal Access Tokens (`GITHUB_TOKEN`), Cloudflare API keys, and database secrets are bound exclusively to the Cloudflare Worker environment. Requests from the browser specify target keys or SQL queries, which the worker executes on behalf of the client after validating payload structures.

---

## Developer Quick Start (Client Integration)

### 1. Basic Game / App Connection (`n3xn-sdk.js`)

Drop `n3xn-sdk.js` into any web page or game project—including local `file://` files:

```html
<script src="src/n3xn-sdk.js"></script>
<script>
  const sdk = new N3xnGameSDK('wss://relay.n3xn.dev/ws');

  async function start() {
    // 1. Establish connection and receive generated identity hashes
    const identity = await sdk.connect();
    console.log(`Connected! Device Hash: ${identity.deviceHash}, TZ: ${identity.timezone}`);

    // 2. Join a multiplayer lobby or room
    const room = await sdk.joinRoom('global-arena');
    console.log('Players in room:', room.occupants);

    // 3. Listen for state updates from other players
    sdk.onStateUpdate((evt) => {
      console.log(`Player ${evt.sender} moved:`, evt.data);
    });

    // 4. Send position/state updates to room peers
    sdk.sendGameState({ x: 120, y: 340, state: 'running' });
  }

  start();
</script>

```

### 2. Multi-Store Data Operations (`n3xn-store.js`)

Query Cloudflare KV, D1 SQL, R2, or Git KV over WSS:

```javascript
import { N3xnTransport } from './src/n3xn-transport.js';
import { N3xnStoreClient } from './src/n3xn-store.js';

const transport = new N3xnTransport('wss://relay.n3xn.dev/ws');
await transport.connect();

const store = new N3xnStoreClient(transport);

// Save to Cloudflare Workers KV
await store.kvSet('user_score', { score: 9950, rank: 'Ace' });

// Query Cloudflare D1 SQL
const topPlayers = await store.sqlQuery('SELECT * FROM leaderboards ORDER BY score DESC LIMIT 10');

// Save a blob to Cloudflare R2
await store.r2Put('savegames/slot1.json', JSON.stringify({ level: 5, inventory: ['sword', 'shield'] }));

```

### 3. Hosting a "Device Cloud" Node (`device-kv.js`)

Convert a browser tab into an active database server for other connected clients:

```javascript
import { N3xnTransport } from './src/n3xn-transport.js';
import { N3xnDeviceKVHost, N3xnDeviceKVClient } from './src/device-kv.js';

const transport = new N3xnTransport('wss://relay.n3xn.dev/ws');
await transport.connect();

// HOST SIDE: Turn this tab/device into a Cloud Node
const hostNode = new N3xnDeviceKVHost(transport, 'Node-Alpha');
await hostNode.init(); // Opens IndexedDB & registers with signaling mesh

// CLIENT SIDE: Connect to a remote device cloud node via WebRTC
const remoteHostJoinHash = 'target-join-hash-here';
const deviceDb = new N3xnDeviceKVClient(transport, remoteHostJoinHash);

// Read/Write directly over WebRTC DataChannel
await deviceDb.set('player_data', { health: 100 });
const data = await deviceDb.get('player_data');

```

---

## Forking & Deployment Guide

Follow these steps to deploy your own instance of the relay on Cloudflare Workers and Cloudflare Pages.

### Prerequisites

* [Node.js](https://nodejs.org/) (v18 or higher)
* [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
* A Cloudflare account (Free Tier works for standard deployments)
* A GitHub account (if using Git KV)

### 1. Clone & Install

```bash
git clone https://github.com/kbsigmaboy67AtSchool/relay.git
cd relay
npm install

```

### 2. Configure Cloudflare Resources

Create the required KV namespaces, D1 Database, and R2 Bucket using Wrangler:

```bash
# Create KV Namespaces
wrangler kv namespace create PRIMARY_KV
wrangler kv namespace create CACHE_KV

# Create D1 Database
wrangler d1 create n3xn-db

# Create R2 Bucket
wrangler r2 bucket create n3xn-storage-bucket

```

Update your `wrangler.toml` file with the generated IDs:

```toml
name = "n3xn-relay-worker"
main = "src/worker.js"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "PRIMARY_KV"
id = "YOUR_PRIMARY_KV_ID"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "YOUR_CACHE_KV_ID"

[[d1_databases]]
binding = "DB"
database_name = "n3xn-db"
database_id = "YOUR_D1_DATABASE_ID"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "n3xn-storage-bucket"

[vars]
GIT_OWNER = "your-github-username"
GIT_REPO = "your-repo-name"

```

### 3. Add Environment Secrets

Set your GitHub token securely so the worker can perform Git KV proxy operations:

```bash
wrangler secret put GITHUB_TOKEN

```

### 4. Deploy to Cloudflare Workers

```bash
wrangler deploy

```

Your WSS Gateway is now live at `wss://<your-worker-subdomain>.workers.dev/ws`.

### 5. Linking Cloudflare Pages (`pages.dev`)

While Cloudflare Pages serves static frontend files and cannot run full persistent WebSocket handlers on its own, `public/_routes.json` maps dynamic paths to your worker relay:

1. Connect your repo to **Cloudflare Pages**.
2. Set the build output directory to `public`.
3. Ensure `public/_routes.json` is included:

```json
{
  "version": 1,
  "include": ["/ws", "/api/*"],
  "exclude": ["/static/*", "/*.html", "/*.css", "/*.js"]
}

```

Calls to `[https://your-app.pages.dev/ws](https://your-app.pages.dev/ws)` will automatically route to your edge worker.

---

## Recommended Use Cases & Games

This architecture is optimized for web applications and browser-based games requiring zero-backend operational overhead, local-first syncing, or cross-client connectivity:

| Category | Description | Recommended Integration |
| --- | --- | --- |
| **WebMC / Minecraft Web Clients** | EaglercraftX-style client-server signaling, custom server browser lists, and local save syncing across domain origins. | `N3xnGameSDK` + WSS Relay |
| **Retro Emulators & ROM Stores** | Save-state synchronization across devices using Device-as-Cloud or Cloudflare R2 object storage. | `N3xnDeviceKVHost` + R2 Storage |
| **HTML5 Multiplayer Games** | Real-time position syncing, peer discovery, and lobby management for Canvas, Phaser, Three.js, or Godot web builds. | `N3xnTransport` + WebRTC P2P |
| **P2P File & Asset Sharing** | Directly transfer large asset bundles, custom levels, or media files between browser sessions without intermediate server storage limits. | WebRTC DataChannels (`sendP2P`) |
| **Virtual Filesystems (VFS)** | Encrypted cloud sync, remote execution offloading, and collaborative file editing across sessions. | `N3xnStoreClient` + Git KV |

---

## Project Structure

```
.
├── wrangler.toml         # Cloudflare Worker configuration & bindings
├── public/
│   └── _routes.json      # Cloudflare Pages routing configuration
└── src/
    ├── worker.js         # Edge gateway, WebSocket router, and storage API
    ├── n3xn-transport.js # Universal client transport (WSS + WebRTC + fallback)
    ├── n3xn-store.js     # Multi-store client wrapper (KV, D1, R2, Git)
    ├── device-kv.js      # Device-as-Cloud IndexedDB server & client
    └── n3xn-sdk.js       # Game SDK for state sync & room lobbies

```
