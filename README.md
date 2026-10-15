# PlaySDK

A Node.js/TypeScript SDK for Banana Play games. It wraps Banana Play's existing Play OAuth player API for saved data and game presence, and includes **rServer**, a raw-packet WebRTC DataChannel server built with [werift](https://github.com/shinyoshiaki/werift-webrtc).

> PlaySDK does not implement the unfinished PlayFab-like service. It only uses already-available Play OAuth endpoints.

## Install

```sh
npm install github:bananakitssu/PlaySDK
```

Use Node.js 22 or newer for `rServer` (the current `werift` release requires Node 22+).

## Play OAuth setup

Create a **Play OAuth** app in Banana Developers and request only the scopes the game needs. The game completes Authorization Code + PKCE and passes its player's access token to the SDK. Never put a client secret in a game or browser build.

API base URL defaults to `https://banana-datacenter.vercel.app/play-api`.

```ts
import { PlaySDK } from "bananakitssu-playsdk";

const play = new PlaySDK({
  accessToken: playerAccessToken,
  // apiBaseUrl: "https://banana-datacenter.vercel.app/play-api",
});

const profile = await play.getProfile();
console.log(profile.username);

// Data is separated by player AND this game's Play OAuth client.
await play.saveData("settings", { sound: true, quality: "high" });
const settings = await play.loadData<{ sound: boolean; quality: string }>("settings");
const savedSettings = await play.getSavedData("settings"); // value + updatedAt
await play.deleteSavedData("settings");

// Game achievements are defined by the publisher in Banana Developers.
// Claim only after your game logic confirms the milestone is earned.
const achievements = await play.getAchievements("my-game");
const claim = await play.claimAchievement("my-game", "first-win");
if (claim.claimed) console.log("Achievement unlocked:", claim.achievement.title);
```

### Scopes

| Feature | Play OAuth scope |
| --- | --- |
| `getProfile()` | `play:profile:read` |
| `getSavedData()` / `loadData()` | `play:data:read` |
| `saveData()` / `deleteSavedData()` | `play:data:write` |
| activity methods | `play:presence:write` |
| `getAchievements()` / `claimAchievement()` | `play:achievements:write` |

The SDK follows the current API limits: data keys are 1–128 characters (`A–Z`, `a–z`, digits, `.`, `_`, `:`, `-`); values are JSON and at most 64 KiB each; up to 256 keys and 1 MiB total per player/game; 30 save/delete writes per minute; activity text up to 80 characters; activity TTL 30–180 seconds. The server remains authoritative.


### Game achievements

Create game achievements in Banana Developers → **Games** → the game's **Achievements** panel. Each achievement has a stable ID, display name, description, and optional XP reward. Use an ID such as `first-win` in your game code:

```ts
const achievements = await play.getAchievements("my-game");
if (!achievements.some((item) => item.achievementId === "first-win" && item.unlocked)) {
  // The actual condition must be checked by your game first.
  const result = await play.claimAchievement("my-game", "first-win");
  if (result.claimed) {
    console.log(result.achievement.title, result.achievement.xp, "XP");
  }
}
```

Request the `play:achievements:write` scope for these methods. Banana verifies that the OAuth app belongs to the game's publisher, the player is allowed to access that game's age rating, the achievement is defined by the developer, and each player can claim it only once. Repeating a claim is safe and returns `alreadyUnlocked: true` without awarding XP again. **The SDK does not decide whether the achievement condition was met**; call `claimAchievement()` only after validating it in your game logic, and keep competitive or high-value conditions server-side.

## Change a player's activity

Set a temporary status once:

```ts
await play.setActivity("MineJS: In the menus");
```

For active gameplay, refresh the status so it doesn't expire. Stop the lease when leaving the game:

```ts
const activity = await play.startActivity("MineJS: In the menus", {
  ttlSeconds: 120,
  refreshEveryMs: 60_000,
  onError(error) {
    console.error("Could not refresh Banana Play activity", error);
  },
});

// Later, when the game exits:
await activity.stop(); // DELETE /presence; restores "Online"
```

You can switch it while the game is running:

```ts
await activity.update("MineJS: minecraft:overworld");
```

If the game crashes, presence expires automatically because the server TTL is temporary.

## rServer: packet-level WebRTC

`RServer` runs on Node.js and uses **werift** to accept a WebRTC offer and create an answer. Once the client opens a DataChannel, the SDK emits binary packet events. It does not impose a game-specific packet format: your protocol owns the bytes.

```ts
import { RServer } from "bananakitssu-playsdk";

const server = new RServer({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  dataChannelLabel: "rserver",
  maxPacketBytes: 64 * 1024,
});

server.on("packet", ({ sessionId, packet, channelLabel }) => {
  // packet is a Node.js Buffer containing the exact incoming bytes.
  console.log(sessionId, channelLabel, packet);
  server.sendPacket(sessionId, packet); // echo example
});

const { sessionId, answerSdp } = await server.acceptOffer(offerSdp);
// Send { sessionId, answerSdp } to the game client through your signaling transport.

server.on("peerDisconnect", ({ sessionId }) => {
  console.log("disconnected", sessionId);
});

await server.close(); // shutdown
```

### Minimal signaling example

Run the bundled example:

```sh
npm install
npm run build
node --import tsx examples/http-signaling.ts
```

It starts an HTTP signaling endpoint at `POST /offer`. The request body is `{ "sdp": "<complete local offer sdp>", "sessionId": "optional-id" }`; the response contains `{ "sessionId", "answerSdp" }`. It echoes packets as a demo.

Browser-side flow (wait until ICE gathering completes before sending the offer when using this non-trickle example):

```js
const pc = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
const channel = pc.createDataChannel("rserver");
channel.binaryType = "arraybuffer";
channel.onmessage = ({ data }) => {
  // data is an ArrayBuffer containing one packet
};

await pc.setLocalDescription(await pc.createOffer());
await new Promise((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState === "complete") resolve();
  });
});
const response = await fetch("https://your-game-server.example/offer", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sdp: pc.localDescription.sdp }),
});
const { answerSdp } = await response.json();
await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
channel.onopen = () => channel.send(new Uint8Array([0x01, 0x02, 0x03]));
```

For production, expose signaling over HTTPS/WSS, authenticate and rate-limit offers, cap concurrent sessions, set up a TURN service for networks where direct ICE fails, and avoid logging player tokens or private game payloads. The included HTTP example is a starter and is not an authenticated public service.

## Events

- `offerAccepted`: `{ sessionId }`
- `peerConnect`: `RServerPeer`
- `peerState`: `{ sessionId, state }`
- `packet`: `RServerPacket` (`sessionId`, `channelLabel`, `packet: Buffer`, `receivedAt`)
- `packetError`: `{ sessionId, error }`
- `peerError`: `{ sessionId, error }`
- `peerDisconnect`: `{ sessionId }`
- `channelClose`: `{ sessionId, label }`

## Development

```sh
npm install
npm run check
```

`PlayAPIError` exposes `status`, `code`, `retryAfterSeconds`, and API `details` for handling rate limits and missing OAuth scopes.
