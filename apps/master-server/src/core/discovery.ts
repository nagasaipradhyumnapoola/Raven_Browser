// LAN discovery: advertise the gateway over mDNS so browsers find it without
// typing an address. Only the port and a fingerprint prefix are advertised.
import { Bonjour, type Service } from 'bonjour-service';
import { PRODUCT } from '@raven/shared';

export class Advertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  start(name: string, port: number, fingerprint: string): void {
    this.stop();
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: `${name} (${fingerprint.slice(0, 6)})`,
        type: PRODUCT.mdnsType,
        port,
        txt: { v: String(PRODUCT.protocolVersion), fp: fingerprint.slice(0, 16), name },
      });
      this.service.on?.('error', () => {});
    } catch {
      this.bonjour = null;
      this.service = null;
    }
  }

  stop(): void {
    try {
      this.service?.stop?.();
      this.bonjour?.destroy();
    } catch {
      /* ignore */
    }
    this.service = null;
    this.bonjour = null;
  }
}
