// Joining the master's Raven Wi-Fi from a computer that has no network of its own.
// Windows: finds the Wi-Fi adapter, turns the Wi-Fi radio on if it is off (no admin needed), saves the network with
// auto-connect (so Windows rejoins it by itself after restarts) and connects. Enabling an adapter that is disabled
// in Windows needs one admin approval; that is only done when the person presses the button.
// macOS: networksetup turns Wi-Fi on and joins.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests of unpackaged builds never touch this computer's real Wi-Fi.
const FAKE = process.env.RAVEN_FAKE_WIFI === '1' && !!(process as any).defaultApp;

export type WifiLinkState = 'idle' | 'joining' | 'joined' | 'wifi-off' | 'adapter-disabled' | 'no-adapter' | 'not-found' | 'error';

function run(cmd: string, args: string[], env: Record<string, string> = {}, timeout = 45_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` }),
    );
  });
}

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function Out-Result($o) { Write-Output ('RESULT ' + ($o | ConvertTo-Json -Compress)) }
$ad = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 -or $_.InterfaceDescription -match 'Wireless|Wi-Fi|WiFi|802\\.11|WLAN' } | Where-Object { $_.Status -ne 'Not Present' } | Sort-Object { switch ($_.Status) { 'Up' { 0 } 'Disconnected' { 1 } default { 2 } } } | Select-Object -First 1
`;

async function ps(body: string, env: Record<string, string> = {}): Promise<any> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PRELUDE + body], env);
  const m = /RESULT (\{.*\})/.exec(r.out);
  if (!m) return { state: 'error', error: r.out.trim().split('\n').pop()?.slice(0, 200) || 'No answer from Windows.' };
  try {
    return JSON.parse(m[1]);
  } catch {
    return { state: 'error', error: 'Unreadable answer from Windows.' };
  }
}

function profileXml(ssid: string, passphrase: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${esc(ssid)}</name>
  <SSIDConfig><SSID><name>${esc(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${esc(passphrase)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
}

/** Make this computer join the master's network. Returns the resulting state. */
export async function joinRavenWifi(ssid: string, passphrase: string): Promise<{ state: WifiLinkState; error?: string }> {
  if (FAKE) return { state: 'not-found', error: 'Raven Wi-Fi is not in range. Is the master on and Raven Wi-Fi switched on?' };
  if (process.platform === 'darwin') {
    const dev = (await run('networksetup', ['-listallhardwareports'])).out.match(/Hardware Port: Wi-Fi\s+Device: (\S+)/)?.[1] ?? 'en0';
    await run('networksetup', ['-setairportpower', dev, 'on']);
    const r = await run('networksetup', ['-setairportnetwork', dev, ssid, passphrase]);
    return r.code === 0 && !/Could not|Failed/i.test(r.out) ? { state: 'joined' } : { state: /not find/i.test(r.out) ? 'not-found' : 'error', error: r.out.trim().slice(0, 200) };
  }
  if (process.platform !== 'win32') return { state: 'error', error: 'Joining Raven Wi-Fi automatically works on Windows and Mac.' };

  // 1. Adapter present and enabled? Radio on?
  const st = await ps(`
if (-not $ad) { Out-Result @{ state = 'no-adapter' }; exit }
if ($ad.Status -eq 'Disabled') { Out-Result @{ state = 'adapter-disabled' }; exit }
$radios = Await ([Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$wifi = $radios | Where-Object { "$($_.Kind)" -eq 'WiFi' } | Select-Object -First 1
if ($wifi -and "$($wifi.State)" -ne 'On') {
  $access = Await ([Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
  $res = Await ($wifi.SetStateAsync([Windows.Devices.Radios.RadioState]::On)) ([Windows.Devices.Radios.RadioAccessStatus])
  Start-Sleep -Seconds 3
}
Out-Result @{ state = 'ready'; name = $ad.Name }
`);
  if (st.state !== 'ready') return { state: st.state, error: st.error };
  const iface = String(st.name || 'Wi-Fi');

  // 2. Save the network (auto-connect) and connect.
  const file = path.join(os.tmpdir(), `raven-wifi-${process.pid}.xml`);
  fs.writeFileSync(file, profileXml(ssid, passphrase), { mode: 0o600 });
  try {
    await run('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current']);
  } finally {
    fs.rmSync(file, { force: true });
  }
  // Only switch networks when Raven Wi-Fi is actually in range (never drop the current network for nothing).
  const seen = (await run('netsh', ['wlan', 'show', 'networks', `interface=${iface}`])).out;
  if (!seen.split(/\r?\n/).some((l) => /^\s*SSID \d+\s*:\s*(.*)$/.exec(l)?.[1]?.trim() === ssid)) {
    return { state: 'not-found', error: 'Raven Wi-Fi is not in range. Is the master on and Raven Wi-Fi switched on?' };
  }
  const c = await run('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`, `interface=${iface}`]);
  if (c.code !== 0 && /not available|cannot be found|not found/i.test(c.out)) return { state: 'not-found', error: 'Raven Wi-Fi is not in range. Is the master on and Raven Wi-Fi switched on?' };

  // 3. Wait for the connection.
  for (let i = 0; i < 20; i++) {
    const s = (await run('netsh', ['wlan', 'show', 'interfaces'])).out;
    if (new RegExp(`^\\s*SSID\\s*:\\s*${ssid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(s) && /^\s*State\s*:\s*connected/im.test(s)) return { state: 'joined' };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { state: 'not-found', error: 'Could not join Raven Wi-Fi. Is the master on and in range?' };
}

/** The Wi-Fi network this computer is on now (null if none). */
export async function currentSsid(): Promise<string | null> {
  if (FAKE) return null;
  if (process.platform === 'darwin') {
    const r = await run('networksetup', ['-getairportnetwork', 'en0']);
    return /Current Wi-Fi Network: (.+)/.exec(r.out)?.[1]?.trim() ?? null;
  }
  if (process.platform !== 'win32') return null;
  const s = (await run('netsh', ['wlan', 'show', 'interfaces'])).out;
  return /^\s*State\s*:\s*connected/im.test(s) ? /^\s*SSID\s*:\s*(.+)$/m.exec(s)?.[1]?.trim() ?? null : null;
}

/** Turn on a Wi-Fi adapter that is disabled in Windows. Windows asks the person for permission (admin). */
export async function enableAdapterWithPermission(): Promise<boolean> {
  if (FAKE) return false;
  if (process.platform !== 'win32') return false;
  const inner = "Get-NetAdapter | Where-Object { $_.NdisPhysicalMedium -eq 9 -or $_.InterfaceDescription -match 'Wireless|Wi-Fi|WiFi|802\\.11|WLAN' } | Enable-NetAdapter -Confirm:$false";
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner.replace(/"/g, '`"')}"`],
    {},
    120_000,
  );
  return r.code === 0;
}
