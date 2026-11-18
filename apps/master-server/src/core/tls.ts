// Self-signed gateway certificate. Generated once on first run; clients pin its
// SHA-256 fingerprint during pairing, so it is never "trusted blindly".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as selfsigned from 'selfsigned';
import { atomicWriteSync } from '../../../../packages/local-memory/src/fsutil';
import type { SecretStore } from './config';
import type { TlsMaterial } from './gateway';

export function certFingerprint(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

export async function loadOrCreateTls(dataDir: string, secrets: SecretStore): Promise<TlsMaterial> {
  const certFile = path.join(dataDir, 'gateway-cert.pem');
  const key = secrets.get('gateway-tls-key');
  if (key && fs.existsSync(certFile)) {
    try {
      const cert = fs.readFileSync(certFile, 'utf8');
      const x = new crypto.X509Certificate(cert);
      if (new Date(x.validTo).getTime() > Date.now() + 30 * 86_400_000 && x.checkPrivateKey(crypto.createPrivateKey(key))) {
        return { key, cert, fingerprint: certFingerprint(cert) };
      }
    } catch {
      /* regenerate below */
    }
  }
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  const pems = await (selfsigned as any).generate([{ name: 'commonName', value: 'Raven Master Gateway' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'raven-master.local' }] },
    ],
  });
  secrets.set('gateway-tls-key', pems.private);
  atomicWriteSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert, fingerprint: certFingerprint(pems.cert) };
}
