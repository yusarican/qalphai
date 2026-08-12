import type { CostConfig, ExitReason } from '../engine/costModel';
import type { RiskParams } from '../engine/riskManagement';
import type { CandleInterval } from '../config/env';

export type StrategyProfile = 'conservative' | 'balanced' | 'aggressive';

export interface BacktestTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTime: number;
  /** Ham piyasa fiyati (slippage'siz) — teshis icin saklanir. */
  entryPrice: number;
  /** Gercekte doldurulan giris fiyati (slippage dahil). TP/SL bundan turer. */
  entryFill: number;
  exitTime: number;
  exitPrice: number;
  exitFill: number;
  exitReason: ExitReason;
  leverage: number;

  /**
   * DIKKAT: sample'da `quantity` MARGIN demekti (backtestExecutor.ts:39), base miktar
   * degil. O semantik korunuyor — eski analiz/frontend kodu sessizce yanlis okumasin.
   * Base miktar icin `qtyBase`, notional icin `notional` kullan.
   */
  quantity: number;
  qtyBase: number;
  notional: number;

  grossPnl: number;
  feesUSD: number;
  fundingUSD: number;
  pnl: number;
  pnlPercent: number;
  liquidated: boolean;

  confidence: number;

  /** MAE/MFE enstrumanı; R = giris stop mesafesi. Hesaplanamazsa yazilmaz. */
  maeR?: number;
  mfeR?: number;
  pnlR?: number;
  riskUSD?: number;
}

export interface EquityPoint {
  timestamp: number;
  /** Mark-to-market: nakit + acik pozisyonlarin gerceklesmemis PnL'i. */
  balance: number;
}

export interface BacktestResults {
  finalBalance: number;
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  /** Mutlak max drawdown (USD). */
  maxDrawdown: number;
  /** GERCEK max yuzde drawdown — mutlak max'in oldugu andaki yuzde DEGIL (sample bug'i). */
  maxDrawdownPercent: number;

  /** Gunluk log-getirilerden, zaman-serisi Sharpe. */
  sharpeRatio: number;
  sortinoRatio: number;
  /** CAGR / maxDrawdownPercent — gridScoring'in bekledigi gercek MAR. */
  mar: number;
  cagr: number;

  profitFactor: number;
  avgTradeReturn: number;
  expectancyR: number;

  totalFeesUSD: number;
  totalFundingUSD: number;
  /** (fee + funding) / brut kar. > 0.5 ise edge maliyete gidiyor demektir. */
  feeShareOfGross: number;
  turnoverUSD: number;

  bestTrade: { symbol: string; pnl: number; pnlPercent: number } | null;
  worstTrade: { symbol: string; pnl: number; pnlPercent: number } | null;
}

export interface BacktestConfig {
  startDate: number;
  endDate: number;
  interval: CandleInterval;
  initialBalance: number;
  symbols: string[];
  profile: StrategyProfile;
  risk: RiskParams;
  costs: CostConfig;
  /** Strateji parametreleri (StrategyMeta.params'tan cozulmus). */
  params: Record<string, number | boolean>;
}

/** Grid'in bir hucresi: (strateji parametreleri) x (risk parametreleri). */
export interface GridCellResult {
  cellIndex: number;
  params: Record<string, number | boolean>;
  risk: RiskParams;

  results: BacktestResults;
  trainResults?: BacktestResults;
  testResults?: BacktestResults;

  plateauScore?: number;
  windowTestPnls?: number[];
  windowsPositive?: number;
}

export type WalkForwardVerdict = 'ROBUST' | 'FRAGILE' | 'FAILED';
