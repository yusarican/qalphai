import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/env';

/**
 * CANLI ISLEM DEFTERI — kalici, yalnizca-ekleme.
 *
 * Neden liveState yetmiyor: live-state.json'daki `exits` COOLDOWN PENCERESI kadar geriye
 * tutulur ve pruneExits her kosuda eskisini ATAR (liveState.ts:pruneExits). O liste bir
 * gecmis degil, bir KAPI DURUMUDUR ("bu sembolde son 3 mumda stop yendi mi?").
 *
 * Winrate ve kumulatif PnL ise gercek bir gecmis ister. Panelin gosterdigi sayilari
 * budanan bir listeden hesaplasaydik, sayilar cooldown penceresi kaydikca sessizce
 * degisirdi — yani panel her bakista baska bir gecmis anlatirdi.
 *
 * JSONL: her satir bir kapanmis islem. Ekleme atomiktir (tek write, satir sonu dahil),
 * dosya bozulursa okunamayan satir ATLANIR — bir bozuk satir tum gecmisi dusurmez.
 */

const FILE = path.join(DATA_DIR, 'live-trades.jsonl');

export interface LoggedTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  championId: string;
  entryTime: number;
  exitTime: number;
  entryFill: number;
  qtyBase: number;
  margin: number;
  leverage: number;
  confidence: number;
  /** Giris anindaki dolar riski — pnlR bundan turer. */
  riskUSD: number;
  reason: 'STOP' | 'PROFIT' | 'SIGNAL_CHANGE';
  realizedPnl: number;
  /** Borsa PnL'i okunamadiysa true — bu islem winrate'e KATILMAZ. */
  pnlUnknown: boolean;
  /** Kuru kosuda kapanan pozisyon gercek para degildir; ayri tutulur. */
  dryRun: boolean;
}

export function appendTrade(t: LoggedTrade): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(t) + '\n');
}

export function readTrades(): LoggedTrade[] {
  if (!fs.existsSync(FILE)) return [];
  const out: LoggedTrade[] = [];
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoggedTrade);
    } catch {
      // Yarim yazilmis son satir (surec olduruldu) — atla, gerisini kurtar.
    }
  }
  return out.sort((a, b) => a.exitTime - b.exitTime);
}

export interface LiveStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** pnlUnknown olanlar paydaya girmez. */
  winRate: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancyR: number;
  bestTrade: LoggedTrade | null;
  worstTrade: LoggedTrade | null;
  /** Kumulatif realize PnL egrisi (kapanan islem basina bir nokta). */
  equity: { timestamp: number; cumulativePnl: number }[];
  unknownPnlTrades: number;
}

export const EMPTY_STATS: LiveStats = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRate: 0,
  totalPnl: 0,
  grossProfit: 0,
  grossLoss: 0,
  profitFactor: 0,
  avgWin: 0,
  avgLoss: 0,
  expectancyR: 0,
  bestTrade: null,
  worstTrade: null,
  equity: [],
  unknownPnlTrades: 0,
};

/**
 * Kapanmis islemlerden canli istatistik.
 *
 * `pnlUnknown` islemler HICBIR sayiya katilmaz (ne paya ne paydaya): borsa PnL'i
 * okunamadigi icin -1 vekiliyle "stop" varsayilmislardi — o vekil cooldown kapisi icin
 * muhafazakar ve dogru, ama winrate icin UYDURMA olurdu.
 */
export function computeLiveStats(trades: LoggedTrade[], opts?: { includeDryRun?: boolean }): LiveStats {
  const rows = trades.filter(
    (t) => !t.pnlUnknown && (opts?.includeDryRun ? true : !t.dryRun),
  );
  const unknown = trades.filter((t) => t.pnlUnknown && (opts?.includeDryRun ? true : !t.dryRun)).length;

  if (rows.length === 0) return { ...EMPTY_STATS, unknownPnlTrades: unknown };

  const wins = rows.filter((t) => t.realizedPnl > 0);
  const losses = rows.filter((t) => t.realizedPnl <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));
  const totalPnl = grossProfit - grossLoss;

  // R = giris anindaki dolar riski. riskUSD yoksa o islem beklentiye katilmaz.
  const withR = rows.filter((t) => t.riskUSD > 0);
  const expectancyR =
    withR.length > 0
      ? withR.reduce((s, t) => s + t.realizedPnl / t.riskUSD, 0) / withR.length
      : 0;

  let cum = 0;
  const equity = rows.map((t) => {
    cum += t.realizedPnl;
    return { timestamp: t.exitTime, cumulativePnl: cum };
  });

  const sorted = [...rows].sort((a, b) => b.realizedPnl - a.realizedPnl);

  return {
    totalTrades: rows.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: (wins.length / rows.length) * 100,
    totalPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    expectancyR,
    bestTrade: sorted[0] ?? null,
    worstTrade: sorted[sorted.length - 1] ?? null,
    equity,
    unknownPnlTrades: unknown,
  };
}
