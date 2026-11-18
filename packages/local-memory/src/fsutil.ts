// Ordinary-file persistence helpers: atomic small-file writes, append-safe
// JSONL logs with serialized writers, and tolerant readers that survive a
// crash in the middle of a write. No database of any kind.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

let tmpSeq = 0;

/** Write-to-temp, fsync, rename: readers never observe a half-written file. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // Windows can refuse a rename while another process (antivirus, indexer)
    // briefly holds the target; retry a few times before giving up.
    let lastErr = err;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    await fsp.rm(tmp, { force: true });
    throw lastErr;
  }
}

export function atomicWriteSync(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Read JSON; on a missing or corrupt file return the fallback (corrupt files are kept aside, never deleted). */
export function readJsonSync<T>(file: string, fallback: T, validate?: (v: unknown) => v is T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''));
    if (validate && !validate(v)) throw new Error('schema');
    return v as T;
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* leave it */
    }
    return fallback;
  }
}

/** Serializes async jobs per key so two writers never interleave on one file. */
export class WriteQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const guarded = next.catch(() => undefined);
    this.tails.set(key, guarded);
    void guarded.then(() => {
      if (this.tails.get(key) === guarded) this.tails.delete(key);
    });
    return next;
  }
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()]);
  }
}

const queue = new WriteQueue();

/** Append one JSON record as a single line. A torn final line from a crash is repaired first. */
export function appendJsonl(file: string, record: unknown): Promise<void> {
  return queue.run(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify(record) + '\n';
    let needsNewline = false;
    try {
      const st = await fsp.stat(file);
      if (st.size > 0) {
        const fh = await fsp.open(file, 'r');
        try {
          const b = Buffer.alloc(1);
          await fh.read(b, 0, 1, st.size - 1);
          needsNewline = b[0] !== 0x0a;
        } finally {
          await fh.close();
        }
      }
    } catch {
      /* new file */
    }
    await fsp.appendFile(file, (needsNewline ? '\n' : '') + line, 'utf8');
  });
}

export function queuedWrite(file: string, data: string | Buffer): Promise<void> {
  return queue.run(file, () => atomicWrite(file, data));
}

export function flushWrites(): Promise<void> {
  return queue.idle();
}

/** Stream a JSONL file line by line; malformed lines are counted and skipped. */
export async function readJsonl<T>(
  file: string,
  onRecord: (rec: T, lineNo: number) => void | false,
): Promise<{ records: number; bad: number }> {
  let records = 0;
  let bad = 0;
  if (!fs.existsSync(file)) return { records, bad };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    let rec: T;
    try {
      rec = JSON.parse(line) as T;
    } catch {
      bad++;
      continue;
    }
    records++;
    if (onRecord(rec, n) === false) {
      rl.close();
      break;
    }
  }
  return { records, bad };
}

/** Rewrite a JSONL file keeping only records the predicate accepts. */
export function rewriteJsonl<T>(file: string, keep: (rec: T) => boolean): Promise<number> {
  return queue.run(file, async () => {
    if (!fs.existsSync(file)) return 0;
    const out: string[] = [];
    let removed = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as T;
        if (keep(rec)) out.push(line);
        else removed++;
      } catch {
        removed++;
      }
    }
    if (out.length === 0) await fsp.rm(file, { force: true });
    else await atomicWrite(file, out.join('\n') + '\n');
    return removed;
  });
}

export function isWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.raven-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dir: string, ext?: string): Promise<string[]> {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => !ext || n.endsWith(ext)).sort();
  } catch {
    return [];
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await fsp.stat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}
