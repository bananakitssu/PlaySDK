import test from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection } from "werift";
import { RServer } from "../src/rserver.js";

function toBuffer(data: unknown): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("Unexpected WebRTC message payload.");
}

test("rServer exchanges raw packets over a real werift DataChannel", { timeout: 20_000 }, async () => {
  const server = new RServer({ maxPacketBytes: 1024 });
  const client = new RTCPeerConnection({ iceServers: [] });
  const clientChannel = client.createDataChannel("rserver");
  const requestPacket = Buffer.from([0x01, 0x02, 0xfe, 0xff]);
  const responsePacket = Buffer.from([0xba, 0x7e, 0x00]);

  const receivedByServer: Buffer[] = [];
  server.on("packet", ({ sessionId, packet }) => {
    receivedByServer.push(Buffer.from(packet));
    server.sendPacket(sessionId, responsePacket);
  });

  const response = new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for an rServer packet reply.")), 15_000);
    clientChannel.onopen = () => clientChannel.send(requestPacket);
    clientChannel.onmessage = ({ data }: { data: unknown }) => {
      clearTimeout(timer);
      resolve(toBuffer(data));
    };
  });

  try {
    await client.setLocalDescription(await client.createOffer());
    const offerSdp = client.localDescription?.sdp;
    assert.ok(offerSdp, "werift should create a local SDP offer");

    const accepted = await server.acceptOffer(offerSdp, "integration-test");
    assert.equal(accepted.sessionId, "integration-test");
    assert.match(accepted.answerSdp, /v=0/);

    await client.setRemoteDescription({ type: "answer", sdp: accepted.answerSdp });

    assert.deepEqual(await response, responsePacket);
    assert.deepEqual(receivedByServer, [requestPacket]);
    assert.equal(server.peerCount, 1);
    assert.equal(server.listPeers()[0]?.sessionId, "integration-test");
  } finally {
    await server.close();
    await client.close();
  }

  assert.equal(server.peerCount, 0);
});

test("rServer rejects invalid packet limits and malformed SDP offers", async () => {
  assert.throws(() => new RServer({ maxPacketBytes: 0 }), RangeError);

  const server = new RServer();
  try {
    await assert.rejects(server.acceptOffer("not an SDP offer"), TypeError);
    assert.equal(server.peerCount, 0);
  } finally {
    await server.close();
  }
});
