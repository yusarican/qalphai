/**
 * TIP STUB — orijinal dosya sample dump'inda YOKTU ama mechanicalDecider.ts:10,
 * backtestExecutor.ts:2, executor.ts ve analyzer.ts ondan import ediyordu. Yani sample
 * tree oldugu gibi DERLENMIYORDU.
 *
 * Bu dosya yalnizca o eksik sozlesmeyi belgeler ve tests/deciderParity.test.ts'in
 * sample'in mechanicalDecider'ini import edip bizimkiyle karsilastirabilmesini saglar.
 * Grok/AI karar yolu YENI sistemde tamamen kaldirildi (deterministik motor hem bedava
 * hem tekrar uretilebilir); burada calisma zamani kodu YOKTUR, sadece tipler.
 */

export interface AssetAllocation {
  symbol: string;
  signal: 'LONG' | 'SHORT' | 'HOLD';
  allocationPercent: number;
  confidence: number;
  leverage: number;
  takeProfit: number;
  stopLoss: number;
  reasoning: string;
}

export interface PortfolioAllocationResult {
  totalAllocationPercent: number;
  reservePercent: number;
  allocations: AssetAllocation[];
  marketOutlook: string;
  riskAssessment: string;
}
