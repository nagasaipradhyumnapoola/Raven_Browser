// Raven Wi-Fi on a Windows master: Windows Mobile Hotspot, started and kept on by Raven with the network name and
// password derived from the link code (see packages/security/src/link.ts). Uses the built-in WinRT tethering API
// through PowerShell: no driver, no admin rights.
import { execFile } from 'node:child_process';

export interface HotspotStatus {
  state: 'off' | 'starting' | 'on' | 'unsupported' | 'error';
  ssid: string | null;
  clients: number;
  error: string | null;
}

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAction($a) { $task = $asTaskAct.Invoke($null, @($a)); $task.Wait(-1) | Out-Null }
$profile = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile()
if (-not $profile) { Write-Output 'RESULT {"state":"error","error":"This computer has no internet connection to share yet."}'; exit }
$tmType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
$cap = $tmType::GetTetheringCapabilityFromConnectionProfile($profile)
if ("$cap" -ne 'Enabled') { Write-Output ('RESULT {"state":"unsupported","error":"Windows does not allow a Mobile Hotspot on this connection (' + $cap + ')."}'); exit }
$tm = $tmType::CreateFromConnectionProfile($profile)
`;

function runPs(body: string, env: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + body],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } },
      (err, stdout) => {
        const m = /RESULT (\{.*\})/.exec(String(stdout));
        if (m) {
          try {
            return resolve(JSON.parse(m[1]));
          } catch {
            /* fall through */
          }
        }
        resolve({ state: 'error', error: err ? String(err.message).split('\n')[0].slice(0, 200) : 'No answer from Windows.' });
      },
    );
  });
}

export class Hotspot {
  status: HotspotStatus = { state: 'off', ssid: null, clients: 0, error: null };
  private timer: NodeJS.Timeout | null = null;
  private want: { ssid: string; passphrase: string } | null = null;
  private busy = false;
  /** Raven turned off Windows' "stop the hotspot after 5 minutes with no devices"; put it back when done. */
  private restoreTimeout = false;
  /** Times Windows switched the hotspot off on its own (each restart drops this PC's Wi-Fi for a few seconds). */
  private restarts: number[] = [];

  constructor(private onChange: () => void) {}

  get supported(): boolean {
    return process.platform === 'win32';
  }

  private set(s: Partial<HotspotStatus>): void {
    this.status = { ...this.status, ...s };
    this.onChange();
  }

  /** Keep Raven Wi-Fi on with this name and password (re-started if Windows turns it off). */
  async enable(ssid: string, passphrase: string): Promise<void> {
    if (!this.supported) return this.set({ state: 'unsupported', ssid: null, error: 'Raven Wi-Fi needs a Windows master. On this device, turn on its own hotspot instead.' });
    if (this.timer && this.want?.ssid === ssid && this.want.passphrase === passphrase) return; // already being kept on
    this.want = { ssid, passphrase };
    await this.check();
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), 45_000);
      this.timer.unref?.();
    }
  }

  async disable(): Promise<void> {
    this.want = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.restarts = [];
    if (!this.supported || (this.status.state === 'off' && !this.restoreTimeout)) return this.set({ state: 'off', clients: 0, error: null });
    const restore = this.restoreTimeout;
    this.restoreTimeout = false;
    await runPs(`
if ("$($tm.TetheringOperationalState)" -ne 'Off') { AwaitAction ($tm.StopTetheringAsync()) }
if ($env:RAVEN_RESTORE -eq '1') { try { AwaitAction ($tmType::EnableNoConnectionsTimeoutAsync()) } catch {} }
Write-Output 'RESULT {"state":"off"}'
`, { RAVEN_RESTORE: restore ? '1' : '0' }).catch(() => {});
    this.set({ state: 'off', clients: 0, error: null });
  }

  private async check(): Promise<void> {
    if (!this.want || this.busy) return;
    // Windows turned it off by itself too often: stop restarting (every restart drops this PC's Wi-Fi briefly).
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 30 * 60_000);
    if (this.restarts.length >= 3) {
      if (this.status.state !== 'error') this.set({ state: 'error', clients: 0, error: 'Windows keeps switching Raven Wi-Fi off, so Raven stopped restarting it (each restart briefly drops this computer’s Wi-Fi). Turn it off and on again to retry.' });
      return;
    }
    this.busy = true;
    if (this.status.state !== 'on') this.set({ state: 'starting', ssid: this.want.ssid, error: null });
    try {
      const r = await runPs(
        `
# Windows stops a hotspot after 5 minutes with no devices; restarting it drops this PC's Wi-Fi. Keep it from stopping.
$timeoutChanged = 0
try { if ($tmType::IsNoConnectionsTimeoutEnabled()) { AwaitAction ($tmType::DisableNoConnectionsTimeoutAsync()); $timeoutChanged = 1 } } catch {}
$wasOn = [int]("$($tm.TetheringOperationalState)" -eq 'On')
$cfg = $tm.GetCurrentAccessPointConfiguration()
if ($cfg.Ssid -ne $env:RAVEN_SSID -or $cfg.Passphrase -ne $env:RAVEN_PASS) {
  if ("$($tm.TetheringOperationalState)" -eq 'On') { AwaitAction ($tm.StopTetheringAsync()) }
  $cfg.Ssid = $env:RAVEN_SSID
  $cfg.Passphrase = $env:RAVEN_PASS
  AwaitAction ($tm.ConfigureAccessPointAsync($cfg))
}
if ("$($tm.TetheringOperationalState)" -ne 'On') {
  $res = Await ($tm.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ("$($res.Status)" -ne 'Success') { Write-Output ('RESULT {"state":"error","error":"Windows could not start the hotspot (' + $res.Status + ').' + '"}'); exit }
}
Write-Output ('RESULT {"state":"on","clients":' + $tm.ClientCount + ',"wasOn":' + $wasOn + ',"timeoutChanged":' + $timeoutChanged + '}')
`,
        { RAVEN_SSID: this.want.ssid, RAVEN_PASS: this.want.passphrase },
      );
      if (!this.want) return;
      if (r.timeoutChanged === 1) this.restoreTimeout = true;
      // It was on before and Windows had turned it off: count that restart.
      if (r.state === 'on' && r.wasOn === 0 && this.status.state === 'on') this.restarts.push(Date.now());
      this.set({ state: r.state ?? 'error', clients: Number(r.clients ?? 0), error: r.error ?? null, ssid: this.want.ssid });
    } finally {
      this.busy = false;
    }
  }
}

/** Test stand-in: behaves like a working hotspot without touching the real Wi-Fi. */
export class FakeHotspot {
  status: HotspotStatus = { state: 'off', ssid: null, clients: 0, error: null };
  constructor(private onChange: () => void) {}
  async enable(ssid: string, _passphrase: string): Promise<void> {
    this.status = { state: 'on', ssid, clients: 0, error: null };
    this.onChange();
  }
  async disable(): Promise<void> {
    this.status = { state: 'off', ssid: null, clients: 0, error: null };
    this.onChange();
  }
}
