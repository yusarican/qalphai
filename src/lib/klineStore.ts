import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/env';
import { publicGet } from '../services/binanceClient';

/**
 * Yerel mum + funding cache'i.
 *
 * Neden Firestore degil: intrabar cozumleyici 1 DAKIKALIK mum istiyor (bir mum hem
 * TP hem SL'ye degdiginde hangisinin once vuruldugunu bulmak icin). 1 yil x 6 sembol
 * x 1m = ~3M satir; bu Firestore'da 3M doc write demek.
 *
 * Ama asil sebep hiz degil, MIMARI: SQLite okumasi SENKRON. Sample'da simulateRun
 * yalnizca resolveIntrabar'in 1m mumu agdan lazy cekmesi yuzunden async'ti
 * (backtestExecutor.ts:1171) ve bu tek async yaprak tum replay dongusunu (:343)
 * paralellestirilemez kiliyordu. Veri onceden burada oturunca simulator tamamen
 * senkron/CPU-bound olur ve worker pool'a dagilir.
 */

export type KlineInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface FundingRate {
  fundingTime: number;
  /** 0.0005 = 8 saatte +%0.05. Pozitif = LONG'lar SHORT'lara oder. */
  rate: number;
}

export const INTERVAL_MS: Record<KlineInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'market.db');
  db = new Database(file);

  // WAL: birden fazla worker ayni dosyayi es zamanli OKUYABILSIN diye.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS klines (
      symbol     TEXT    NOT NULL,
      interval   TEXT    NOT NULL,
      open_time  INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
      close_time INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, open_time)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS funding (
      symbol       TEXT    NOT NULL,
      funding_time INTEGER NOT NULL,
      rate         REAL    NOT NULL,
      PRIMARY KEY (symbol, funding_time)
    ) WITHOUT ROWID;

    -- Neyin zaten indirildigi. Sadece BOSLUKLARI cekmek icin.
    CREATE TABLE IF NOT EXISTS coverage (
      symbol   TEXT    NOT NULL,
      interval TEXT    NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms   INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval)
    ) WITHOUT ROWID;
  `);

  return db;
}

/** Read-only handle — worker thread'ler icin. Yazma yok, kilit yok. */
export function openReadOnly(): Database.Database {
  const file = path.join(DATA_DIR, 'market.db');
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  ro.pragma('query_only = true');
  return ro;
}

// ---------------------------------------------------------------- okuma (senkron)

interface KlineRow {
  open_time: number; o: number; h: number; l: number; c: number; v: number; close_time: number;
}

function rowToKline(r: KlineRow): Kline {
  return {
    openTime: r.open_time,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
    closeTime: r.close_time,
  };
}

/** [from, to] araligindaki mumlar, openTime'a gore artan. Senkron. */
export function getKlines(
  handle: Database.Database,
  symbol: string,
  interval: KlineInterval,
  from: number,
  to: number,
): Kline[] {
  const rows = handle
    .prepare(
      `SELECT open_time, o, h, l, c, v, close_time FROM klines
       WHERE symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?
       ORDER BY open_time ASC`,
    )
    .all(symbol, interval, from, to) as KlineRow[];
  return rows.map(rowToKline);
}

/**
 * Tek bir mumun ICINI cozmek icin 1m mumlari. resolveIntrabar bunu cagirir.
 * Sample'daki intrabarCache + ag cagrisinin yerini alir.
 */
export function getIntrabar(
  handle: Database.Database,
  symbol: string,
  candleOpenTime: number,
  candleCloseTime: number,
): Kline[] {
  return getKlines(handle, symbol, '1m', candleOpenTime, candleCloseTime);
}

export function getFunding(
  handle: Database.Database,
  symbol: string,
  from: number,
  to: number,
): FundingRate[] {
  const rows = handle
    .prepare(
      `SELECT funding_time, rate FROM funding
       WHERE symbol = ? AND funding_time >= ? AND funding_time <= ?
       ORDER BY funding_time ASC`,
    )
    .all(symbol, from, to) as Array<{ funding_time: number; rate: number }>;
  return rows.map((r) => ({ fundingTime: r.funding_time, rate: r.rate }));
}

// ---------------------------------------------------------------- yazma / senkronizasyon

interface CoverageRow { start_ms: number; end_ms: number }

function getCoverage(symbol: string, interval: KlineInterval): CoverageRow | null {
  const row = getDb()
    .prepare(`SELECT start_ms, end_ms FROM coverage WHERE symbol = ? AND interval = ?`)
    .get(symbol, interval) as CoverageRow | undefined;
  return row ?? null;
}

function widenCoverage(symbol: string, interval: KlineInterval, from: number, to: number): void {
  const cur = getCoverage(symbol, interval);
  const start = cur ? Math.min(cur.start_ms, from) : from;
  const end = cur ? Math.max(cur.end_ms, to) : to;
  getDb()
    .prepare(
      `INSERT INTO coverage (symbol, interval, start_ms, end_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol, interval) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms`,
    )
    .run(symbol, interval, start, end);
}

const insertKline = () =>
  getDb().prepare(
    `INSERT INTO klines (symbol, interval, open_time, o, h, l, c, v, close_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, interval, open_time) DO NOTHING`,
  );

/** Binance /fapi/v1/klines ham dizi formati. */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

async function fetchKlinePage(
  symbol: string,
  interval: KlineInterval,
  startTime: number,
  endTime: number,
): Promise<Kline[]> {
  const raw = await publicGet<RawKline[]>('/fapi/v1/klines', {
    weight: 10, // limit>1000 -> agirlik 10
    params: { symbol, interval, startTime, endTime, limit: 1500 },
  });
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

/**
 * [from, to] araligini cache'te GARANTI eder. Zaten kapsanan kisim tekrar indirilmez;
 * sadece bastaki/sondaki bosluklar cekilir.
 */
export async function ensureKlines(
  symbol: string,
  interval: KlineInterval,
  from: number,
  to: number,
): Promise<{ fetched: number }> {
  const gaps = missingRanges(getCoverage(symbol, interval), from, to);
  if (gaps.length === 0) return { fetched: 0 };

  const stmt = insertKline();
  const insertMany = getDb().transaction((rows: Kline[]) => {
    for (const k of rows) {
      stmt.run(symbol, interval, k.openTime, k.open, k.high, k.low, k.close, k.volume, k.closeTime);
    }
  });

  let fetched = 0;
  for (const gap of gaps) {
    let cursor = gap.from;
    for (;;) {
      const page = await fetchKlinePage(symbol, interval, cursor, gap.to);
      if (page.length === 0) break;

      insertMany(page);
      fetched += page.length;

      const last = page[page.length - 1]!;
      const next = last.closeTime + 1;
      // Sonsuz dongu korumasi: ilerlemiyorsak dur.
      if (next <= cursor || next > gap.to) break;
      cursor = next;

      if (page.length < 1500) break;
    }
  }

  widenCoverage(symbol, interval, from, to);
  return { fetched };
}

/**
 * Kapsanan araliga gore eksik pencereleri hesaplar. Coverage tek bir surekli
 * aralik olarak tutulur (delikli kullanim senaryomuz yok: hep "su tarihten bugune"
 * cekiyoruz), bu yuzden en fazla iki bosluk cikar: basta ve sonda.
 */
function missingRanges(
  cov: CoverageRow | null,
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  if (!cov) return [{ from, to }];
  const gaps: Array<{ from: number; to: number }> = [];
  if (from < cov.start_ms) gaps.push({ from, to: Math.min(to, cov.start_ms - 1) });
  if (to > cov.end_ms) gaps.push({ from: Math.max(from, cov.end_ms + 1), to });
  return gaps;
}

interface RawFunding { fundingTime: number; fundingRate: string }

/**
 * Funding gecmisi. Maliyet modelinin yakit kaynagi — Binance bunu tum gecmis icin
 * verir (OI/LSR'nin aksine, onlar sadece son 30 gun).
 */
export async function ensureFunding(symbol: string, from: number, to: number): Promise<{ fetched: number }> {
  const stmt = getDb().prepare(
    `INSERT INTO funding (symbol, funding_time, rate) VALUES (?, ?, ?)
     ON CONFLICT(symbol, funding_time) DO NOTHING`,
  );
  const insertMany = getDb().transaction((rows: FundingRate[]) => {
    for (const f of rows) stmt.run(symbol, f.fundingTime, f.rate);
  });

  let cursor = from;
  let fetched = 0;

  for (;;) {
    const raw = await publicGet<RawFunding[]>('/fapi/v1/fundingRate', {
      weight: 1,
      params: { symbol, startTime: cursor, endTime: to, limit: 1000 },
    });
    if (raw.length === 0) break;

    const rows = raw.map((r) => ({ fundingTime: r.fundingTime, rate: parseFloat(r.fundingRate) }));
    insertMany(rows);
    fetched += rows.length;

    const last = rows[rows.length - 1]!;
    const next = last.fundingTime + 1;
    if (next <= cursor || next > to) break;
    cursor = next;

    if (raw.length < 1000) break;
  }

  return { fetched };
}
