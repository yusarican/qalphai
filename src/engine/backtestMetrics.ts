import type { BacktestResults, BacktestTrade, EquityPoint } from '../lib/types';

/**
 * Sample'daki backtestMetrics.ts'in yeniden yazimi. Uc gercek hata duzeltildi:
 *
 * 1. maxDrawdownPercent yanlisti (:44-47): mutlak max DD'nin OLDUGU ANDAKI yuzdeyi
 *    donduruyordu, gercek max yuzde DD'yi degil. Bunlar farkli anlarda olabilir.
 *    Ikisi de bagimsiz argmax'la takip ediliyor artik.
 *
 * 2. Sharpe yanlisti (:50-57): trade-basina dispersiyon oranini sabit sqrt(365) ile
 *    olcekliyordu. Yilda 20 islem yapanla 2000 yapan ayni annualizasyonu aliyordu —
 *    yani sayi finansal olarak anlamsizdi. Yerine equity curve'unden gunluk log-getiri.
 *
 * 3. Kaybeden tanimi `pnl <= 0` idi; break-even trade'ler kayip sayiliyordu. Korundu
 *    (gridScoring altin fixture'lariyla uyum icin) ama profitFactor artik sifir-PnL
 *    trade'lerini brut kayba katmiyor.
 */

const MS_PER_DAY = 86_400_000;

export const EMPTY_RESULTS = (initialBalance: number): BacktestResults => ({
  finalBalance: initialBalance,
  totalPnl: 0,
  totalPnlPercent: 0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRate: 0,
  maxDrawdown: 0,
  maxDrawdownPercent: 0,
  sharpeRatio: 0,
  sortinoRatio: 0,
  mar: 0,
  cagr: 0,
  profitFactor: 0,
  avgTradeReturn: 0,
  expectancyR: 0,
  totalFeesUSD: 0,
  totalFundingUSD: 0,
  feeShareOfGross: 0,
  turnoverUSD: 0,
  bestTrade: null,
  worstTrade: null,
});

export function calculateMetrics(
  trades: BacktestTrade[],
  initialBalance: number,
  equityCurve: EquityPoint[],
): BacktestResults {
  if (trades.length === 0) return EMPTY_RESULTS(initialBalance);

  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const finalBalance = initialBalance + totalPnl;

  const dd = drawdown(equityCurve, initialBalance);
  const { sharpe, sortino } = riskAdjusted(equityCurve, initialBalance);

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactorRaw = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const totalFeesUSD = trades.reduce((s, t) => s + t.feesUSD, 0);
  const totalFundingUSD = trades.reduce((s, t) => s + t.fundingUSD, 0);
  const turnoverUSD = trades.reduce((s, t) => s + t.notional * 2, 0); // giris + cikis
  const grossProfitAbs = trades.reduce((s, t) => s + Math.max(0, t.grossPnl), 0);

  // Edge'in ne kadari maliyete gidiyor? > 0.5 ise o edge degil, yuvarlama hatasidir.
  const costTotal = totalFeesUSD + Math.max(0, totalFundingUSD);
  const feeShareOfGross = grossProfitAbs > 0 ? costTotal / grossProfitAbs : costTotal > 0 ? 1 : 0;

  const spanMs = equitySpanMs(equityCurve);
  const years = spanMs > 0 ? spanMs / (365 * MS_PER_DAY) : 0;
  const cagr =
    years > 0 && initialBalance > 0 && finalBalance > 0
      ? (Math.pow(finalBalance / initialBalance, 1 / years) - 1) * 100
      : 0;

  // gridScoring'in bekledigi MAR. DD tabani: cok kucuk DD'lerin orani patlatmasini onler.
  const mar = cagr / Math.max(dd.maxDrawdownPercent, 5);

  const rTrades = trades.filter((t) => typeof t.pnlR === 'number' && Number.isFinite(t.pnlR));
  const expectancyR =
    rTrades.length > 0 ? rTrades.reduce((s, t) => s + (t.pnlR as number), 0) / rTrades.length : 0;

  const pnlPcts = trades.map((t) => t.pnlPercent);
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  return {
    finalBalance,
    totalPnl,
    totalPnlPercent: (totalPnl / initialBalance) * 100,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: (winners.length / trades.length) * 100,

    maxDrawdown: dd.maxDrawdown,
    maxDrawdownPercent: dd.maxDrawdownPercent,

    sharpeRatio: round2(sharpe),
    sortinoRatio: round2(sortino),
    mar: round2(mar),
    cagr: round2(cagr),

    profitFactor: profitFactorRaw === Infinity ? 999 : round2(profitFactorRaw),
    avgTradeReturn: round2(mean(pnlPcts)),
    expectancyR: round2(expectancyR),

    totalFeesUSD: round2(totalFeesUSD),
    totalFundingUSD: round2(totalFundingUSD),
    feeShareOfGross: round4(feeShareOfGross),
    turnoverUSD: round2(turnoverUSD),

    bestTrade: best ? { symbol: best.symbol, pnl: best.pnl, pnlPercent: best.pnlPercent } : null,
    worstTrade: worst ? { symbol: worst.symbol, pnl: worst.pnl, pnlPercent: worst.pnlPercent } : null,
  };
}

// ---------------------------------------------------------------- drawdown

interface Drawdown {
  maxDrawdown: number;
  maxDrawdownPercent: number;
}

/**
 * Mutlak ve yuzde DD'yi BAGIMSIZ takip eder. Sample ikisini tek if'te birlestirdigi
 * icin (:44-47) yuzde DD, mutlak DD'nin oldugu andaki degeri aliyordu — bakiye buyudukce
 * ayni dolar kaybi daha kucuk yuzde eder, yani gercek en kotu yuzde DD kaciriliyordu.
 * TEST_DD > 40 ve LIKIDASYON diskalifiyeleri bu sayiya dayandigi icin bu, promosyon
 * kapisini dogrudan gevsetiyordu.
 */
function drawdown(curve: EquityPoint[], initialBalance: number): Drawdown {
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const p of curve) {
    if (p.balance > peak) peak = p.balance;
    const abs = peak - p.balance;
    const pct = peak > 0 ? (abs / peak) * 100 : 0;
    if (abs > maxDrawdown) maxDrawdown = abs;
    if (pct > maxDrawdownPercent) maxDrawdownPercent = pct;
  }

  // Bakiye sifira/negatife giderse tasfiye sayilir; gridScoring LIKIDASYON bekliyor.
  if (curve.some((p) => p.balance <= 0)) maxDrawdownPercent = 100;

  return { maxDrawdown, maxDrawdownPercent };
}

// ---------------------------------------------------------------- Sharpe / Sortino

/**
 * Equity curve'unu GUNLUK kapanislara resample edip log-getiri uzerinden hesaplar.
 * Bu, islem frekansindan bagimsiz, karsilastirilabilir bir sayi verir — sample'daki
 * trade-basina versiyon karsilastirilamazdi.
 */
function riskAdjusted(curve: EquityPoint[], initialBalance: number): { sharpe: number; sortino: number } {
  const daily = resampleDaily(curve, initialBalance);
  if (daily.length < 3) return { sharpe: 0, sortino: 0 };

  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1]!;
    const cur = daily[i]!;
    // Bakiye sifira dustuyse log tanimsiz — seriyi orada kes.
    if (prev <= 0 || cur <= 0) break;
    rets.push(Math.log(cur / prev));
  }
  if (rets.length < 2) return { sharpe: 0, sortino: 0 };

  const mu = mean(rets);
  const sd = stdev(rets, mu);

  const downside = rets.filter((r) => r < 0);
  const dsd =
    downside.length > 0
      ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
      : 0;

  const ANN = Math.sqrt(365);
  return {
    sharpe: sd > 0 ? (mu / sd) * ANN : 0,
    sortino: dsd > 0 ? (mu / dsd) * ANN : 0,
  };
}

/** Her UTC gununun son bakiyesi. Islemsiz gunler bir onceki bakiyeyi tasir. */
function resampleDaily(curve: EquityPoint[], initialBalance: number): number[] {
  if (curve.length === 0) return [];

  const sorted = [...curve].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const startDay = Math.floor(first.timestamp / MS_PER_DAY);
  const endDay = Math.floor(last.timestamp / MS_PER_DAY);

  const out: number[] = [];
  let idx = 0;
  let running = initialBalance;

  for (let day = startDay; day <= endDay; day++) {
    const dayEnd = (day + 1) * MS_PER_DAY - 1;
    while (idx < sorted.length && sorted[idx]!.timestamp <= dayEnd) {
      running = sorted[idx]!.balance;
      idx++;
    }
    out.push(running);
  }

  return out;
}

function equitySpanMs(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of curve) {
    if (p.timestamp < min) min = p.timestamp;
    if (p.timestamp > max) max = p.timestamp;
  }
  return max - min;
}

// ---------------------------------------------------------------- yardimcilar

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdev(xs: number[], mu: number): number {
  if (xs.length === 0) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length);
}

function round2(n: number): number {
  return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : 0;
}

function round4(n: number): number {
  return Number.isFinite(n) ? parseFloat(n.toFixed(4)) : 0;
}
