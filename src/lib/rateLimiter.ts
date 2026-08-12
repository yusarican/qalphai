/**
 * Binance USDⓈ-M icin agirlik (weight) farkindali istek sinirlayici.
 *
 * Sample'da bunun yerine "her sayfada setTimeout(100)" vardi ve 429/418 hic ele
 * alinmiyordu (binanceHistorical.ts:70). Gece dongusu artik gunde binlerce sayfa
 * cekecegi icin bu yeterli degil: 418 = IP bani ve bani uzatmadan durmak gerekir.
 */

export interface RateLimiterOptions {
  /** Dakika basina agirlik butcesi. Binance fapi: 2400. Guvenlik payiyla dusuk tutulur. */
  weightPerMinute: number;
  /** Es zamanli istek tavani. */
  maxConcurrent: number;
}

export class BinanceBanError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Binance IP bani (418). ${Math.round(retryAfterMs / 1000)}sn sonra tekrar denenebilir.`);
    this.name = 'BinanceBanError';
  }
}

const MINUTE_MS = 60_000;

export class RateLimiter {
  private used = 0;
  private windowStart = Date.now();
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  /** 429/418 sonrasi bu ana kadar hicbir istek gonderilmez. */
  private pausedUntil = 0;

  constructor(private readonly opts: RateLimiterOptions) {}

  /**
   * Cagriyi butce icinde calistirir. `weight` istegin Binance agirligi
   * (klines limit=1500 -> 10, fundingRate -> 1).
   */
  async run<T>(weight: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(weight);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Yanit header'indan gercek kullanimi ogren. Binance'in sayaci bizimkinden
   * daha dogrudur (ayni IP'den baska sureclerde istek atiyor olabilir).
   */
  observeUsedWeight(headerValue: string | undefined): void {
    if (!headerValue) return;
    const n = Number(headerValue);
    if (Number.isFinite(n) && n > this.used) this.used = n;
  }

  /** 429 geldiginde: butun kuyrugu bu sure boyunca dondur. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  private async acquire(weight: number): Promise<void> {
    for (;;) {
      const now = Date.now();

      if (now - this.windowStart >= MINUTE_MS) {
        this.windowStart = now;
        this.used = 0;
      }

      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }

      const budgetLeft = this.opts.weightPerMinute - this.used;
      const slotFree = this.inFlight < this.opts.maxConcurrent;

      if (slotFree && budgetLeft >= weight) {
        this.used += weight;
        this.inFlight++;
        return;
      }

      if (!slotFree) {
        await this.waitForSlot();
        continue;
      }

      // Butce bitti: pencerenin donmesini bekle.
      await sleep(this.windowStart + MINUTE_MS - now + 50);
    }
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => this.queue.push(resolve));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Jitter'li ustel geri cekilme: 1s, 2s, 4s, 8s, 16s (+/- %25). */
export function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}
