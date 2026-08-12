import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/env';

/**
 * CANLI DEFTER — borsanin bize soylemedigi seyleri hatirlar.
 *
 * Borsa "su an neyin acik" sorusuna cevap verir. Ama simulator'un giris kapilari bunu
 * DEGIL, gecmisi sorar:
 *
 *   simulator.ts:263 — "yakin zamanda ayni sembol+yonde STOP yendi mi?" (cooldown)
 *   simulator.ts:302 — "acik pozisyonlarin toplam riski ne?" (RISK_CAP)
 *
 * Ikisi de borsadan okunamaz: positionRisk cikis SEBEBINI tasimaz ve pozisyonun
 * ACILDIGI andaki riskUSD'sini bilmez (o, giris ATR'sinden turer ve zamanla degisir).
 * Bu defter olmasaydi canli motor bu kapilari uygulayamaz — yani backtest'in olctugu
 * stratejiden farkli bir strateji kosardi.
 *
 * Defter borsanin YERINE gecmez, onu TAMAMLAR: her kosuda once borsa okunur, sonra
 * defter borsaya gore duzeltilir (reconcile). Celiskide borsa hakli — pozisyonun var
 * olup olmadigi konusunda tek otorite odur.
 */

const FILE = path.join(DATA_DIR, 'live-state.json');

export interface LedgerPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTime: number;
  /** Gercek dolum fiyati. TP/SL/BE bundan turer (simulator'da entryFill). */
  entryFill: number;
  qtyBase: number;
  margin: number;
  leverage: number;
  confidence: number;
  /** Giris anindaki dolar riski — RISK_CAP bunu toplar. */
  riskUSD: number;
  initialStopPrice: number;
  /** Trailing aktivasyon seviyesi (useTrailing ise). */
  activationPrice?: number;
  callbackRate?: number;

  entryOrderId: string;
  slOrderId: string | null;
  tpOrderId: string | null;
  /** Karar bari — ayni barda iki kez girmeyi engeller. */
  decisionBar: number;
}

export interface LedgerExit {
  symbol: string;
  side: 'LONG' | 'SHORT';
  exitTime: number;
  /**
   * Cikis sebebi. Borsa bunu vermez; realize PnL'den CIKARSANIR (binanceOrders.ts
   * getRealizedPnlSince). Zararla kapanan = STOP sayilir. Cooldown yalnizca STOP'a bakar.
   */
  reason: 'STOP' | 'PROFIT' | 'SIGNAL_CHANGE';
  realizedPnl: number;
}

export interface LiveState {
  /** Sampiyon kimligi — degisirse defter tasinmaz, sifirlanir. */
  championId: string;
  positions: LedgerPosition[];
  /** Yalnizca cooldown penceresi kadar geriye tutulur. */
  exits: LedgerExit[];
  lastRunAt: number;
  lastDecisionBar: number;
}

const EMPTY: LiveState = {
  championId: '',
  positions: [],
  exits: [],
  lastRunAt: 0,
  lastDecisionBar: 0,
};

export function readState(championId: string): LiveState {
  if (!fs.existsSync(FILE)) return { ...EMPTY, championId };

  const s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as LiveState;

  /**
   * Sampiyon degistiyse defter GECERSIZ: icindeki pozisyonlar baska bir stratejinin
   * risk parametreleriyle acilmis, cooldown gecmisi baska bir stratejinin stop'larindan
   * olusmustur. Yeni sampiyonun kapilarini eski sampiyonun gecmisiyle uygulamak,
   * ikisinin de olcmedigi ucuncu bir strateji kosmak demektir.
   *
   * Acik pozisyonlar KORUNUR (borsada gercekten duruyorlar, yonetilmeleri gerek),
   * ama cikis gecmisi silinir.
   */
  if (s.championId !== championId) {
    return { ...s, championId, exits: [] };
  }
  return s;
}

export function writeState(s: LiveState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

/** Cooldown penceresinin disina dusen cikislari atar — defter sinirsiz buyumesin. */
export function pruneExits(s: LiveState, cooldownMs: number, now: number): void {
  const cutoff = now - cooldownMs;
  s.exits = s.exits.filter((e) => e.exitTime >= cutoff);
}

/**
 * simulator.ts:263 ile AYNI soru: `at` aninda bu sembol+yonde cooldown acik mi?
 * Simulator yalnizca SL/BE ile kapananlara bakar — burada karsiligi 'STOP'.
 */
export function inCooldown(
  s: LiveState,
  symbol: string,
  side: 'LONG' | 'SHORT',
  at: number,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0) return false;
  const since = at - cooldownMs;
  return s.exits.some(
    (e) => e.symbol === symbol && e.side === side && e.reason === 'STOP' && e.exitTime >= since,
  );
}

/** simulator.ts:302 ile AYNI toplam: acik pozisyonlarin giris anindaki dolar riski. */
export function openRiskUSD(s: LiveState): number {
  return s.positions.reduce((sum, p) => sum + p.riskUSD, 0);
}
