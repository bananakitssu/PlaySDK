import { createServer } from "node:http";
import { RServer } from "../src/rserver.js";

const port = Number(process.env.PORT ?? 8787);
const server = new RServer({
  iceServers: process.env.TURN_URL
    ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }]
    : [{ urls: "stun:stun.l.google.com:19302" }],
  maxPacketBytes: 64 * 1024,
});

server.on("packet", ({ sessionId, packet }) => {
  console.log(`packet from ${sessionId}: ${packet.length} bytes`);
  // Example echo. Replace with your game protocol handler.
  server.sendPacket(sessionId, packet);
});

server.on("peerError", ({ sessionId, error }) => {
  console.error(`peer ${sessionId} error`, error);
});

const http = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/offer") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > 1_000_000) req.destroy();
  });
  req.on("end", async () => {
    try {
      const input = JSON.parse(body) as { sdp?: string; sessionId?: string };
      if (!input.sdp) throw new TypeError("sdp is required");
      const answer = await server.acceptOffer(input.sdp, input.sessionId);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid_offer" }));
    }
  });
});

http.listen(port, () => console.log(`rServer signaling example listening on http://localhost:${port}`));

async function shutdown() {
  http.close();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
