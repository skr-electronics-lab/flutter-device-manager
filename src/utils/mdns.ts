import * as dgram from "dgram";
import { logger } from "./logger";

export interface DiscoveredMdnsEndpoint {
  name: string;
  type: "pairing" | "connect";
  ip: string;
  port: number;
}

/**
 * Lightweight local UDP Multicast listener on 224.0.0.251:5353.
 * Directly captures Android Wi-Fi pairing and connect announcements even if
 * the host ADB daemon's mDNS is blocked or delayed by Windows Defender Firewall.
 */
export class MdnsListener {
  private socket: dgram.Socket | null = null;
  private onFoundCallback?: (endpoint: DiscoveredMdnsEndpoint) => void;

  start(onFound: (endpoint: DiscoveredMdnsEndpoint) => void): void {
    this.onFoundCallback = onFound;
    try {
      this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      this.socket.on("error", (err) => {
        logger.warn("mdns", `mDNS socket error: ${err.message}`);
      });

      this.socket.on("message", (msg, rinfo) => {
        this.parsePacket(msg, rinfo.address);
      });

      this.socket.bind(5353, () => {
        try {
          this.socket?.addMembership("224.0.0.251");
          this.query("_adb-tls-pairing._tcp.local");
          this.query("_adb-tls-connect._tcp.local");
        } catch (err) {
          logger.warn("mdns", `Multicast group join note: ${err}`);
        }
      });
    } catch (err) {
      logger.warn("mdns", `mDNS listener init error: ${err}`);
    }
  }

  query(serviceName: string): void {
    if (!this.socket) return;
    try {
      const parts = serviceName.split(".");
      const labelBuffers: Buffer[] = [];
      for (const part of parts) {
        if (!part) continue;
        const b = Buffer.from(part, "utf8");
        labelBuffers.push(Buffer.from([b.length]));
        labelBuffers.push(b);
      }
      labelBuffers.push(Buffer.from([0]));

      const qname = Buffer.concat(labelBuffers);
      const header = Buffer.alloc(12);
      header.writeUInt16BE(1, 4); // QDCOUNT = 1

      const qtail = Buffer.alloc(4);
      qtail.writeUInt16BE(12, 0); // QTYPE = PTR (12)
      qtail.writeUInt16BE(1, 2);  // QCLASS = IN (1)

      const packet = Buffer.concat([header, qname, qtail]);
      this.socket.send(packet, 0, packet.length, 5353, "224.0.0.251");
    } catch {
      /* ignore query send error */
    }
  }

  private parsePacket(buf: Buffer, senderIp: string): void {
    const str = buf.toString("latin1");
    const isPairing = str.includes("_adb-tls-pairing");
    const isConnect = str.includes("_adb-tls-connect");

    if (!isPairing && !isConnect) return;

    // Search for SRV records (Type 33 = 0x00 0x21) in the buffer
    for (let i = 12; i < buf.length - 12; i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x21) {
        const rdlength = buf.readUInt16BE(i + 8);
        if (rdlength >= 6 && i + 10 + rdlength <= buf.length) {
          // Priority (2) + Weight (2) -> Port is 2 bytes at offset 4
          const port = buf.readUInt16BE(i + 10 + 4);
          if (port > 1024 && port <= 65535) {
            const type: "pairing" | "connect" = isPairing ? "pairing" : "connect";
            let name = `adb-${senderIp.replace(/\./g, "-")}`;
            const nameMatch = /(adb-[a-zA-Z0-9_-]+|studio-[a-zA-Z0-9_-]+)/i.exec(str);
            if (nameMatch) {
              name = nameMatch[1];
            }
            this.onFoundCallback?.({
              name,
              type,
              ip: senderIp,
              port,
            });
            return;
          }
        }
      }
    }
  }

  stop(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}
