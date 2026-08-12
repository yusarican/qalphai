import type {
  Strategy,
  StrategyContext,
  StrategyDecision,
  StrategyFactory,
} from '../types';

/**
 * SAMPIYON v0 — sample'daki mekanik karar motorunun SINYAL yarisi.
 *
 * mechanicalDecider.evaluateSymbol (samplebackend/engine/mechanicalDecider.ts:154-351)
 * bu sozlesmeye portlandi. Korunanlar: composite-vs-esik, LOW_VOLUME, DI_MISMATCH,
 * NO_CONFIRMATION, confidence haritasi, funding/LSR/makro/BTC-rejim cezalari, CONFIDENCE_GATE.
 *
 * CIKARILANLAR (artik harness'in isi, Codex'in de erisemedigi yer):
 *   - Kaldirac kademelemesi (:323-327)  -> engine/portfolio.ts
 *   - TP/SL doldurma        (:331-332)  -> engine/riskManagement.ts
 *   - Allocation cap dongusu (:380-412) -> engine/portfolio.ts
 *   - Cooldown              (:79)       -> engine/portfolio.ts (bir RISK kurali, sinyal kurali degil)
 *
 * Net etki: sampiyon da Codex ciktisiyla AYNI arayuze girer. Boylece "yeni strateji
 * eskisini gecti mi" sorusu elmayla elma karsilastirmasi olur, ve kaldirac — Codex'in
 * asla dokunmamasi gereken sey — kanitlanabilir sekilde erisiminin disinda kalir.
 */

const FUNDING_CROWDED = 0.0005; // 8 saatte +/-%0.05
const LSR_LONG_HEAVY = 1.5;
const LSR_SHORT_HEAVY = 0.67;

const FUNDING_PENALTY = 0.1;
const LSR_PENALTY = 0.05;
const MACRO_PENALTY = 0.05;
const BTC_REGIME_PENALTY = 0.05;

/** |composite| esigin bu kadar altindaysa BELOW_THRESHOLD veto'su KAYDEDILIR
 *  ("esigi gevsetsem ne olurdu" karsi-olgusunun ham verisi). Daha uzaktakiler
 *  kayda deger degil — her mumda her sembolu loglamak karar akisini sisirir. */
const NEAR_MISS_BAND = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function num(ctx: StrategyContext, key: string, fallback: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(ctx: StrategyContext, key: string, fallback: boolean): boolean {
  const v = ctx.params[key];
  return typeof v === 'boolean' ? v : fallback;
}

function evaluate(ctx: StrategyContext): StrategyDecision {
  const ti = ctx.indicators;

  const last = ctx.candles[ctx.candles.length - 1];
  if (!last) return null;
  const price = last.close;
  if (!(price > 0)) return null;

  // ATR yoksa sizing imkansiz — harness pozisyon acamaz, sinyal uretmenin anlami yok.
  if (ti.atr === null || !(ti.atr > 0)) {
    return { veto: true, rule: 'NO_ATR' };
  }

  const threshold = num(ctx, 'entryThreshold', 0.35);
  const minConfidence = num(ctx, 'minConfidence', 0.6);

  const composite = ti.hierarchy.compositeScore;
  const absComposite = Math.abs(composite);

  if (absComposite < threshold) {
    if (absComposite >= threshold - NEAR_MISS_BAND) {
      return {
        veto: true,
        rule: 'BELOW_THRESHOLD',
        wouldBe: composite > 0 ? 'LONG' : 'SHORT',
        note: `composite ${composite.toFixed(3)} < esik ${threshold}`,
      };
    }
    return null;
  }

  const side: 'LONG' | 'SHORT' = composite > 0 ? 'LONG' : 'SHORT';

  // Hacim onayi. Opt-in; veri yoksa fail-open (canli ile backtest ayrismasin).
  const minVolumeRatio = num(ctx, 'minVolumeRatio', 0);
  const volRatio = ti.volumeProfile?.currentVsAverage;
  if (minVolumeRatio > 0 && typeof volRatio === 'number' && volRatio < minVolumeRatio) {
    return { veto: true, rule: 'LOW_VOLUME', wouldBe: side };
  }

  // Yon onayi: hacim katilimi, DI ise hareketin YONUNU dogrular.
  if (bool(ctx, 'requireDirectionalDi', false) && ti.adx) {
    const confirmed =
      side === 'LONG' ? ti.adx.plusDI > ti.adx.minusDI : ti.adx.minusDI > ti.adx.plusDI;
    if (!confirmed) {
      return { veto: true, rule: 'DI_MISMATCH', wouldBe: side };
    }
  }

  // Giris onay bari: son N kapanmis mumun TUMU sinyal yonunde kapanmali.
  // Kararlar her mum kapanisinda yenilendigi icin bu, "sinyali gor, onay barini bekle,
  // onayda gir" akisinin DURUMSUZ esdegeridir. Doji onay sayilmaz.
  const confirmN = Math.floor(num(ctx, 'confirmationCandles', 0));
  if (confirmN >= 1 && ctx.candles.length >= confirmN) {
    const recent = ctx.candles.slice(-confirmN);
    const confirmed = recent.every((c) => (side === 'LONG' ? c.close > c.open : c.close < c.open));
    if (!confirmed) {
      return { veto: true, rule: 'NO_CONFIRMATION', wouldBe: side };
    }
  }

  // Confidence: esikte tam minConfidence'a oturur, esik ustunde |composite| ile monoton artar.
  let confidence = clamp(minConfidence + (absComposite - threshold) * 1.5, minConfidence, 0.95);

  const penalties: string[] = [];

  // BTC asagi + makro 'mixed' iken LONG: rejim analizindeki en zararli segment.
  // Mutlak veto degil, soft ceza — yalnizca esigi rahat asan guclu sinyaller hayatta kalir.
  if (bool(ctx, 'btcRegimeFilter', true) && side === 'LONG' && ctx.macro?.riskAppetite === 'mixed') {
    const btc = ctx.market.btc;
    if (btc && btc.sma200 !== null && btc.price > 0 && btc.price < btc.sma200) {
      confidence -= BTC_REGIME_PENALTY;
      penalties.push('BTC_REGIME');
    }
  }

  // Funding kalabaligi: kalabalik yonle AYNI taraftaysak ceza (yuksek funding = donus riski).
  if (ctx.funding !== null) {
    const crowded =
      (side === 'LONG' && ctx.funding > FUNDING_CROWDED) ||
      (side === 'SHORT' && ctx.funding < -FUNDING_CROWDED);
    if (crowded) {
      confidence -= FUNDING_PENALTY;
      penalties.push('FUNDING');
    }
  }

  // Long/Short oran kalabaligi.
  if (ctx.lsr) {
    const crowded =
      (side === 'LONG' && ctx.lsr.longShortRatio > LSR_LONG_HEAVY) ||
      (side === 'SHORT' && ctx.lsr.longShortRatio < LSR_SHORT_HEAVY);
    if (crowded) {
      confidence -= LSR_PENALTY;
      penalties.push('LSR');
    }
  }

  if (ctx.macro?.riskAppetite === 'risk_off') {
    confidence -= MACRO_PENALTY;
    penalties.push('MACRO');
  }

  // Cezalar sonrasi kapinin altina dustuyse sinyal HOLD'a doner.
  if (confidence < minConfidence) {
    return {
      veto: true,
      rule: 'CONFIDENCE_GATE',
      wouldBe: side,
      note: penalties.length ? `cezalar: ${penalties.join(',')}` : undefined,
    };
  }

  return {
    side,
    confidence: parseFloat(confidence.toFixed(2)),
    reason: `composite ${composite >= 0 ? '+' : ''}${composite.toFixed(2)} (esik ${threshold})${
      penalties.length ? ` | ceza: ${penalties.join(',')}` : ''
    }`,
  };
}

const factory: StrategyFactory = (): Strategy => ({
  meta: {
    id: 'mechanical-v0',
    name: 'Mekanik Tier-Composite v0',
    version: 1,
    author: 'human',
    provenance: {
      hypothesis:
        '5 katmanli agirlikli indikator kompoziti (trend/momentum/yapi/fiyat-aksiyonu/hacim) ' +
        'yonlu bir edge tasir; kalabalik konumlanma (funding, L/S) ve risk-off makro rejim ' +
        'bu edge i zayiflatir, dolayisiyla confidence cezasi yer.',
    },
    // EMA200/SMA200/ADX/Fib icin gerekli. Sample da 250 mum warmup cekiyordu.
    warmupBars: 250,
    needs: { funding: true, macro: true, btcRegime: true, history: false },
    params: [
      {
        key: 'entryThreshold',
        type: 'number',
        default: 0.35,
        sweep: [0.25, 0.35, 0.45],
        min: 0.05,
        max: 0.9,
        doc: '|compositeScore| giris esigi',
      },
      {
        key: 'minConfidence',
        type: 'number',
        default: 0.6,
        min: 0.3,
        max: 0.95,
        doc: 'cezalar sonrasi minimum confidence; altina dusen sinyal HOLD olur',
      },
      {
        key: 'minVolumeRatio',
        type: 'number',
        default: 0,
        sweep: [0, 0.8, 1.0],
        min: 0,
        max: 5,
        doc: 'son mum hacmi / ortalama hacim alt siniri. 0 = kapali',
      },
      {
        // Taranmiyor: DI filtresinin etkisi (sample'in filtre bilancosuna gore) marjinaldi;
        // esik/hacim/onay eksenleri daha bilgilendirici. Basta bir de tavan sebebi vardi
        // (risk grid'i riskPerTradePct eksenini kazaninca toplam 2000'i asiyordu) — o tavan
        // artik 20k, yani bu eksen ACILABILIR; kapali kalmasi bir arastirma karari, kisit degil.
        key: 'requireDirectionalDi',
        type: 'boolean',
        default: false,
        doc: 'LONG icin +DI > -DI sarti',
      },
      {
        key: 'confirmationCandles',
        type: 'number',
        default: 0,
        sweep: [0, 1],
        min: 0,
        max: 5,
        doc: 'son N mumun tumu sinyal yonunde kapanmali. 0 = kapali',
      },
      {
        key: 'btcRegimeFilter',
        type: 'boolean',
        default: true,
        doc: 'BTC<SMA200 + makro mixed iken LONG confidence cezasi',
      },
    ],
    maxSweepCells: 36,
  },
  evaluate,
});

export default factory;
