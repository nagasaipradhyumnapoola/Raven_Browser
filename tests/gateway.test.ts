// Integration tests for the master gateway. Everything here runs over real
// TLS sockets on loopback; nothing is simulated except the FreeLLMAPI process
// (a stand-in HTTP server speaking its documented wire format) and the origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import { DEFAULT_LIMITS } from '@raven/shared';
import { authTranscript, generateDeviceKeyPair, signTranscript } from '@raven/security';
import { GatewayClient, MuxSession } from '@raven/network-protocol';
import {
  MockLlm,
  Origin,
  codeOf,
  collectAi,
  endpointFor,
  expectedBigSha,
  newIdentity,
  pairedClient,
  proxyConnect,
  proxyGet,
  proxyThrough,
  sleep,
  startMaster,
  waitFor,
} from './helpers';

const ask = (model = 'auto') => ({ messages: [{ role: 'user' as const, content: 'hi' }], model, profile: 'general' as const });

test('pairing: unknown device waits for approval, then gets a welcome with its permissions', async () => {
  const h = await startMaster();
  try {
    const id = newIdentity();
    const client = new GatewayClient(id, { name: 'Laptop B', appVersion: '1.0.0' });
    const res = await client.connect(endpointFor(h, null));
    assert.equal(res.phase, 'pending');
    assert.equal(res.pin, h.tls.fingerprint, 'client learns the real certificate fingerprint');
    assert.match(res.pairingCode ?? '', /^\d{6}$/);
    const rec = h.devices.get(id.deviceId)!;
    assert.equal(rec.status, 'pending');
    assert.equal(rec.pairingCode, res.pairingCode, 'same code on dashboard and browser');
    // A pending device cannot use anything.
    assert.equal(await codeOf(client.openTcp('example.com', 443)), 'server_unreachable');
    const approved = new Promise<void>((r) => client.once('approved', () => r()));
    assert.ok(h.gateway.approveDevice(id.deviceId));
    await approved;
    assert.equal(client.state?.deviceStatus, 'approved');
    assert.deepEqual(client.state?.permissions, { internet: true, ai: true });
    assert.ok((client.state?.models.length ?? 0) >= 3);
    client.disconnect();
    // Second launch: no approval needed.
    const again = new GatewayClient(id, { name: 'Laptop B', appVersion: '1.0.0' });
    const r2 = await again.connect(endpointFor(h));
    assert.equal(r2.phase, 'online');
    again.disconnect();
  } finally {
    await h.stop();
  }
});

test('security: forged credentials, spoofed ids and wrong certificates are rejected', async () => {
  const h = await startMaster();
  try {
    const { client, id } = await pairedClient(h);
    client.disconnect();

    // 1. Right device id, wrong private key.
    const thief = generateDeviceKeyPair();
    const c1 = new GatewayClient({ deviceId: id.deviceId, publicKey: id.publicKey, privateKey: thief.privateKey }, { name: 'x', appVersion: 't' });
    assert.equal(await codeOf(c1.connect(endpointFor(h))), 'device_unauthorized');

    // 2. Unknown device claiming an id that does not match its key.
    const k = generateDeviceKeyPair();
    const c2 = new GatewayClient({ deviceId: 'RVN-AAAA-BBBB-CCCC', publicKey: k.publicKey, privateKey: k.privateKey }, { name: 'x', appVersion: 't' });
    assert.equal(await codeOf(c2.connect(endpointFor(h, null))), 'device_unauthorized');

    // 3. Client pinned to a different certificate refuses the server.
    const c3 = new GatewayClient(id, { name: 'x', appVersion: 't' });
    assert.equal(await codeOf(c3.connect(endpointFor(h, 'ab'.repeat(32)))), 'server_unreachable');

    // 4. A signature made for a different TLS channel (relay attack) is refused.
    const ws = new WebSocket(`wss://127.0.0.1:${h.port}/raven/v1`, { rejectUnauthorized: false });
    const mux = new MuxSession({ send: (d, cb) => ws.send(d, cb), close: () => ws.close() }, 'client');
    ws.on('message', (d: Buffer) => mux.handleMessage(d));
    const denied = await new Promise<string>((resolve) => {
      mux.on('ctrl', (m: any) => {
        if (m.t === 'challenge') {
          const channel = `pin:${'cd'.repeat(32)}`;
          mux.sendCtrl({ t: 'auth', v: 1, deviceId: id.deviceId, publicKey: id.publicKey, name: 'x', appVersion: 't', channel, sig: signTranscript(id.privateKey, authTranscript(m.nonce, id.deviceId, channel)) });
        }
        if (m.t === 'denied') resolve(m.code);
      });
    });
    assert.equal(denied, 'device_unauthorized');
    ws.terminate();

    // 5. A replayed signature (old nonce) fails against a fresh challenge.
    const ws2 = new WebSocket(`wss://127.0.0.1:${h.port}/raven/v1`, { rejectUnauthorized: false });
    const mux2 = new MuxSession({ send: (d, cb) => ws2.send(d, cb), close: () => ws2.close() }, 'client');
    ws2.on('message', (d: Buffer) => mux2.handleMessage(d));
    const replay = await new Promise<string>((resolve) => {
      mux2.on('ctrl', (m: any) => {
        if (m.t === 'challenge') {
          const channel = `pin:${h.tls.fingerprint}`;
          mux2.sendCtrl({ t: 'auth', v: 1, deviceId: id.deviceId, publicKey: id.publicKey, name: 'x', appVersion: 't', channel, sig: signTranscript(id.privateKey, authTranscript('stale-nonce', id.deviceId, channel)) });
        }
        if (m.t === 'denied') resolve(m.code);
      });
    });
    assert.equal(replay, 'device_unauthorized');
    ws2.terminate();
    assert.ok(h.gateway.recentEvents().some((e) => e.level === 'security'));
  } finally {
    await h.stop();
  }
});

test('security: the gateway port is not an open proxy and survives malformed input', async () => {
  const h = await startMaster();
  try {
    // Plain HTTPS GET -> 404, never proxied.
    const status = await new Promise<number>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: h.port, path: 'http://example.com/', rejectUnauthorized: false }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
    });
    assert.equal(status, 404);

    // Proxy-style CONNECT over TLS is dropped.
    const connectResult = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: h.port, rejectUnauthorized: false }, () => {
        s.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      let got = '';
      s.on('data', (d) => (got += d.toString()));
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
      setTimeout(() => {
        s.destroy();
        resolve(got);
      }, 2000);
    });
    assert.ok(!connectResult.includes('200'), 'CONNECT must not be accepted');

    // Raw garbage on the TLS port.
    await new Promise<void>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: h.port }, () => {
        s.write(crypto.randomBytes(512));
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 200);
      });
      s.on('error', () => resolve());
    });

    // Unauthenticated WebSocket trying to open a stream and send junk frames.
    const ws = new WebSocket(`wss://127.0.0.1:${h.port}/raven/v1`, { rejectUnauthorized: false });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const mux = new MuxSession({ send: (d, cb) => ws.send(d, cb), close: () => ws.close() }, 'client');
    ws.on('message', (d: Buffer) => mux.handleMessage(d));
    assert.equal(await codeOf(mux.open({ kind: 'tcp', host: 'example.com', port: 443 }, 3000)), 'device_unauthorized');
    ws.send(Buffer.from([9, 9, 9]));
    ws.send(crypto.randomBytes(100));
    ws.send('text frame');
    await sleep(200);
    ws.terminate();

    // Wrong path is refused.
    const bad = new WebSocket(`wss://127.0.0.1:${h.port}/admin`, { rejectUnauthorized: false });
    const refused = await new Promise<boolean>((r) => {
      bad.on('open', () => r(false));
      bad.on('error', () => r(true));
    });
    assert.ok(refused);

    // Server is still healthy.
    const { client } = await pairedClient(h);
    assert.ok(client.online);
    client.disconnect();
  } finally {
    await h.stop();
  }
});

test('internet: HTTP, redirects, cookies, uploads, range requests and large downloads stream through the tunnel', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
  const { client } = await pairedClient(h);
  const proxy = await proxyThrough(client);
  try {
    const base = `http://127.0.0.1:${origin.port}`;
    const r1 = await proxyGet(proxy, `${base}/hello`, { headers: { Cookie: 'sid=abc' } });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.toString(), 'hello sid=abc');
    assert.ok(String(r1.headers['set-cookie']).includes('sid=abc'));

    const r2 = await proxyGet(proxy, `${base}/redirect`);
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.location, '/hello');

    // Missing proxy credential -> 407 (other local programs cannot use the proxy).
    const r3 = await proxyGet(proxy, `${base}/hello`, { auth: false });
    assert.equal(r3.status, 407);

    // Upload 6 MB.
    const up = crypto.randomBytes(6 * 1024 * 1024);
    const r4 = await proxyGet(proxy, `${base}/upload`, { method: 'POST', body: up });
    assert.equal(JSON.parse(r4.body.toString()).sha, crypto.createHash('sha256').update(up).digest('hex'));

    // Download 40 MB and verify every byte; memory must stay bounded (streamed, not buffered).
    const size = 40 * 1024 * 1024;
    const before = process.memoryUsage().rss;
    const sha = await new Promise<string>((resolve, reject) => {
      const hsh = crypto.createHash('sha256');
      let n = 0;
      const http = require('node:http') as typeof import('node:http');
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, path: `${base}/big?size=${size}`, headers: { Host: `127.0.0.1:${origin.port}`, 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') }, agent: false },
        (res) => {
          res.on('data', (c: Buffer) => {
            hsh.update(c);
            n += c.length;
          });
          res.on('end', () => (n === size ? resolve(hsh.digest('hex')) : reject(new Error(`short read ${n}`))));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(sha, expectedBigSha(size));
    const grew = process.memoryUsage().rss - before;
    assert.ok(grew < 150 * 1024 * 1024, `RSS grew ${Math.round(grew / 1e6)} MB during a 40 MB download`);

    // Range request (resumable downloads).
    const r5 = await proxyGet(proxy, `${base}/big?size=1000000`, { headers: { Range: 'bytes=500000-' } });
    assert.equal(r5.status, 206);
    assert.equal(r5.body.length, 500000);
    assert.equal(crypto.createHash('sha256').update(r5.body).digest('hex'), expectedBigSha(1000000, 500000));

    // CONNECT tunnel carries opaque bytes both ways (what HTTPS and WebSockets use).
    const t = await proxyConnect(proxy, `127.0.0.1:${origin.port}`);
    assert.equal(t.status, 200);
    t.socket.write(`GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    let raw = '';
    for await (const c of t.socket) raw += c.toString();
    assert.ok(raw.includes('hello nocookie'));

    // WebSocket upgrade through the tunnel (bidirectional).
    const w = await proxyConnect(proxy, `127.0.0.1:${origin.port}`);
    const key = crypto.randomBytes(16).toString('base64');
    w.socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const echoed = await new Promise<string>((resolve) => {
      let buf = '';
      let sent = false;
      w.socket.on('data', (d) => {
        buf += d.toString('latin1');
        if (!sent && buf.includes('\r\n\r\n')) {
          sent = true;
          assert.ok(buf.startsWith('HTTP/1.1 101'));
          buf = '';
          w.socket.write('ping-over-tunnel');
        } else if (sent && buf.includes('ping-over-tunnel')) resolve(buf);
      });
    });
    assert.equal(echoed, 'ping-over-tunnel');
    w.socket.destroy();

    // Usage counters moved.
    const view = h.gateway.listDevices()[0];
    assert.ok(view.totalDown > size, 'download bytes counted');
    assert.ok(view.totalUp > 6 * 1024 * 1024, 'upload bytes counted');
    // Nothing is left open on the master once the browser side is done.
    await waitFor(() => origin.openConnections === 0 && h.gateway.stats().streams === 0, 3000, 'tunnels to close');
  } finally {
    await proxy.close();
    client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('security: private, loopback, link-local and metadata destinations are refused', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  const { client } = await pairedClient(h);
  try {
    for (const [host, port] of [
      ['127.0.0.1', origin.port],
      ['127.0.0.1', h.port],
      ['localhost', origin.port],
      ['169.254.169.254', 80],
      ['10.0.0.1', 80],
      ['192.168.1.1', 80],
      ['[::1]', origin.port],
      ['::ffff:127.0.0.1', origin.port],
      ['0.0.0.0', origin.port],
      ['printer.local', 80],
    ] as [string, number][]) {
      assert.equal(await codeOf(client.openTcp(host, port)), 'blocked_destination', `${host}:${port}`);
    }
    assert.equal(await codeOf(client.openTcp('example.com', 25)), 'blocked_destination', 'SMTP port');
    assert.equal(await codeOf(client.openTcp('bad host name!', 80)), 'bad_request');
    assert.equal(await codeOf(client.openTcp('example.com', 70000)), 'bad_request');
    // Explicit owner allowlist opens exactly that target.
    h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
    const s = await client.openTcp('127.0.0.1', origin.port);
    s.destroy();
    assert.equal(await codeOf(client.openTcp('127.0.0.1', h.port)), 'blocked_destination', 'other ports stay blocked');
    assert.ok(h.gateway.recentEvents().some((e) => e.level === 'security' && e.msg.includes('Blocked')));
  } finally {
    client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('real internet: HTTPS to a public site through the tunnel keeps end-to-end TLS', async (t) => {
  const online = await new Promise<boolean>((r) => {
    const s = net.connect({ host: 'example.com', port: 443 });
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
    setTimeout(() => r(false), 5000);
  });
  if (!online) return t.skip('no internet on this machine');
  const h = await startMaster();
  const { client } = await pairedClient(h);
  const proxy = await proxyThrough(client);
  try {
    const c = await proxyConnect(proxy, 'example.com:443');
    assert.equal(c.status, 200);
    // TLS is negotiated by the client with example.com itself, with normal CA validation.
    const secure = tls.connect({ socket: c.socket, servername: 'example.com' });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    assert.ok(secure.authorized, 'certificate chain validated end-to-end');
    assert.ok(String(secure.getPeerCertificate().subjectaltname).includes('example'));
    secure.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    let body = '';
    for await (const d of secure) body += d.toString();
    assert.ok(body.startsWith('HTTP/1.1 200'));
    assert.ok(body.includes('Example Domain'));
    assert.equal(await codeOf(client.openTcp('this-host-does-not-exist.invalid', 443)), 'dns_failure');
  } finally {
    await proxy.close();
    client.disconnect();
    await h.stop();
  }
});

test('permissions: internet-only, AI-only and blocked devices are enforced independently and at the same time', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
  const a = await pairedClient(h, 'Laptop A');
  const b = await pairedClient(h, 'Laptop B');
  const c = await pairedClient(h, 'Laptop C');
  try {
    h.gateway.updateDevice(a.id.deviceId, { internet: true, ai: false });
    h.gateway.updateDevice(b.id.deviceId, { internet: false, ai: true, allowedModels: ['m3'] });
    h.gateway.updateDevice(c.id.deviceId, { internet: false, ai: false });
    await waitFor(() => c.client.state?.permissions.ai === false && b.client.state?.permissions.internet === false, 3000, 'state push');

    // A: internet only.
    const sa = await a.client.openTcp('127.0.0.1', origin.port);
    sa.destroy();
    assert.equal(await codeOf(a.client.openAi(ask())), 'ai_not_permitted');
    assert.deepEqual(a.client.state?.models, []);

    // B: AI only, over the same server connection, restricted to m3.
    assert.equal(await codeOf(b.client.openTcp('127.0.0.1', origin.port)), 'internet_not_permitted');
    const rb = await b.client.openAi(ask());
    assert.equal(rb.meta.model, 'm3');
    assert.equal(await collectAi(rb.stream), 'Hello from the model');
    assert.deepEqual(b.client.state?.models.map((m) => m.id), ['m3']);

    // C: nothing.
    assert.equal(await codeOf(c.client.openTcp('127.0.0.1', origin.port)), 'internet_not_permitted');
    assert.equal(await codeOf(c.client.openAi(ask())), 'ai_not_permitted');

    // Live change on an active device: no reconnect, open streams are cut.
    const live = await a.client.openTcp('127.0.0.1', origin.port);
    const cut = new Promise<string>((r) => live.once('error', (e: any) => r(e.code)));
    h.gateway.updateDevice(a.id.deviceId, { internet: false, ai: true });
    assert.equal(await cut, 'internet_not_permitted');
    assert.equal(await codeOf(a.client.openTcp('127.0.0.1', origin.port)), 'internet_not_permitted');
    const ra = await a.client.openAi(ask());
    assert.equal(await collectAi(ra.stream), 'Hello from the model');
    assert.ok(a.client.online, 'same session, never restarted');
  } finally {
    a.client.disconnect();
    b.client.disconnect();
    c.client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('model policy: a denied model is unreachable by name, by auto, by fallback or by a misbehaving router', async () => {
  const h = await startMaster();
  const { client, id } = await pairedClient(h);
  try {
    h.gateway.updateDevice(id.deviceId, { allowedModels: ['m1'] });
    await waitFor(() => client.state?.models.length === 1);

    assert.equal(await codeOf(client.openAi(ask('m2'))), 'model_not_permitted');
    assert.equal(await codeOf(client.openAi(ask('fusion'))), 'model_not_permitted', 'router aliases are not a way around the allowlist');
    assert.equal(await codeOf(client.openAi(ask('does-not-exist'))), 'model_unavailable');

    // "auto" is pinned to the permitted model; the backend never sees "auto".
    h.llm.requests.length = 0;
    const r = await client.openAi(ask('auto'));
    assert.equal(r.meta.model, 'm1');
    await collectAi(r.stream);
    assert.deepEqual(h.llm.requests.map((x) => x.model), ['m1']);

    // Permitted model rate-limited: must NOT fall back to m2/m3.
    h.llm.fail.set('m1', 429);
    h.llm.requests.length = 0;
    h.config.update({ models: { ...h.config.value.models, fallbacks: ['m2', 'm3'] } });
    assert.equal(await codeOf(client.openAi(ask('auto'))), 'provider_rate_limited');
    assert.ok(h.llm.requests.every((x) => x.model === 'm1'), `only m1 was ever requested: ${JSON.stringify(h.llm.requests)}`);
    h.llm.fail.clear();

    // Backend claims it served another model for a pinned request: response is discarded.
    h.llm.serveAs.set('m1', 'm2');
    assert.equal(await codeOf(client.openAi(ask('m1'))), 'model_not_permitted');
    h.llm.serveAs.clear();

    // Globally disabling the only permitted model leaves nothing.
    h.config.update({ models: { ...h.config.value.models, disabled: ['m1'] } });
    assert.equal(await codeOf(client.openAi(ask('auto'))), 'no_permitted_model');
    assert.equal(await codeOf(client.openAi(ask('m1'))), 'model_not_permitted');
    h.config.update({ models: { ...h.config.value.models, disabled: [], fallbacks: [] } });

    // Unrestricted device: the backend's own router is used and the served model is reported.
    h.gateway.updateDevice(id.deviceId, { allowedModels: null });
    h.llm.requests.length = 0;
    const r2 = await client.openAi(ask('auto'));
    assert.equal(r2.meta.model, 'm2');
    await collectAi(r2.stream);
    assert.deepEqual(h.llm.requests.map((x) => x.model), ['auto']);

    // With one model disabled globally, an unrestricted device no longer gets the free router.
    h.config.update({ models: { ...h.config.value.models, disabled: ['m2'] } });
    h.llm.requests.length = 0;
    const r3 = await client.openAi(ask('auto'));
    assert.notEqual(r3.meta.model, 'm2');
    await collectAi(r3.stream);
    assert.ok(!h.llm.requests.some((x) => x.model === 'auto' || x.model === 'm2'));

    // Authorized fallback: default fails, next permitted model serves.
    h.config.update({ models: { disabled: [], defaultModel: 'm1', codingModel: null, fallbacks: ['m3'], perMinute: {} } });
    h.llm.fail.set('m1', 503);
    const r4 = await client.openAi(ask('auto'));
    assert.equal(r4.meta.model, 'm3');
    await collectAi(r4.stream);
  } finally {
    client.disconnect();
    await h.stop();
  }
});

test('switches: internet OFF keeps AI, AI OFF keeps internet, master OFF releases the port and clients reconnect after ON', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
  const { client, id } = await pairedClient(h);
  try {
    // Internet gateway OFF.
    const live = await client.openTcp('127.0.0.1', origin.port);
    const cut = new Promise<string>((r) => live.once('error', (e: any) => r(e.code)));
    await h.gateway.setSwitches({ internet: false });
    assert.equal(await cut, 'internet_gateway_disabled');
    assert.equal(await codeOf(client.openTcp('127.0.0.1', origin.port)), 'internet_gateway_disabled');
    assert.equal(await collectAi((await client.openAi(ask())).stream), 'Hello from the model');
    await waitFor(() => client.state?.services.internet === false);

    // AI gateway OFF, internet back ON.
    await h.gateway.setSwitches({ internet: true, ai: false });
    assert.equal(await codeOf(client.openAi(ask())), 'ai_gateway_disabled');
    (await client.openTcp('127.0.0.1', origin.port)).destroy();
    await h.gateway.setSwitches({ ai: true });

    // Maintenance: no new requests.
    await h.gateway.setSwitches({ maintenance: true });
    assert.equal(await codeOf(client.openTcp('127.0.0.1', origin.port)), 'maintenance');
    assert.equal(await codeOf(client.openAi(ask())), 'maintenance');
    await h.gateway.setSwitches({ maintenance: false });

    // Master OFF: clean disconnect and the port is really closed.
    const closed = new Promise<void>((r) => client.once('close', () => r()));
    await h.gateway.setSwitches({ master: false });
    await closed;
    assert.equal(h.gateway.listening, false);
    const refused = await new Promise<boolean>((r) => {
      const s = net.connect({ host: '127.0.0.1', port: h.port });
      s.once('connect', () => {
        s.destroy();
        r(false);
      });
      s.once('error', () => r(true));
    });
    assert.ok(refused, 'nothing listens while the master switch is off');
    assert.equal(await codeOf(new GatewayClient(id, { name: 'x', appVersion: 't' }).connect(endpointFor(h), 2000)), 'server_unreachable');

    // Master ON: the same device reconnects with its stored credential.
    await h.gateway.setSwitches({ master: true });
    const again = new GatewayClient(id, { name: 'x', appVersion: 't' });
    assert.equal((await again.connect(endpointFor(h))).phase, 'online');
    (await again.openTcp('127.0.0.1', origin.port)).destroy();

    // Pairing OFF: strangers are turned away, known devices are fine.
    await h.gateway.setSwitches({ pairing: false });
    assert.equal(await codeOf(new GatewayClient(newIdentity(), { name: 'new', appVersion: 't' }).connect(endpointFor(h, null))), 'pairing_disabled');
    await h.gateway.setSwitches({ pairing: true });

    // LAN OFF: local sessions are dropped and refused.
    const dropped = new Promise<void>((r) => again.once('close', () => r()));
    await h.gateway.setSwitches({ lan: false });
    await dropped;
    assert.equal(await codeOf(new GatewayClient(id, { name: 'x', appVersion: 't' }).connect(endpointFor(h))), 'access_scope_disabled');
    await h.gateway.setSwitches({ lan: true });

    // Disconnect All keeps identities.
    await sleep(400);
    const c3 = new GatewayClient(id, { name: 'x', appVersion: 't' });
    await c3.connect(endpointFor(h));
    const gone = new Promise<void>((r) => c3.once('close', () => r()));
    assert.equal(h.gateway.disconnectAll(), 1);
    await gone;
    assert.equal(h.devices.get(id.deviceId)?.status, 'approved');
  } finally {
    client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('revocation, suspension and credential rotation', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
  const { client, id } = await pairedClient(h);
  try {
    // Suspend: session stays, everything is refused; resume restores without reconnecting.
    h.gateway.suspendDevice(id.deviceId, true);
    await waitFor(() => client.state?.deviceStatus === 'suspended');
    assert.equal(await codeOf(client.openTcp('127.0.0.1', origin.port)), 'device_suspended');
    assert.equal(await codeOf(client.openAi(ask())), 'device_suspended');
    h.gateway.suspendDevice(id.deviceId, false);
    await waitFor(() => client.state?.deviceStatus === 'approved');
    (await client.openTcp('127.0.0.1', origin.port)).destroy();

    // Rotation: new key works, old key is dead.
    const next = generateDeviceKeyPair();
    const transcript = Buffer.from(`raven-rotate-v1|${id.deviceId}|${next.publicKey}`, 'utf8');
    await client.rpc('rotate_key', { publicKey: next.publicKey, sigOld: signTranscript(id.privateKey, transcript), sigNew: signTranscript(next.privateKey, transcript) });
    client.disconnect();
    assert.equal(await codeOf(new GatewayClient(id, { name: 'x', appVersion: 't' }).connect(endpointFor(h))), 'device_unauthorized');
    const rotated = { deviceId: id.deviceId, publicKey: next.publicKey, privateKey: next.privateKey };
    const c2 = new GatewayClient(rotated, { name: 'x', appVersion: 't' });
    assert.equal((await c2.connect(endpointFor(h))).phase, 'online');

    // Revoke an active device: sessions die, the credential never works again.
    const live = await c2.openTcp('127.0.0.1', origin.port);
    const streamDead = new Promise<void>((r) => live.once('close', () => r()));
    const closed = new Promise<void>((r) => c2.once('close', () => r()));
    h.gateway.revokeDevice(id.deviceId);
    await closed;
    await streamDead;
    assert.equal(c2.lastDenied, 'device_revoked');
    assert.equal(await codeOf(new GatewayClient(rotated, { name: 'x', appVersion: 't' }).connect(endpointFor(h))), 'device_revoked');
    // Even after the record is deleted the tombstoned key cannot pair again.
    h.gateway.removeDevice(id.deviceId);
    assert.equal(await codeOf(new GatewayClient(rotated, { name: 'x', appVersion: 't' }).connect(endpointFor(h, null))), 'device_unauthorized');
    const fresh = { deviceId: require('@raven/security').deviceIdFromPublicKey(next.publicKey), publicKey: next.publicKey, privateKey: next.privateKey };
    assert.equal(await codeOf(new GatewayClient(fresh, { name: 'x', appVersion: 't' }).connect(endpointFor(h, null))), 'device_revoked');
    assert.equal(await codeOf(new GatewayClient(id, { name: 'x', appVersion: 't' }).connect(endpointFor(h, null))), 'device_revoked', 'rotated-away key is tombstoned too');
  } finally {
    client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('limits: AI request rates, concurrency, payload size, connection count and bandwidth are enforced by the server', async () => {
  const h = await startMaster();
  const origin = new Origin();
  await origin.start();
  h.config.update({ lanAllowlist: [`127.0.0.1:${origin.port}`] });
  const { client, id } = await pairedClient(h);
  try {
    h.gateway.updateDevice(id.deviceId, { limits: { ...DEFAULT_LIMITS, aiPerMinute: 3, aiConcurrent: 1, maxPayloadBytes: 2048, maxConnections: 2, maxOutputTokens: 256 } });

    assert.equal(await codeOf(client.openAi({ ...ask(), messages: [{ role: 'user', content: 'x'.repeat(5000) }] })), 'payload_too_large');
    assert.equal(await codeOf(client.openAi({ messages: [{ role: 'hacker', content: 'x' }] } as any)), 'bad_request');

    // Concurrency: second generation refused while the first is streaming; cancel works.
    h.llm.chunkDelayMs = 150;
    const first = await client.openAi(ask());
    assert.equal(await codeOf(client.openAi(ask())), 'too_many_connections');
    first.stream.destroy(); // Stop generation
    h.llm.chunkDelayMs = 0;
    await sleep(300);
    assert.equal(h.gateway.stats().aiActive, 0, 'cancelled generation is released');

    // Output-token cap is applied server-side.
    const r = await client.openAi({ ...ask(), maxTokens: 9999 });
    await collectAi(r.stream);
    assert.equal(h.llm.requests.at(-1)?.maxTokens, 256);

    // Per-minute limit of 3: the cancelled one, the capped one and one more. Refused requests are not counted.
    await collectAi((await client.openAi(ask())).stream);
    assert.equal(await codeOf(client.openAi(ask())), 'rate_limited');
    assert.equal(h.gateway.listDevices()[0].aiUsage.minute, 3);

    // Connection limit.
    const s1 = await client.openTcp('127.0.0.1', origin.port);
    const s2 = await client.openTcp('127.0.0.1', origin.port);
    assert.equal(await codeOf(client.openTcp('127.0.0.1', origin.port)), 'too_many_connections');
    s1.destroy();
    s2.destroy();
    await sleep(100);

    // Bandwidth: 600 KB at 200 KB/s (64 KB burst) must take roughly 2.5 s or more.
    h.gateway.updateDevice(id.deviceId, { limits: { ...DEFAULT_LIMITS, bandwidthBps: 200 * 1024 } });
    const proxy = await proxyThrough(client);
    const t0 = Date.now();
    const res = await proxyGet(proxy, `http://127.0.0.1:${origin.port}/big?size=${600 * 1024}`);
    const took = Date.now() - t0;
    await proxy.close();
    assert.equal(res.body.length, 600 * 1024);
    assert.ok(took >= 2000, `throttled download finished in ${took} ms`);
  } finally {
    client.disconnect();
    await origin.stop();
    await h.stop();
  }
});

test('unified key change and backend outage: AI recovers without touching any client', async () => {
  const h = await startMaster();
  const { client } = await pairedClient(h);
  try {
    assert.equal(await collectAi((await client.openAi(ask())).stream), 'Hello from the model');

    // FreeLLMAPI key regenerated upstream: old key now rejected.
    h.llm.key = 'unified-key-2';
    await h.ai.refresh();
    assert.equal(h.ai.health, 'down');
    assert.equal(await codeOf(client.openAi(ask())), 'ai_backend_unreachable');
    await waitFor(() => client.state?.aiBackend === 'down');

    // Owner enters the new key on the master only.
    h.backend = { baseUrl: h.llm.baseUrl, apiKey: 'unified-key-2' };
    await h.ai.refresh();
    assert.equal(h.ai.health, 'ok');
    await waitFor(() => client.state?.aiBackend === 'ok');
    const r = await client.openAi(ask());
    assert.equal(await collectAi(r.stream), 'Hello from the model');
    assert.equal(h.llm.requests.at(-1)?.auth, 'Bearer unified-key-2');
    assert.ok(client.online, 'client was never restarted or reconfigured');
    // The key never appears in anything the client received.
    assert.ok(!JSON.stringify(client.state).includes('unified-key'));

    // FreeLLMAPI process dies and comes back.
    h.llm.down = true;
    await h.ai.refresh();
    assert.equal(await codeOf(client.openAi(ask())), 'ai_backend_unreachable');
    h.llm.down = false;
    await h.ai.refresh();
    assert.equal(await collectAi((await client.openAi(ask())).stream), 'Hello from the model');

    // All providers failing -> clear structured error.
    for (const m of ['m1', 'm2', 'm3', 'auto']) h.llm.fail.set(m, 503);
    assert.equal(await codeOf(client.openAi(ask())), 'providers_unavailable');
  } finally {
    client.disconnect();
    await h.stop();
  }
});

test('persistence: devices, permissions, model rules, quotas, usage and switches survive a master restart', async () => {
  let h = await startMaster();
  const { client, id } = await pairedClient(h, 'Persistent PC');
  const other = await pairedClient(h, 'To be revoked');
  try {
    h.gateway.updateDevice(id.deviceId, { name: 'Renamed PC', internet: false, ai: true, allowedModels: ['m2'], defaultModel: 'm2', limits: { ...DEFAULT_LIMITS, aiPerDay: 7, bandwidthBps: 12345 } });
    h.gateway.revokeDevice(other.id.deviceId);
    await h.gateway.setSwitches({ internet: false, pairing: false });
    h.config.update({ models: { disabled: ['m3'], defaultModel: 'm1', codingModel: null, fallbacks: ['m2'], perMinute: { m1: 5 } }, drainPolicy: 'finish' });
    await collectAi((await client.openAi(ask())).stream);
    client.disconnect();

    h = await h.restart();
    const d = h.devices.get(id.deviceId)!;
    assert.equal(d.name, 'Renamed PC');
    assert.equal(d.status, 'approved');
    assert.equal(d.internet, false);
    assert.equal(d.ai, true);
    assert.deepEqual(d.allowedModels, ['m2']);
    assert.equal(d.defaultModel, 'm2');
    assert.equal(d.limits.aiPerDay, 7);
    assert.equal(d.limits.bandwidthBps, 12345);
    assert.equal(d.aiRequests, 1);
    assert.equal(h.devices.get(other.id.deviceId)?.status, 'revoked');
    assert.equal(h.gateway.switches.internet, false);
    assert.equal(h.gateway.switches.pairing, false);
    assert.deepEqual(h.config.value.models.disabled, ['m3']);
    assert.equal(h.config.value.models.perMinute.m1, 5);
    assert.equal(h.config.value.drainPolicy, 'finish');
    assert.equal(h.gateway.listDevices().find((x) => x.id === id.deviceId)?.aiUsage.day, 1, 'usage window restored');
    assert.equal(h.tls.fingerprint.length, 64);

    // Same certificate after restart -> stored pin still valid, no re-pairing.
    const c2 = new GatewayClient(id, { name: 'x', appVersion: 't' });
    assert.equal((await c2.connect(endpointFor(h))).phase, 'online');
    assert.equal(c2.state?.permissions.internet, false);
    c2.disconnect();
    assert.equal(await codeOf(new GatewayClient(other.id, { name: 'x', appVersion: 't' }).connect(endpointFor(h))), 'device_revoked');
  } finally {
    await h.stop();
  }
});
