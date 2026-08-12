import type { BacktestResults, WalkForwardVerdict } from '../lib/types';

/**
 * PROMOSYON KAPISI.
 *
 * Bu sistemin varolussal riski bug degil, COKLU TEST (multiple testing). 365 gece x
 * ~1700 grid hucresi ~= 620.000 deneme, TEK bir fiyat gecmisine karsi. Bu olcekte,
 * tamamen rastgele bir strateji ureteci bile er ya da gec "muhtesem" gorunen bir hucre
 * bulur. Yani sorunun kaynagi Codex'in kotu strateji yazmasi degil — sorun, yeterince
 * cok denersen SANSIN bilgi gibi gorunmesi.
 *
 * Bu kapinin isi iyi stratejileri bulmak degil. Isi, SANSI ELEMEK. Asagidaki dokuz sart
 * bunun icin var ve hicbiri "az kalsın geciyordu" diyen bir gece icin gevsetilmemeli.
 *
 * En kritik olan 8 numara: KASA. Secim yolundaki hicbir kodun gormedigi bir pencere.
 * O olmadan bu kapi, ustune birkac adim eklenmis bir rastgele sayi uretecidir.
 */

export interface EvaluatedRun {
  verdict: WalkForwardVerdict;
  /** Kazanan hucre skorlama filtrelerini gecti mi (fallback'e dusulmedi mi)? */
  qualified: boolean;
  test: BacktestResults;
  windowsPositive: number;
  windowCount: number;
  /** Kazanan hucrenin Chebyshev kupundeki nitelikli / diskalifiye komsu sayilari. */
  qualifiedNeighbors: number;
  dqNeighbors: number;
  codeSha256: string;
  /** Giris sinyallerinin imzasi: `${timestamp}:${symbol}:${side}` kumesi. */
  entrySignature: ReadonlySet<string>;
}

export interface PromotionInput {
  /** Bu gece AYNI veri ve AYNI maliyetle yeniden kosulmus sampiyon. */
  champion: EvaluatedRun | null;
  challenger: EvaluatedRun;
  /** Aday, fee x1.5 / slippage x2 ile. */
  challengerStress: BacktestResults;
  /** Aday, SECIMDE HIC KULLANILMAYAN holdout penceresinde. */
  holdout: BacktestResults;
}

export interface PromotionVerdict {
  promote: boolean;
  /** Gecilen sartlar — raporda gorunur. */
  reasons: string[];
  /** Gecilemeyen sartlar. Bos degilse promote = false. */
  blockers: string[];
}

/** Aday, sampiyonun MAR'ini bu kadar gecmeli. Gurultu hendegi. */
export const MAR_MARGIN = 1.1;
/** Test diliminde en az bu kadar islem. */
export const MIN_TEST_TRADES = 30;
/** Pencere istikrari alt siniri. */
export const MIN_WINDOW_WIN_RATE = 0.6;
/** Plato sarti: kazanan hucrenin cevresinde en az bu kadar nitelikli komsu. */
export const MIN_QUALIFIED_NEIGHBORS = 3;
export const MAX_DQ_NEIGHBORS = 6;
/** Sinyal ortusme tavani: bunun ustu "ayni strateji, farkli sapka". */
export const MAX_SIGNAL_OVERLAP = 0.9;

export function evaluatePromotion(input: PromotionInput): PromotionVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const c = input.challenger;
  const ch = input.champion;

  const ok = (msg: string) => reasons.push(msg);
  const no = (msg: string) => blockers.push(msg);

  // --- 1. Walk-forward hukmu ROBUST olmali.
  // Bu, backtest ile kapinin AYNI tanimi paylasmasini gerektirir (walkForward.deriveVerdict).
  // Iki yerde iki farkli "ROBUST" tanimi olsaydi kapi sessizce gevserdi.
  if (c.verdict === 'ROBUST' && c.qualified) {
    ok(`walk-forward verdict ROBUST (${c.windowsPositive}/${c.windowCount} windows positive)`);
  } else {
    no(
      c.qualified
        ? `walk-forward verdict ${c.verdict}, must be ROBUST`
        : 'no grid cell passed the scoring filters',
    );
  }

  // --- 2. Test dilimi karli ve yeterince kalabalik.
  if (c.test.totalPnlPercent > 0) ok(`test slice +${c.test.totalPnlPercent.toFixed(1)}%`);
  else no(`test slice ${c.test.totalPnlPercent.toFixed(1)}%, must be positive`);

  if (c.test.totalTrades >= MIN_TEST_TRADES) {
    ok(`${c.test.totalTrades} test trades`);
  } else {
    no(`only ${c.test.totalTrades} test trades, ${MIN_TEST_TRADES} required — too few to be statistically meaningful`);
  }

  // --- 3. Pencere istikrari: toplam kari tek sansli pencere tasimasin.
  const winRate = c.windowCount > 0 ? c.windowsPositive / c.windowCount : 0;
  if (winRate >= MIN_WINDOW_WIN_RATE) {
    ok(`${(winRate * 100).toFixed(0)}% of windows positive`);
  } else {
    no(
      `only ${(winRate * 100).toFixed(0)}% of windows positive ` +
        `(${MIN_WINDOW_WIN_RATE * 100}% required) — the profit may sit in a single lucky window`,
    );
  }

  // --- 4. Sampiyonu GERCEKTEN gecmeli (elmayla elma: sampiyon bu gece yeniden kosuldu).
  if (ch) {
    const need = ch.test.mar * MAR_MARGIN;
    const marginPct = Math.round((MAR_MARGIN - 1) * 100); // 1.1 - 1 = 0.10000000000000009
    if (c.test.mar >= need) {
      ok(`MAR ${c.test.mar.toFixed(2)} beats champion ${ch.test.mar.toFixed(2)} by the required ${marginPct}%`);
    } else {
      no(
        `MAR ${c.test.mar.toFixed(2)} did not clear the champion's ${ch.test.mar.toFixed(2)} by ${marginPct}% ` +
          `(needs >= ${need.toFixed(2)})`,
      );
    }

    const ddCap = Math.max(ch.test.maxDrawdownPercent * 1.2, 25);
    if (c.test.maxDrawdownPercent <= ddCap) {
      ok(`test drawdown ${c.test.maxDrawdownPercent.toFixed(1)}% (ceiling ${ddCap.toFixed(1)}%)`);
    } else {
      no(`test drawdown ${c.test.maxDrawdownPercent.toFixed(1)}% exceeds the ${ddCap.toFixed(1)}% ceiling`);
    }

    // --- 9. Klon degil.
    if (c.codeSha256 === ch.codeSha256) {
      no('the code is byte-identical to the champion');
    } else {
      const overlap = signalOverlap(c.entrySignature, ch.entrySignature);
      if (overlap < MAX_SIGNAL_OVERLAP) {
        ok(`${(overlap * 100).toFixed(0)}% signal overlap with the champion`);
      } else {
        no(
          `${(overlap * 100).toFixed(0)}% signal overlap with the champion ` +
            `(must be under ${MAX_SIGNAL_OVERLAP * 100}%) — the same strategy wearing a different hat`,
        );
      }
    }
  } else {
    ok('no incumbent — this candidate would be the first champion');
  }

  // --- 5. MALIYET STRESI: edge fee-rebate fantezisi mi?
  // Bir strateji, gercekci maliyette karli ama biraz daha yuksek maliyette zararliysa,
  // sahip oldugu sey bir edge degil, maliyet varsayimimiza yapilmis bir bahistir.
  if (input.challengerStress.totalPnlPercent > 0) {
    ok(`still +${input.challengerStress.totalPnlPercent.toFixed(1)}% under cost stress (fees x1.5, slippage x2)`);
  } else {
    no(
      `${input.challengerStress.totalPnlPercent.toFixed(1)}% under cost stress — ` +
        `the edge is a bet on our cost assumption, not on the market`,
    );
  }

  // --- 6. PLATO, diken degil.
  // Mayin tarlasindaki yalniz bir ada, sansli bir hucredir. Etrafindaki parametrelerle
  // de calisan bir bolge ise gercek bir rejimdir.
  if (c.qualifiedNeighbors >= MIN_QUALIFIED_NEIGHBORS && c.dqNeighbors <= MAX_DQ_NEIGHBORS) {
    ok(`plateau: ${c.qualifiedNeighbors} qualifying neighbours, ${c.dqNeighbors} disqualified`);
  } else {
    no(
      `the winning cell is a SPIKE: ${c.qualifiedNeighbors} qualifying neighbours ` +
        `(${MIN_QUALIFIED_NEIGHBORS} required), ${c.dqNeighbors} disqualified ` +
        `(at most ${MAX_DQ_NEIGHBORS}) — the parameter choice rests on luck`,
    );
  }

  // --- 7. KASA (holdout).
  //
  // Bu pencereyi hicbir backtest, hicbir sweep, hicbir skorlama gormedi. Ona dokunan
  // TEK kod burasi ve yalnizca son bir evet/hayir olarak. Yukaridaki tum sartlar
  // "secim yaptigimiz veriye" bakiyor; bu, secimden SONRA sorulan tek durust soru.
  if (input.holdout.totalPnlPercent > 0 && input.holdout.maxDrawdownPercent <= 40) {
    ok(
      `HOLDOUT (never used in selection): +${input.holdout.totalPnlPercent.toFixed(1)}%, ` +
        `drawdown ${input.holdout.maxDrawdownPercent.toFixed(1)}%, ${input.holdout.totalTrades} trades`,
    );
  } else {
    no(
      `failed on the HOLDOUT: ${input.holdout.totalPnlPercent.toFixed(1)}% P&L, ` +
        `drawdown ${input.holdout.maxDrawdownPercent.toFixed(1)}% — ` +
        `most likely overfitted to the selection window`,
    );
  }

  return { promote: blockers.length === 0, reasons, blockers };
}

/** Iki strateji ayni anlarda ayni yonde mi giriyor? Jaccard benzerligi. */
export function signalOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}
