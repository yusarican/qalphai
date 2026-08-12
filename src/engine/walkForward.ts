import { calculateMetrics, EMPTY_RESULTS } from './backtestMetrics';
import { MAX_DRAWDOWN_PCT, requiredPositiveWindows } from './riskLimits';
import type { BacktestResults, BacktestTrade, EquityPoint, WalkForwardVerdict } from '../lib/types';

/**
 * Walk-forward pencereleri — sample'daki mantigin (backtestExecutor.ts:217-249) portu.
 *
 * Kayan pencere: trainDays'lik tarama dilimi + testDays'lik test dilimi, testDays kadar
 * kaydirilarak N pencere. Test dilimleri AYRIKTIR; hucre basina "kac pencerede pozitif"
 * raporlanir. Bu, toplam test PnL'ini tek sansli bir pencerenin tasimasini engeller
 * (gridScoring asama 3b bunu carpan olarak kullanir).
 */

const DAY_MS = 86_400_000;

export interface WalkForwardConfig {
  trainDays: number;
  testDays: number;
  /** Kayan pencere cikmazsa tek-bolme fallback'inde kullanilir. */
  trainRatio: number;
}

export const DEFAULT_WF: WalkForwardConfig = {
  trainDays: 120,
  testDays: 30,
  trainRatio: 0.7,
};

export interface WalkForwardWindow {
  testStart: number;
  testEnd: number;
}

export interface WalkForwardPlan {
  /** Ilk test penceresinin basi = train/test ayrim noktasi. */
  splitTime: number;
  windows: WalkForwardWindow[];
  /** true = kayan pencere; false = tek trainRatio bolmesi. */
  rolling: boolean;
  trainRatio: number;
}

export function planWalkForward(
  startDate: number,
  endDate: number,
  cfg: WalkForwardConfig = DEFAULT_WF,
): WalkForwardPlan {
  const periodMs = endDate - startDate;
  const trainSpan = cfg.trainDays * DAY_MS;
  const testSpan = cfg.testDays * DAY_MS;

  // Kayan pencere icin en az train + 2 test dilimi lazim (yoksa tek pencere kalir,
  // bu da tek-bolme ile ayni sey olur ve "pencere istikrari" bilgisi uretmez).
  if (periodMs >= trainSpan + 2 * testSpan) {
    const windows: WalkForwardWindow[] = [];
    for (let w = 0; ; w++) {
      const testStart = startDate + trainSpan + w * testSpan;
      const testEnd = Math.min(testStart + testSpan, endDate);
      if (testStart >= endDate) break;
      windows.push({ testStart, testEnd });
      if (testEnd >= endDate) break;
    }

    if (windows.length >= 2) {
      const splitTime = windows[0]!.testStart;
      return {
        splitTime,
        windows,
        rolling: true,
        // Skorlama'nin gune-normalize TEST/TRAIN orani icin gercek train payi.
        trainRatio: (splitTime - startDate) / periodMs,
      };
    }
  }

  const tr = Math.max(0.5, Math.min(0.9, cfg.trainRatio));
  const splitTime = startDate + periodMs * tr;
  return {
    splitTime,
    windows: [{ testStart: splitTime, testEnd: endDate }],
    rolling: false,
    trainRatio: tr,
  };
}

// ---------------------------------------------------------------- dilimleme

export interface SlicedResults {
  full: BacktestResults;
  train: BacktestResults;
  test: BacktestResults;
  /** Pencere basina test PnL'i (initialBalance'in %'si olarak). */
  windowTestPnls: number[];
  windowsPositive: number;
}

/**
 * Trade'leri GIRIS ZAMANINA gore train/test dilimlerine ayirir ve her dilim icin
 * metrik hesaplar. Test diliminin baslangic bakiyesi train'in bitis bakiyesidir —
 * test dilimi, train'de biriken sermayeyle devam eder (gercekci).
 */
export function sliceResults(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  initialBalance: number,
  plan: WalkForwardPlan,
): SlicedResults {
  const full = calculateMetrics(trades, initialBalance, equityCurve);

  const trainTrades = trades.filter((t) => t.entryTime < plan.splitTime);
  const testTrades = trades.filter((t) => t.entryTime >= plan.splitTime);

  const trainCurve = equityCurve.filter((p) => p.timestamp <= plan.splitTime);
  const testCurve = equityCurve.filter((p) => p.timestamp >= plan.splitTime);

  const train =
    trainTrades.length > 0
      ? calculateMetrics(trainTrades, initialBalance, trainCurve)
      : EMPTY_RESULTS(initialBalance);

  const trainEndBalance = train.finalBalance;

  const test =
    testTrades.length > 0
      ? calculateMetrics(testTrades, trainEndBalance, testCurve)
      : EMPTY_RESULTS(trainEndBalance);

  // Pencere basina test PnL'i — initialBalance'a normalize (hucreler arasi kiyaslanabilir).
  const windowTestPnls: number[] = [];
  for (const w of plan.windows) {
    const inWindow = trades.filter((t) => t.entryTime >= w.testStart && t.entryTime < w.testEnd);
    const pnl = inWindow.reduce((s, t) => s + t.pnl, 0);
    windowTestPnls.push((pnl / initialBalance) * 100);
  }
  const windowsPositive = windowTestPnls.filter((p) => p > 0).length;

  return { full, train, test, windowTestPnls, windowsPositive };
}

// ---------------------------------------------------------------- verdict

/**
 * Walk-forward hukmu. Sample'da bu mantik backtestExecutor icine gomuluydu (:424-442);
 * burada AYRI bir fonksiyon — cunku promosyon kapisi da ayni tanimi kullanmali.
 * Iki yerde iki farkli "ROBUST" tanimi olsaydi kapi sessizce gevserdi.
 */
export function deriveVerdict(args: {
  test: BacktestResults;
  windowsPositive: number;
  windowCount: number;
  /** Hicbir hucre skorlama filtrelerini gecemedi mi? */
  fallbackUsed: boolean;
}): WalkForwardVerdict {
  if (args.fallbackUsed) return 'FAILED';
  if (args.test.totalPnlPercent <= 0) return 'FAILED';

  const enoughWindows = args.windowsPositive >= requiredPositiveWindows(args.windowCount);
  const ddOk = args.test.maxDrawdownPercent <= MAX_DRAWDOWN_PCT;

  return enoughWindows && ddOk ? 'ROBUST' : 'FRAGILE';
}
