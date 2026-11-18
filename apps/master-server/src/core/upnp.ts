// Ask the home router (UPnP IGD) to forward the gateway port, so paired devices can reach this master
// from any network. Nothing is opened unless the owner turned Remote access on; the mapping is removed
// when Remote access is turned off or the app quits. Plain node: SSDP over UDP + SOAP over HTTP.
import dgram from 'node:dgram';
import { interfaces } from './gateway';

export interface UpnpStatus {
  state: 'off' | 'searching' | 'mapped' | 'unsupported' | 'error';
  externalIp: string | null;
  port: number | null;
  error: string | null;
}

interface Igd {
  controlUrl: string;
  service: string;
  localIp: string;
}

const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

function localIpFor(routerHost: string): string | null {
  const parts = routerHost.split('.').map(Number);
  let best: string | null = null;
  for (const a of interfaces()) {
    if ((a.family !== 'IPv4' && a.family !== '4') || a.internal) continue;
    const mine = a.address.split('.').map(Number);
    const mask = (a.netmask ?? '255.255.255.0').split('.').map(Number);
    if (mine.every((m, i) => (m & mask[i]) === (parts[i] & mask[i]))) return a.address;
    best ??= a.address;
  }
  return best;
}

async function discover(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found]);
    };
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) found.add(m[1].trim());
    });
    sock.on('error', done);
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2']) {
        const q = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(q, 1900, '239.255.255.250');
      }
    });
    setTimeout(done, timeoutMs);
  });
}

async function describe(location: string): Promise<Igd | null> {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await res.text();
  for (const svc of SERVICES) {
    const i = xml.indexOf(`<serviceType>${svc}</serviceType>`);
    if (i < 0) continue;
    const block = xml.slice(i, xml.indexOf('</service>', i));
    const ctl = /<controlURL>([^<]+)<\/controlURL>/.exec(block)?.[1];
    if (!ctl) continue;
    const u = new URL(ctl, location);
    const localIp = localIpFor(u.hostname);
    if (!localIp) return null;
    return { controlUrl: u.toString(), service: svc, localIp };
  }
  return null;
}

async function soap(igd: Igd, action: string, args: Record<string, string | number>): Promise<string> {
  const body =
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${igd.service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(igd.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${igd.service}#${action}"` },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) {
    const desc = /<errorDescription>([^<]+)</.exec(text)?.[1];
    throw new Error(desc ? `router said: ${desc}` : `router answered HTTP ${res.status}`);
  }
  return text;
}

export class PortMapper {
  status: UpnpStatus = { state: 'off', externalIp: null, port: null, error: null };
  private igd: Igd | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** port we actually added on the router (removed again whatever happens next) */
  private created: number | null = null;

  constructor(private onChange: () => void) {}

  /** Map `port` (TCP) on the router; refreshes every 20 minutes while on. */
  async enable(port: number): Promise<void> {
    if (this.running && this.status.port === port) return;
    this.running = true;
    await this.map(port);
  }

  private async map(port: number): Promise<void> {
    this.set({ state: 'searching', externalIp: null, port, error: null });
    try {
      if (!this.igd) {
        const locations = await discover();
        for (const loc of locations) {
          try {
            this.igd = await describe(loc);
          } catch {
            this.igd = null;
          }
          if (this.igd) break;
        }
      }
      if (!this.running) return;
      if (!this.igd) return this.set({ state: 'unsupported', externalIp: null, port, error: 'The router did not offer automatic port forwarding (UPnP is off or missing).' });
      await soap(this.igd, 'AddPortMapping', {
        NewRemoteHost: '',
        NewExternalPort: port,
        NewProtocol: 'TCP',
        NewInternalPort: port,
        NewInternalClient: this.igd.localIp,
        NewEnabled: 1,
        NewPortMappingDescription: 'Raven Master',
        NewLeaseDuration: 3600,
      });
      this.created = port;
      const ipXml = await soap(this.igd, 'GetExternalIPAddress', {});
      const ip = /<NewExternalIPAddress>([^<]*)</.exec(ipXml)?.[1] ?? null;
      // Carrier-grade NAT hands the router a private address: the mapping exists but cannot be reached from outside.
      const cgnat = !!ip && (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip));
      if (cgnat || !ip) {
        // Useless from outside: take the forwarding back off the router right away.
        await this.removeMapping();
        this.set({ state: 'unsupported', externalIp: null, port, error: cgnat ? 'Your internet provider shares one public address between customers, so a router port cannot be reached from outside. Use a VPN (Tailscale, ZeroTier) or a tunnel address instead.' : 'The router did not report a public address.' });
        return;
      }
      this.set({ state: cgnat || !ip ? 'unsupported' : 'mapped', externalIp: cgnat ? null : ip, port, error: cgnat ? 'Your internet provider shares one public address between customers, so a router port cannot be reached from outside. Use a tunnel address instead.' : null });
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => void this.refresh(port), 20 * 60_000);
      this.timer.unref?.();
    } catch (e) {
      this.set({ state: 'error', externalIp: null, port, error: (e as Error).message.slice(0, 200) });
    }
  }

  private async refresh(port: number): Promise<void> {
    if (this.running) await this.map(port);
  }

  async disable(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.removeMapping();
    this.set({ state: 'off', externalIp: null, port: null, error: null });
  }

  private async removeMapping(): Promise<void> {
    if (this.igd && this.created) {
      await soap(this.igd, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: this.created, NewProtocol: 'TCP' }).catch(() => {});
    }
    this.created = null;
  }

  /** For checks: is a mapping we made still on the router? */
  async stillMapped(port: number): Promise<boolean> {
    if (!this.igd) return false;
    try {
      const x = await soap(this.igd, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
      return /NewInternalPort/.test(x);
    } catch {
      return false;
    }
  }

  private set(s: UpnpStatus): void {
    this.status = s;
    this.onChange();
  }
}
