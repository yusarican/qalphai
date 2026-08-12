import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { env } from '../config/env';
import { BinanceBanError, RateLimiter, backoffMs, sleep } from '../lib/rateLimiter';

/**
 * Tum Binance HTTP trafiginin tek kapisi: agirlik butcesi, 429 geri cekilmesi ve
 * 418 (IP bani) durumunda gurultulu durus buradan gecer.
 *
 * Public (imzasiz) veri her zaman MAINNET'ten cekilir — testnet'in tarihsel mum
 * verisi seyrek ve guvenilmezdir. Sadece EMIR trafigi testnet'e gider (services/binance.ts).
 */

const PUBLIC_BASE = 'https://fapi.binance.com';

const limiter = new RateLimiter({
  // Binance fapi limiti dakikada 2400 agirlik. %75'inde kalarak baska sureclere pay birakiyoruz.
  weightPerMinute: 1800,
  maxConcurrent: 4,
});

const MAX_RETRIES = 5;

export interface PublicGetOptions {
  /** Istegin Binance agirligi. Bilinmiyorsa 1 varsayilir. */
  weight?: number;
  params?: Record<string, string | number>;
}

export async function publicGet<T>(path: string, opts: PublicGetOptions = {}): Promise<T> {
  const weight = opts.weight ?? 1;
  const config: AxiosRequestConfig = {
    baseURL: PUBLIC_BASE,
    url: path,
    method: 'GET',
    params: opts.params,
    timeout: 30_000,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await limiter.run(weight, async () => {
        const res = await axios.request<T>(config);
        limiter.observeUsedWeight(res.headers['x-mbx-used-weight-1m'] as string | undefined);
        return res.data;
      });
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;

      // 418: IP bani. Tekrar denemek bani UZATIR — kosuyu gurultulu bicimde dusur.
      if (status === 418) {
        const retryAfter = Number(ax.response?.headers['retry-after'] ?? 0) * 1000;
        throw new BinanceBanError(retryAfter || 120_000);
      }

      if (status === 429) {
        const retryAfter = Number(ax.response?.headers['retry-after'] ?? 0) * 1000;
        const waitMs = retryAfter || backoffMs(attempt);
        limiter.pause(waitMs);
        console.warn(`[binance] 429 — ${Math.round(waitMs / 1000)}sn duraklatiliyor (deneme ${attempt + 1}/${MAX_RETRIES})`);
        if (attempt === MAX_RETRIES) throw err;
        await sleep(waitMs);
        continue;
      }

      const retriable =
        status === undefined || status >= 500 || ax.code === 'ECONNRESET' || ax.code === 'ETIMEDOUT';
      if (!retriable || attempt === MAX_RETRIES) throw err;

      const waitMs = backoffMs(attempt);
      console.warn(`[binance] ${status ?? ax.code} — ${Math.round(waitMs / 1000)}sn sonra tekrar (deneme ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
    }
  }

  // Ulasilamaz: dongu ya donuyor ya firlatiyor.
  throw new Error(`[binance] ${path} icin tum denemeler tukendi`);
}

export const IS_TESTNET = env.binance.testnet;
