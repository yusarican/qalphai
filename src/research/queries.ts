/**
 * arXiv sorgulari.
 *
 * Ilk ikisi kullanicinin verdigi sorgular. Kalanlar gecelik ROTASYON icin: tek bir sorguyu
 * her gece kosarsak ayni dilimi sonsuza kadar tarariz ve birkac hafta sonra sistem yeni
 * fikir bulamaz hale gelir. Rotasyon, arama yuzeyini genisletir.
 */

import { activeDirectives } from '../orchestrator/directives';

export interface ArxivQuery {
  name: string;
  query: string;
}

const CATS_ALL = '(cat:q-fin.PM+OR+cat:q-fin.ST+OR+cat:q-fin.TR)';
const CATS_CORE = '(cat:q-fin.PM+OR+cat:q-fin.ST)';

export const QUERIES: ArxivQuery[] = [
  {
    name: 'genel-sinyal',
    query:
      `${CATS_ALL}+AND+(all:%22trading%20strategy%22+OR+all:%22trading%20signal%22+OR+all:%22buy%20sell%22` +
      `+OR+all:%22long%20short%22+OR+all:%22directional%20prediction%22+OR+all:%22market%20timing%22)` +
      `+AND+(all:backtest+OR+all:%22out-of-sample%22+OR+all:%22walk-forward%22+OR+all:%22transaction%20costs%22)`,
  },
  {
    name: 'gunluk-maliyetli',
    query:
      `${CATS_CORE}+AND+(all:%22trading%20signal%22+OR+all:%22long%20short%22)` +
      `+AND+(all:daily+OR+all:hourly+OR+all:%22end-of-day%22)` +
      `+AND+(all:backtest+OR+all:%22out-of-sample%22)` +
      `+AND+(all:%22transaction%20costs%22+OR+all:slippage)`,
  },
  {
    name: 'momentum',
    query:
      `${CATS_ALL}+AND+(all:%22time%20series%20momentum%22+OR+all:%22cross-sectional%20momentum%22` +
      `+OR+all:%22trend%20following%22)+AND+(all:backtest+OR+all:%22transaction%20costs%22)`,
  },
  {
    name: 'ortalamaya-donus',
    query:
      `${CATS_ALL}+AND+(all:%22mean%20reversion%22+OR+all:%22statistical%20arbitrage%22+OR+all:%22pairs%20trading%22)` +
      `+AND+(all:backtest+OR+all:%22out-of-sample%22)`,
  },
  {
    name: 'rejim-volatilite',
    query:
      `${CATS_ALL}+AND+(all:%22regime%20switching%22+OR+all:%22volatility%20targeting%22` +
      `+OR+all:%22volatility%20scaling%22+OR+all:%22risk%20parity%22)+AND+(all:backtest)`,
  },
  {
    name: 'kripto-funding',
    query:
      `${CATS_ALL}+AND+(all:cryptocurrency+OR+all:bitcoin+OR+all:%22perpetual%20futures%22+OR+all:%22funding%20rate%22)` +
      `+AND+(all:%22trading%20strategy%22+OR+all:backtest)`,
  },
];

/**
 * Gecelik rotasyon: gun sayisina gore sirayla. Ilk iki sorgu her gece kosar (cekirdek).
 *
 * Orchestrator bir yonlendirme birakmissa (orchestrator/directives.ts) o gecenin
 * listesine EK sorgular girer — rotasyonun yerine gecmez, YANINA eklenir. Sebep:
 * ust aklin bir hipotezi olmasi, cekirdek taramayi durdurmayi gerektirmez; ikisi ayni
 * havuza akar ve secim yine tum havuz uzerinde yapilir (selector.ts:28).
 *
 * Yonlendirme yoksa donen liste bugunkuyle BIREBIR aynidir.
 */
export function queriesForNight(dayIndex: number): ArxivQuery[] {
  const core = QUERIES.slice(0, 2);
  const rotating = QUERIES.slice(2);
  const pick = rotating[dayIndex % rotating.length]!;
  return [...core, pick, ...directedQueries()];
}

/**
 * Yonlendirmeden gelen sorgular.
 *
 * Metin ONCEDEN URL-KODLANMIS bir arXiv sorgusu olmali (arxiv.ts:76-83: axios'un
 * `params`i %22'yi cift kodluyor ve sorgu sessizce SIFIR makale donduruyor). Bu yuzden
 * kodlanmamis gorunen bir metin sessizce atlanmaz — konsola yazilir. Sessiz atlama,
 * "orchestrator yon verdi ama gece hicbir sey degismedi" gibi tesadufi bir sonuc
 * uretirdi ve nedeni gunlerce aranirdi.
 */
function directedQueries(): ArxivQuery[] {
  const out: ArxivQuery[] = [];

  for (const d of activeDirectives('arxiv-queries')) {
    const q = d.text.trim();
    if (/\s/.test(q)) {
      console.log(`     [yonlendirme] arXiv sorgusu atlandi (bosluk iceriyor, URL-kodlanmis olmali): ${q.slice(0, 80)}`);
      continue;
    }
    out.push({ name: `yonlendirme:${d.id}`, query: q });
  }

  return out;
}
