import type { ChallengeResult } from '../engine/challenge';
import type { BacktestTrade } from '../lib/types';

/**
 * ZAYIFLIK TESHISI — REFINE modunda Codex'in tek yakiti.
 *
 * "Sampiyonu gelistir" demek ise yaramaz; modele NEYIN bozuk oldugunu soylemek gerekir.
 * Bu fonksiyon, sampiyonun bu geceki kosusundan somut bir teshis cikarir.
 *
 * MAE/MFE (Maximum Adverse/Favorable Excursion) ne ise yarar:
 *   - Kaybeden islemlerin cogu HIC lehe gitmeden oluyorsa -> GIRIS HASTALIGI.
 *     Sinyal daha basindan yanlis; filtre eklemek gerekir.
 *   - Kaybedenler once iyi kar gosterip sonra donuyorsa -> CIKIS HASTALIGI.
 *     Sinyal dogru, ama karı toplayamiyoruz; cikis mantigi bozuk.
 * Ikisi TAMAMEN FARKLI mudahaleler ister — birini digeriyle karistirmak, gecelerce
 * yanlis yonde evrilmek demektir.
 */

export function diagnoseWeakness(result: ChallengeResult | null): string {
  if (!result?.ok || !result.selection) {
    return 'Sampiyon bu gece degerlendirilemedi; genel bir iyilestirme dene.';
  }

  const trades = result.selection.bestRun.trades;
  const r = result.selection.best.results;
  const findings: string[] = [];

  // --- Kasa: sampiyon KENDI kapisini gecebiliyor mu?
  if (result.holdout && result.holdout.totalPnlPercent <= 0) {
    findings.push(
      `**Sampiyon KASA'da zarar ediyor** (%${result.holdout.totalPnlPercent.toFixed(1)}, ` +
        `${result.holdout.totalTrades} islem). Yani secim penceresinde iyi gorunen edge, hic ` +
        `gorulmemis veride tutmuyor — asiri uydurma (overfit) isareti. Daha SAGLAM, daha az ` +
        `parametreye duyarli bir giris mantigi gerekiyor.`,
    );
  }

  // --- MAE/MFE otopsisi
  const losers = trades.filter((t) => t.pnl <= 0 && typeof t.mfeR === 'number');
  if (losers.length >= 10) {
    const entrySick = losers.filter((t) => (t.mfeR ?? 0) < 0.25).length;
    const exitSick = losers.filter((t) => (t.mfeR ?? 0) >= 1).length;

    const entryPct = (entrySick / losers.length) * 100;
    const exitPct = (exitSick / losers.length) * 100;

    if (entryPct > 45) {
      findings.push(
        `**GIRIS HASTALIGI**: kaybeden islemlerin %${entryPct.toFixed(0)}i hic lehe gitmeden ` +
          `oldu (MFE < 0.25R). Sinyal daha en basta yanlis — piyasa girisin aleyhine hemen ` +
          `hareket ediyor. Girisi SECICI hale getiren bir onay/filtre mekanizmasi gerekiyor ` +
          `(hacim onayi, yon onayi, rejim filtresi, momentum teyidi...).`,
      );
    }
    if (exitPct > 25) {
      findings.push(
        `**CIKIS HASTALIGI**: kaybeden islemlerin %${exitPct.toFixed(0)}i once en az 1R kar ` +
          `gosterdi sonra zarara dondu (MFE >= 1R). Sinyal yonu DOGRU, ama kar toplanamiyor. ` +
          `Not: cikis mantigi (TP/SL/trailing) senin kontrolunde DEGIL — o harness'in isi. ` +
          `Sen bunu ancak daha KALICI hareketlere giren bir sinyal yazarak duzeltebilirsin ` +
          `(daha guclu trend teyidi, daha uzun ufuk).`,
      );
    }
  }

  // --- Kazanma orani cok dusuk + beklenti zayif
  if (r.winRate < 25 && r.expectancyR < 0.2) {
    findings.push(
      `Kazanma orani %${r.winRate.toFixed(0)} ve islem basina beklenti sadece ` +
        `${r.expectancyR.toFixed(2)}R. Strateji "cok sayida kucuk kayip + nadir buyuk kazanc" ` +
        `profilinde ve marj cok ince. Giris kalitesini artirmak, islem sayisini AZALTMAK pahasina ` +
        `bile olsa, beklentiyi yukseltir.`,
    );
  }

  // --- Maliyet
  if (r.feeShareOfGross > 0.25) {
    findings.push(
      `Brut karin %${(r.feeShareOfGross * 100).toFixed(0)}i komisyon+funding'e gidiyor ` +
        `(${r.totalTrades} islem, $${r.turnoverUSD.toFixed(0)} devir hacmi). Cok sik islem ` +
        `yapiliyor. Daha AZ ama daha kaliteli giris, maliyet stresi testini gecmeyi kolaylastirir.`,
    );
  }

  // --- Drawdown
  if (r.maxDrawdownPercent > 30) {
    findings.push(
      `Max drawdown %${r.maxDrawdownPercent.toFixed(0)}. Kayiplar KUMELENIYOR — ayni rejimde ` +
        `arka arkaya yanlis taraf tutuluyor olabilir. Elverissiz rejimde islem yapmayi tumden ` +
        `BIRAKAN bir kural (veto) drawdown'i kesebilir.`,
    );
  }

  if (findings.length === 0) {
    findings.push(
      `Sampiyonun belirgin bir patolojisi yok (test ${pct(r.totalPnlPercent)}, DD ` +
        `%${r.maxDrawdownPercent.toFixed(0)}, ${r.totalTrades} islem, beklenti ` +
        `${r.expectancyR.toFixed(2)}R). Bagimsiz bir edge kaynagi ekleyerek — sampiyonla ` +
        `sinyal ortusmesi DUSUK olan bir yaklasim — gelistirmeyi dene.`,
    );
  }

  return findings.map((f, i) => `${i + 1}. ${f}`).join('\n\n');
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/** Cikis nedeni dagilimi — rapor icin. */
export function exitBreakdown(trades: BacktestTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) out[t.exitReason] = (out[t.exitReason] ?? 0) + 1;
  return out;
}
