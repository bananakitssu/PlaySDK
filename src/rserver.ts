import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { RTCPeerConnection } from "werift";

export interface RServerOptions {
  /** ICE server configuration passed to werift. Configure TURN for clients behind strict NATs. */
  iceServers?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  /** Default DataChannel label expected from clients. Defaults to "rserver". */
  dataChannelLabel?: string;
  /** Maximum accepted application packet size in bytes. Defaults to 64 KiB. */
  maxPacketBytes?: number;
}

export interface RServerPeer {
  sessionId: string;
  state: string;
  connectedAt: number | null;
  channelCount: number;
}

export interface RServerPacket {
  sessionId: string;
  channelLabel: string;
  packet: Buffer;
  receivedAt: number;
}

type PacketInput = Uint8Array | ArrayBuffer | string;

interface PeerSession {
  id: string;
  pc: RTCPeerConnection;
  channels: Set<any>;
  connectedAt: number | null;
  closing: boolean;
}

/**
 * rServer is a WebRTC DataChannel packet server backed by werift.
 *
 * Signaling is deliberately transport-agnostic: call acceptOffer() with the SDP offer from
 * the game client, return answerSdp to it, and exchange ICE candidates out-of-band if using
 * trickle ICE. The no-trickle path is simplest when each side waits for ICE gathering.
 *
 * Packets are raw bytes, not JSON messages. Frame your own protocol above this transport.
 */
export class RServer extends EventEmitter {
  private readonly options: Required<Pick<RServerOptions, "dataChannelLabel" | "maxPacketBytes">>
    & Pick<RServerOptions, "iceServers">;
  private readonly sessions = new Map<string, PeerSession>();

  constructor(options: RServerOptions = {}) {
    super();
    const maxPacketBytes = options.maxPacketBytes ?? 64 * 1024;
    if (!Number.isInteger(maxPacketBytes) || maxPacketBytes < 1) {
      throw new RangeError("maxPacketBytes must be a positive integer.");
    }
    this.options = {
      ...(options.iceServers === undefined ? {} : { iceServers: options.iceServers }),
      dataChannelLabel: options.dataChannelLabel ?? "rserver",
      maxPacketBytes,
    };
  }

  get peerCount(): number {
    return this.sessions.size;
  }

  listPeers(): RServerPeer[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      state: String(session.pc.connectionState ?? session.pc.iceConnectionState ?? "unknown"),
      connectedAt: session.connectedAt,
      channelCount: session.channels.size,
    }));
  }

  /**
   * Accept a client's complete SDP offer and return the SDP answer.
   * sessionId may be assigned by the caller for correlation with its signaling layer.
   */
  async acceptOffer(
    offerSdp: string,
    sessionId = randomUUID(),
  ): Promise<{ sessionId: string; answerSdp: string }> {
    if (typeof offerSdp !== "string" || !offerSdp.trim() || !offerSdp.includes("v=0")) {
      throw new TypeError("offerSdp must be a non-empty SDP offer.");
    }
    if (!sessionId.trim() || this.sessions.has(sessionId)) {
      throw new Error("sessionId must be non-empty and unique.");
    }

    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers ?? [],
    });
    const session: PeerSession = {
      id: sessionId,
      pc,
      channels: new Set(),
      connectedAt: null,
      closing: false,
    };
    this.sessions.set(sessionId, session);

    pc.ondatachannel = ({ channel }: { channel: any }) => {
      session.channels.add(channel);
      channel.onopen = () => {
        session.connectedAt = Date.now();
        this.emit("peerConnect", this.describePeer(session));
      };
      channel.onmessage = ({ data }: { data: unknown }) => {
        let packet: Buffer;
        try {
          packet = this.toBuffer(data as PacketInput);
        } catch (error) {
          this.emit("packetError", { sessionId, error });
          return;
        }
        if (packet.byteLength > this.options.maxPacketBytes) {
          this.emit("packetError", {
            sessionId,
            error: new RangeError(`Packet is ${packet.byteLength} bytes; max is ${this.options.maxPacketBytes}.`),
          });
          return;
        }
        const event: RServerPacket = {
          sessionId,
          channelLabel: String(channel.label ?? this.options.dataChannelLabel),
          packet,
          receivedAt: Date.now(),
        };
        this.emit("packet", event);
      };
      channel.onclose = () => {
        session.channels.delete(channel);
        this.emit("channelClose", { sessionId, label: String(channel.label ?? "") });
      };
      channel.onerror = (error: unknown) => this.emit("peerError", { sessionId, error });
    };

    pc.onconnectionstatechange = () => {
      const state = String(pc.connectionState ?? "");
      this.emit("peerState", { sessionId, state });
      if (state === "failed" || state === "closed") {
        void this.closePeer(sessionId);
      }
    };

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const answerSdp = pc.localDescription?.sdp;
      if (!answerSdp) throw new Error("werift did not produce an SDP answer.");
      this.emit("offerAccepted", { sessionId });
      return { sessionId, answerSdp };
    } catch (error) {
      await this.closePeer(sessionId);
      throw error;
    }
  }

  /** Send one raw packet to a connected peer; returns false if no channel is open. */
  sendPacket(sessionId: string, packet: PacketInput): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return false;
    const bytes = this.toBuffer(packet);
    this.assertPacketSize(bytes);
    const channel = [...session.channels].find((item) => item.readyState === "open");
    if (!channel) return false;
    channel.send(bytes);
    return true;
  }

  /** Broadcast one packet to all peers that currently have an open DataChannel. Returns send count. */
  broadcast(packet: PacketInput): number {
    const bytes = this.toBuffer(packet);
    this.assertPacketSize(bytes);
    let sent = 0;
    for (const session of this.sessions.values()) {
      for (const channel of session.channels) {
        if (channel.readyState !== "open") continue;
        channel.send(bytes);
        sent += 1;
        break;
      }
    }
    return sent;
  }

  async closePeer(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    session.closing = true;
    this.sessions.delete(sessionId);
    for (const channel of session.channels) {
      try { channel.close(); } catch { /* already closed */ }
    }
    session.channels.clear();
    try { await session.pc.close(); } catch { /* already closed */ }
    this.emit("peerDisconnect", { sessionId });
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closePeer(id)));
    this.removeAllListeners();
  }

  private describePeer(session: PeerSession): RServerPeer {
    return {
      sessionId: session.id,
      state: String(session.pc.connectionState ?? session.pc.iceConnectionState ?? "unknown"),
      connectedAt: session.connectedAt,
      channelCount: session.channels.size,
    };
  }

  private assertPacketSize(bytes: Buffer): void {
    if (bytes.byteLength > this.options.maxPacketBytes) {
      throw new RangeError(`Packet is ${bytes.byteLength} bytes; max is ${this.options.maxPacketBytes}.`);
    }
  }

  private toBuffer(data: PacketInput): Buffer {
    if (typeof data === "string") return Buffer.from(data, "utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError("A packet must be a string, ArrayBuffer, or Uint8Array.");
  }
}

export function createRServer(options: RServerOptions = {}): RServer {
  return new RServer(options);
}
