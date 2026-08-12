import type { ArxivPaper } from './arxiv';

/**
 * Makale siralayici — DETERMINISTIK, sifir LLM token'i.
 *
 * ARTIK BIRINCIL YOL DEGIL. Gecenin makalesini `selector.ts` secer (bir model, abstract
 * okuyarak). Burasi YEDEK: LLM anahtari yoksa veya proxy coktuyse gece yine de bir
 * makale denesin diye durur.
 *
 * Neden yedege dustu: "bu makale bizim veriyle UYGULANABILIR mi" sorusunun anahtar
 * kelimelerle %90 dogrulukla cevaplanabilecegini varsayiyordu. Cevaplanamiyor —
 * asagidaki INFEASIBLE listesinin kendi yorum satirlari bunun kanit defteri: her satir,
 * siralayicinin bir gece bosa harcamasindan sonra eklendi ve liste her seferinde biraz
 * daha kaba oldu (artik "deep learning" gecen HER makaleyi eliyor, icinde kurala
 * cevrilebilir basit bir rejim filtresi olsa bile).
 *
 * En kritik agirlik NEGATIF olanlar: elimizde sadece OHLCV mumlari + turetilmis
 * indikatorler var. Limit order book, tick verisi, order-flow imbalance veya opsiyon
 * yuzeyi isteyen bir makale, ne kadar parlak olursa olsun, bizim sozlesmemizde
 * UYGULANAMAZ. Onu Codex'e vermek, gecenin tamamini bosa harcamak demek.
 */

/** +3: dogrudan bizim sozlesmeyle ifade edilebilen strateji aileleri. */
const STRONG = [
  'momentum',
  'mean reversion',
  'mean-reversion',
  'trend following',
  'trend-following',
  'breakout',
  'regime switching',
  'regime-switching',
  'volatility targeting',
  'volatility scaling',
  'cross-sectional',
  'time series momentum',
  'funding rate',
  'perpetual',
  'market timing',
  'directional',
];

/** +2: metodolojik olgunluk ve alan uyumu. */
const GOOD = [
  'crypto',
  'bitcoin',
  'futures',
  'out-of-sample',
  'walk-forward',
  'walk forward',
  'transaction cost',
  'slippage',
  'overfitting',
  'backtest',
  'sharpe',
  'drawdown',
];

/**
 * -5: bizim veri/sozlesme evrenimizde UYGULANAMAZ.
 * Bunlar "kotu makale" degil — bizim icin ERISILEMEZ girdiler istiyorlar.
 *
 * Iki aile var:
 *
 * (a) ERISILEMEZ VERI: elimizde sadece OHLCV mumlari + turetilmis indikatorler var.
 *     Limit order book, tick verisi, opsiyon yuzeyi isteyen bir makale ne kadar
 *     parlak olursa olsun uygulanamaz.
 *
 * (b) YANLIS VARLIK EVRENI: sozlesmemiz TEK SEMBOL uzerinde yon karari verir
 *     (LONG/SHORT/veto). ETF sepetleri arasinda tahsis, Fama-French faktor
 *     portfoyleri, hisse senedi cross-section'i — bunlar bizim ifade edemedigimiz
 *     bir karar tipidir (portfoy agirliklandirma, uzun-kisa faktor kurma).
 *
 * (b) grubunu ILK GERCEK KOSUDAN sonra ekledim: siralayici, "Growth-Defensive Style
 * Allocation / Fama-French five-factor" makalesine EN YUKSEK skoru (16) verdi — cunku
 * icinde momentum, market timing, transaction cost, walk-forward hepsi geciyordu.
 * Codex makaleyi okuyup dogru sekilde "bu bizim sozlesmede yazilamaz" dedi ve gece bos
 * gecti. Siralayici bunu ONCEDEN elemeliydi; Codex'in turunu harcamamaliydi.
 */
const INFEASIBLE = [
  // (a) erisilemez veri
  'limit order book',
  'order book',
  'order flow',
  'tick data',
  'high-frequency',
  'high frequency',
  'microstructure',
  'option pricing',
  'implied volatility',
  'volatility surface',
  'alternative data',
  'satellite',
  'earnings call',
  'news sentiment',
  'social media',
  'twitter',
  'reinforcement learning',
  'deep learning',
  'neural network',
  'transformer',
  'large language model',

  // (b) yanlis varlik evreni / karar tipi
  'etf',
  'mutual fund',
  'fama-french',
  'fama french',
  'five-factor',
  'factor model',
  'style allocation',
  'asset allocation',
  'portfolio allocation',
  'portfolio optimization',
  'equity portfolio',
  'stock selection',
  'index fund',
  'stock prediction',
  'stock return',
  'stock market',
  'equity market',
  'equities',
  's&p 500',
  'nasdaq',
  'bond',
  'treasury',
  'commodity futures',
];

export interface RankedPaper {
  paper: ArxivPaper;
  score: number;
  hits: string[];
  blockers: string[];
}

/** Sert kapi: q-fin kategorisi + skor >= 8. */
export const MIN_SCORE = 8;

export function rankPaper(paper: ArxivPaper): RankedPaper {
  const text = `${paper.title} ${paper.summary}`.toLowerCase();

  const hits: string[] = [];
  const blockers: string[] = [];
  let score = 0;

  for (const k of STRONG) {
    if (text.includes(k)) {
      score += 3;
      hits.push(k);
    }
  }
  for (const k of GOOD) {
    if (text.includes(k)) {
      score += 2;
      hits.push(k);
    }
  }
  for (const k of INFEASIBLE) {
    if (text.includes(k)) {
      score -= 5;
      blockers.push(k);
    }
  }

  // q-fin disi (ornegin saf istatistik/ML makaleleri) bizim icin degil.
  if (!paper.categories.some((c) => c.startsWith('q-fin'))) score -= 10;

  return { paper, score, hits, blockers };
}

/**
 * Siralar ve kapiyi gecenleri doner.
 *
 * `exclude`: daha once gorulen arXiv id'leri (Firestore `papers` koleksiyonu). Ayni
 * makaleyi iki kez islemek, gecenin tamamini bosa harcamaktir.
 */
export function rankPapers(
  papers: ArxivPaper[],
  exclude: ReadonlySet<string> = new Set(),
): RankedPaper[] {
  return papers
    .filter((p) => !exclude.has(p.id))
    .map(rankPaper)
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}
