import { DEFAULT_COOLDOWN_CANDLES } from './portfolio';
import { INTERVAL_MS } from '../lib/klineStore';
import type { CandleInterval } from '../config/env';

/**
 * BACKTEST ILE CANLI ARASINDA PAYLASILAN YURUTME AYARLARI.
 *
 * Bu uc sayi (minConfidence, useTrailing, cooldown) stratejinin kendisinde degil,
 * onu YURUTEN katmanda yasar — yani backtest'te simulate()'in, canlida executor'un
 * girdisidir. Ikisinde farkli degerler kullanilsaydi, canli motor backtest'in olctugu
 * stratejiden BASKA bir stratejiyi kosardi ve bunu hicbir test yakalamazdi: her iki
 * taraf da kendi icinde tutarli calisirdi.
 *
 * Bu yuzden degerler tek bir yerde durur ve iki taraf da buradan okur. Sayiyi iki yere
 * yazma ihtimali yapisal olarak yok edilmistir.
 */

/** Bu esigin altindaki confidence'la giris yok. */
export const DEFAULT_MIN_CONFIDENCE = 0;

/** Sabit TP yerine trailing stop (aktivasyon = TP seviyesi, takip = callbackRate). */
export const DEFAULT_USE_TRAILING = true;

/** SL/BE ile kapanan pozisyondan sonra ayni sembol+yonde yeniden giris yasagi. */
export function cooldownMsFor(interval: CandleInterval): number {
  return DEFAULT_COOLDOWN_CANDLES * INTERVAL_MS[interval];
}
