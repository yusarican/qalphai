import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerInit, WorkerJob, WorkerResult } from './protocol';
import type { RecordedDecision } from '../../engine/simulator';

/**
 * Sandbox worker havuzu — IZOLASYON ve PARALELLIK ayni mekanizma.
 *
 * Strateji zaten ayri bir thread'de kosmak ZORUNDA (sonsuz dongusunu ancak
 * worker.terminate() durdurabilir). Ayni worker'lari grid'in RECORD boyutunu
 * paralellestirmek icin de kullaniyoruz — yani guvenlik icin odedigimiz bedel,
 * bize hizi bedava veriyor.
 */

export interface PoolOptions {
  /** Bir hucrenin (tum karar noktalari) tamamlanmasi icin tanınan sure. */
  timeoutMs?: number;
  workers?: number;
}

/**
 * Worker dosyasi ve nasil yuklenecegi.
 *
 * Dev/test'te bu modul .ts olarak kosar (tsx); derlenmis kurulumda .js olarak (dist/).
 * __filename'in uzantisina bakarak dogru kardesi seciyoruz. .ts durumunda worker
 * thread'in KENDI tsx kaydini yapmasi gerekir — ana surecin kaydi worker'a mirasla
 * gecmez. Proje CommonJS oldugu icin dogru kayit `--require tsx/cjs`; `--import tsx`
 * (ESM yolu) uzantisiz relative import'lari cozemiyor.
 */
const IS_TS = __filename.endsWith('.ts');
const WORKER_FILE = path.join(__dirname, IS_TS ? 'worker.ts' : 'worker.js');
const WORKER_EXEC_ARGV = IS_TS ? ['--require', 'tsx/cjs'] : [];

export class SandboxPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{
    job: WorkerJob;
    resolve: (d: RecordedDecision[]) => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly busy = new Map<Worker, { timer: NodeJS.Timeout; reject: (e: Error) => void; cellIndex: number }>();
  private closed = false;

  private constructor(
    private readonly init: WorkerInit,
    private readonly timeoutMs: number,
  ) {}

  static create(init: WorkerInit, opts: PoolOptions = {}): SandboxPool {
    const pool = new SandboxPool(init, opts.timeoutMs ?? 120_000);
    const n = Math.max(1, opts.workers ?? Math.min(os.cpus().length - 1, 8));
    for (let i = 0; i < n; i++) pool.spawn();
    return pool;
  }

  get size(): number {
    return this.workers.length;
  }

  private spawn(): Worker {
    const w = new Worker(WORKER_FILE, {
      workerData: this.init,
      execArgv: WORKER_EXEC_ARGV,
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        codeRangeSizeMb: 32,
      },
    });

    w.on('message', (res: WorkerResult) => this.onMessage(w, res));
    w.on('error', (err) => this.onFatal(w, err));
    w.on('exit', (code) => {
      if (!this.closed && code !== 0) this.onFatal(w, new Error(`worker cikti (kod ${code})`));
    });

    this.workers.push(w);
    this.idle.push(w);
    return w;
  }

  /** Bir strateji parametre hucresi icin RECORD pass'i kosar. */
  run(job: WorkerJob): Promise<RecordedDecision[]> {
    if (this.closed) return Promise.reject(new Error('havuz kapali'));
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;

      /**
       * Sonsuz dongu / patolojik yavaslik: vm ICINDEN kesilemez, cunku ayni thread'de
       * calisan bir dongu bizim timeout kodumuza sira vermez. Tek cikis worker'i
       * OLDURMEK. Bu yuzden strateji ayri thread'de.
       */
      const timer = setTimeout(() => {
        this.busy.delete(w);
        void w.terminate();
        this.drop(w);
        this.spawn(); // havuzu yeniden doldur
        item.reject(
          new Error(
            `strateji hucre ${item.job.cellIndex} icin ${this.timeoutMs}ms icinde bitmedi — worker oldurulду`,
          ),
        );
        this.pump();
      }, this.timeoutMs);

      this.busy.set(w, { timer, reject: item.reject, cellIndex: item.job.cellIndex });

      // resolve'u mesaj geldiginde cagirabilmek icin worker'a ilistir.
      pending.set(w, item.resolve);
      w.postMessage(item.job);
    }
  }

  private onMessage(w: Worker, res: WorkerResult): void {
    const b = this.busy.get(w);
    if (!b) return; // timeout'a dusmus, sonuc artik gecersiz
    clearTimeout(b.timer);
    this.busy.delete(w);

    const resolve = pending.get(w);
    pending.delete(w);

    this.idle.push(w);

    if (res.ok) resolve?.(res.decisions);
    else b.reject(new Error(`strateji hatasi (hucre ${res.cellIndex}): ${res.error}`));

    this.pump();
  }

  private onFatal(w: Worker, err: Error): void {
    const b = this.busy.get(w);
    if (b) {
      clearTimeout(b.timer);
      this.busy.delete(w);
      b.reject(err);
    }
    pending.delete(w);
    this.drop(w);
    if (!this.closed) {
      this.spawn();
      this.pump();
    }
  }

  private drop(w: Worker): void {
    const i = this.workers.indexOf(w);
    if (i >= 0) this.workers.splice(i, 1);
    const j = this.idle.indexOf(w);
    if (j >= 0) this.idle.splice(j, 1);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const b of this.busy.values()) clearTimeout(b.timer);
    this.busy.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

const pending = new WeakMap<Worker, (d: RecordedDecision[]) => void>();
