import { z } from 'zod';
import { chatJson, llmConfigured } from '../lib/llm';
import { rankPapers } from './ranker';
import { env } from '../config/env';
import type { ArxivPaper } from './arxiv';

/**
 * GECENIN MAKALESINI SECEN KATMAN — artik anahtar kelime degil, YARGI.
 *
 * Neden degisti: deterministik siralayici (ranker.ts) "uygulanabilirlik" sorusunu
 * kelime sayarak cevapliyordu ve bu soru kelimeyle cevaplanmiyor. Ilk gercek kosuda
 * siralayici, Fama-French faktor tahsisi uzerine bir makaleye EN YUKSEK skoru verdi
 * (icinde momentum + market timing + walk-forward + transaction cost geciyordu),
 * Codex makaleyi okuyup dogru sekilde "bu bizim sozlesmede yazilamaz" dedi ve gece
 * bos gecti. Bir kelime listesi bunu ONLEYEMEZ: "momentum" gecen bir ETF makalesiyle
 * "momentum" gecen bir perpetual futures makalesi, kelime duzeyinde ayni gorunur.
 *
 * Bunun tersi de dogru ve daha pahali: kara liste, KULLANILABILIR makaleleri de
 * eliyordu. "deep learning" gecen bir makale genelde bizim icin uygulanamaz — ama
 * ayni makalenin ozelliklerinden biri basit bir volatilite rejim filtresiyse, o
 * filtre bizim sozlesmede pekala yazilabilir. Kelime listesi bu farki goremez.
 *
 * TASARIM: iki asama (map-reduce).
 *
 *   1. TRIAJ — tum havuz, 20'lik gruplar halinde, kisaltilmis abstract'larla. Model
 *      her makaleye uygulanabilir mi + 0-10 skor + tek cumle gerekce verir. Ucuz ve
 *      paralel.
 *   2. FINAL — triajdan gecen ilk birkac makale (FINALIST_COUNT), TAM abstract'lariyla
 *      tek bir cagrida yan yana konur ve model ICINDEN BIRINI secer.
 *
 * Neden tek cagrida 300 makale degil: modelin 300 abstract arasindan "en iyisini" sec-
 * mesi, dikkatin en zayif oldugu istir. Triaj her makaleye ayri ayri bakar (kolay is),
 * final ise az sayida guclu adayi karsilastirir (asil yargi). Bir asamada yapilirsa
 * secim, listenin basindaki makalelere kayar.
 *
 * SECIM SONUCU BIR HIPOTEZ DE TASIR. Model yalnizca "bu makale" demez; edge'in ne
 * oldugunu ve bizim sozlesmede NASIL ifade edilecegini de yazar. Bu, Codex'in brief'ine
 * girer — yoksa Codex ayni okuma isini bastan yapar ve turunun bir kismini abstract'i
 * cozmeye harcar.
 *
 * Abstract YETER, PDF cekilmez: karar verdigimiz soru "bu edge bizim sozlesmede ifade
 * edilebilir mi" ve abstract bunu neredeyse her zaman ele veriyor. Makalenin detayini
 * okumak Codex'in isi, secicinin degil.
 */

/** Triaj grubu basina makale. Buyutmek cagri sayisini dusurur ama dikkati de dusurur. */
const TRIAGE_BATCH = 20;
/** Es zamanli triaj cagrisi. Proxy'yi bogmadan gecenin bekleme suresini kisaltir. */
const TRIAGE_CONCURRENCY = 3;
/** Finale kalan aday sayisi. */
const FINALIST_COUNT = 6;
/** Triaj skoru bu esigin altindaki makale finale bile girmez. */
const TRIAGE_MIN_SCORE = 6;
/** Triajda gonderilen abstract kirpma uzunlugu (final turunda kirpilmaz). */
const TRIAGE_ABSTRACT_CHARS = 1_200;

export interface PaperPick {
  paper: ArxivPaper;
  /** 0-10. LLM yolunda modelin skoru; yedek yolda deterministik skor. */
  score: number;
  /** Neden bu makale secildi. */
  reason: string;
  /** Makalenin one surdugu edge — *piyasada ne oluyor da bu para kazanmali?* */
  hypothesis: string;
  /** Edge'in BIZIM sozlesmemizde nasil ifade edilecegi. */
  angle: string;
  /** Kararin kim tarafindan verildigi — rapor bunu gostermeli. */
  by: 'llm' | 'heuristic';
}

const CONTRACT = `
SOZLESMEMIZ (bir makalenin uygulanabilir olmasi icin buna sigmasi gerekir):

- Karar birimi: TEK SEMBOL, TEK MUM. Her mum kapanisinda strateji su karari verir:
  LONG gir / SHORT gir / girme (veto). Baska bir cikti YOKTUR.
- Girdiler: OHLCV mumlari (4 saatlik) ve bunlardan turetilen indikatorler — RSI, MACD,
  Bollinger, EMA/SMA, ATR, ADX/DI, Stochastic, Fibonacci seviyeleri, mum formasyonlari,
  5 katmanli kompozit skor — ayrica funding orani, makro risk istahi ve BTC rejimi.
- Evren: Binance USD-M perpetual futures, ~6 major kripto sembolu.
- Strateji pozisyon boyutu, kaldirac, take-profit veya stop-loss BELIRLEYEMEZ. Bunlari
  harness ayrica optimize eder. Makalenin katkisi GIRIS/YON mantiginda olmali.
- Strateji DURUMSUZDUR: mumlar arasi hafiza tutamaz, ayni baglam her zaman ayni karari
  verir. Egitim gerektiren, online ogrenen veya gecmis kararlarini hatirlamasi gereken
  yontemler uygulanamaz.
- Aday, islem maliyeti stresinden (fee x1.5, slippage x2) gecmek zorunda: cok yuksek
  frekansli edge'ler burada olur.

UYGULANAMAZ demek zorunda oldugun tipik durumlar:
- Erisilemez veri isteyenler: limit order book, tick verisi, order-flow imbalance,
  opsiyon yuzeyi/implied volatility, haber/sosyal medya metni, alternatif veri.
- Yanlis karar tipi: portfoy agirliklandirma, varlik tahsisi, faktor portfoyu kurma,
  hisse cross-section'i, ETF/tahvil/emtia evreni — bizim ciktimiz tek sembolde yondur.
- Agir egitim gerektirenler: derin ogrenme, pekistirmeli ogrenme, sik yeniden egitilen
  modeller. (Makalenin ANA yontemi bu ise uygulanamaz. Ama makale bunun yaninda basit,
  kural haline getirilebilir bir sinyal/filtre de tarif ediyorsa, uygulanabilir sayilir
  ve bunu gerekcede SOYLE.)

ONEMLI: kelimeye degil, MEKANIZMAYA bak. Icinde "momentum" gecen bir ETF tahsis
makalesi bizim icin uygulanamaz; icinde "deep learning" gecen bir makalenin kural
haline getirilebilir bir rejim filtresi varsa uygulanabilir. Sen bu farki gormek icin
varsin.
`;

const TRIAGE_SYSTEM = `Sen bir kripto perpetual futures quant ekibinin arastirma triajcisisin.
Sana arXiv'den gelen makalelerin baslik ve ozetleri veriliyor. Her biri icin TEK soruyu
cevapliyorsun: bu makalenin one surdugu edge, bizim sozlesmemizde bir giris kuralina
cevrilebilir mi?
${CONTRACT}

Her makale icin ver:
- feasible: sozlesmemizde ifade edilebilir mi
- score: 0-10. Yalnizca "iyi makale mi" degil, BIZIM ICIN NE KADAR DEGERLI.
  0-3 uygulanamaz veya alakasiz | 4-5 uygulanabilir ama zayif/asikar
  6-7 uygulanabilir ve somut bir giris kurali oneriyor
  8-10 uygulanabilir, somut, ve maliyet/asiri uydurma konusunda ciddi (out-of-sample,
  walk-forward, islem maliyeti dikkate alinmis)
- reason: tek cumle, TURKCE. Mekanizmayi soyle, makaleyi ozetleme.

Comert davranma: cogu makale 0-3 almalidir. Yuksek skor, gecenin tamamini o makaleye
harcayacagimiz anlamina gelir.

YALNIZCA su semada JSON dondur, baska hicbir metin yazma:
{"papers":[{"n":<makale numarasi>,"feasible":<bool>,"score":<0-10>,"reason":"<tek cumle>"}]}
Girdideki HER makale icin tam bir kayit dondur.`;

const FINAL_SYSTEM = `Sen bir kripto perpetual futures quant ekibinin bas arastirmacisisin.
On elemeden gecmis birkac makale veriliyor. GORevin: bu gece uzerinde calisilacak TEK
makaleyi secmek ve onu uygulayacak muhendise hazir bir baslangic noktasi vermek.
${CONTRACT}

Secim olcutun, "en prestijli makale" degil, **bu gece calisan bir strateji cikma
olasiligi en yuksek makale**: edge'i somut, kurala cevrilebilir, ve mevcut mekanik
sisteme gercek bir FIKIR ekliyor (esik degeri oynatmaktan ibaret degil).

Adaylarin HICBIRI sozlesmemize sigmiyorsa n=0 dondur. Bu bir basarisizlik degildir;
uydurma bir secim yapmak, gecenin tamamini bosa harcamaktir.

YALNIZCA su semada JSON dondur, baska hicbir metin yazma:
{"n":<secilen makale numarasi, hicbiri uygunsa 0>,
 "score":<0-10 guven>,
 "hypothesis":"<edge tek cumlede: piyasada ne oluyor da bu para kazanmali? mekanizmayi soyle>",
 "angle":"<bizim sozlesmemizde nasil ifade edilir: hangi indikator/kosul, hangi yonde, hangi rejimde. 2-4 cumle, somut.>",
 "reason":"<neden digerleri degil de bu. tek cumle.>"}
Tum metin alanlari TURKCE.`;

const triageSchema = z.object({
  papers: z.array(
    z.object({
      n: z.number().int(),
      feasible: z.boolean(),
      score: z.number(),
      reason: z.string().default(''),
    }),
  ),
});

const finalSchema = z.object({
  n: z.number().int(),
  score: z.number().optional(),
  hypothesis: z.string().optional(),
  angle: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Gecenin makalesini secer. Hicbir uygun makale yoksa `null` doner (gece REFINE'a duser).
 *
 * LLM yolu coktugunde FIRLATMAZ: deterministik siralayiciya duser ve bunu `by` alaninda
 * bildirir. Secici, gece dongusunu durdurabilecek bir bilesen olmamali — makale secmek
 * gecenin en degerli ama en vazgecilebilir adimidir.
 */
export async function selectPaper(
  papers: ArxivPaper[],
  seen: ReadonlySet<string>,
): Promise<{ pick: PaperPick | null; note: string }> {
  const pool = dedupe(papers).filter((p) => !seen.has(p.id));
  if (pool.length === 0) return { pick: null, note: 'havuzda yeni makale yok' };

  // En yeniden eskiye: tavana takilirsak kirpilan taraf eski makaleler olsun.
  pool.sort((a, b) => b.published - a.published);
  const considered = pool.slice(0, env.llm.maxPapers);

  if (!llmConfigured()) {
    return fallback(considered, 'LLM_BASE_URL bos');
  }

  try {
    const shortlist = await triage(considered);
    if (shortlist.length === 0) {
      return {
        pick: null,
        note: `${considered.length} makale triajdan gecirildi, hicbiri uygulanabilir degil`,
      };
    }

    const finalists = shortlist.slice(0, FINALIST_COUNT);
    const chosen = await finalPick(finalists);

    if (!chosen) {
      return {
        pick: null,
        note: `${considered.length} makale tarandi, ${shortlist.length} aday finale kaldi, model hicbirini secmedi`,
      };
    }

    return {
      pick: chosen,
      note: `${considered.length} makale tarandi -> ${shortlist.length} aday -> arXiv:${chosen.paper.id} (skor ${chosen.score}/10)`,
    };
  } catch (err) {
    return fallback(considered, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------- 1. TRIAJ

interface Triaged {
  paper: ArxivPaper;
  score: number;
  reason: string;
}

interface BatchResult {
  rows: Triaged[];
  failed: string | null;
}

/**
 * TUM gruplar coktuyse FIRLATIR — bu bir eleme sonucu degil, bir kesintidir.
 *
 * Ayrimi yapmazsak proxy'nin komple cokmesi "bu gece uygulanabilir makale yok" gibi
 * gorunur: gece sessizce REFINE'a duser, rapor saglikli okunur ve haftalarca LLM'siz
 * kostugumuzu kimse fark etmez. Kesinti yedek yola dusmeli, elemeye benzememeli.
 */
async function triage(papers: ArxivPaper[]): Promise<Triaged[]> {
  const batches = chunk(papers, TRIAGE_BATCH);
  const results = await mapLimit(batches, TRIAGE_CONCURRENCY, triageBatch);

  const failures = results.filter((r) => r.failed);
  if (failures.length === results.length) {
    throw new Error(`triajin tamami basarisiz (${failures.length} grup): ${failures[0]!.failed}`);
  }
  if (failures.length > 0) {
    console.log(`     [llm] ${failures.length}/${results.length} triaj grubu atlandi`);
  }

  return results
    .flatMap((r) => r.rows)
    .filter((t) => t.score >= TRIAGE_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * Tek grup triaj. Grup coktugunde FIRLATMAZ, hatayi RAPOR EDER (bkz. `triage`).
 *
 * 15 gruptan biri zaman asimina ugradi diye gecenin makale secimini iptal etmek
 * orantisiz olurdu; ama 15'in 15'i dustuyse bu artik bir eleme degil, kesintidir.
 */
async function triageBatch(batch: ArxivPaper[], index: number): Promise<BatchResult> {
  const listing = batch
    .map((p, i) => `[${i + 1}] ${p.title}\n${truncate(p.summary, TRIAGE_ABSTRACT_CHARS)}`)
    .join('\n\n');

  try {
    const out = await chatJson({
      system: TRIAGE_SYSTEM,
      user: `${batch.length} makale:\n\n${listing}`,
      schema: triageSchema,
      // 20 makale x (skor + tek cumle) ~1.5k token cikti; gerisi dusunce payi.
      maxTokens: 8_192,
      // Triaj sig bir istir: her makaleye tek soru sorulur. Derin dusunme burada
      // gecenin token butcesini 15 grupla carparak yakar, kararı iyilestirmez.
      reasoningEffort: 'low',
      label: `triaj ${index + 1} (${batch.length} makale)`,
    });

    const seenN = new Set<number>();
    const rows: Triaged[] = [];

    for (const r of out.papers) {
      const paper = batch[r.n - 1];
      // Model olmayan bir numara veya ayni numarayi iki kez dondurebilir — ikisi de atilir.
      if (!paper || seenN.has(r.n)) continue;
      seenN.add(r.n);
      if (!r.feasible) continue;
      rows.push({ paper, score: clamp(r.score), reason: r.reason });
    }

    return { rows, failed: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`     [llm] triaj grubu ${index + 1} atlandi: ${detail}`);
    return { rows: [], failed: detail };
  }
}

// ---------------------------------------------------------------- 2. FINAL SECIM

async function finalPick(finalists: Triaged[]): Promise<PaperPick | null> {
  const listing = finalists
    .map(
      (t, i) =>
        `[${i + 1}] ${t.paper.title}\n` +
        `arXiv:${t.paper.id} | ${t.paper.categories.join(', ')} | ${iso(t.paper.published)}\n` +
        `On eleme notu: ${t.reason}\n\n${t.paper.summary}`,
    )
    .join('\n\n---\n\n');

  const out = await chatJson({
    system: FINAL_SYSTEM,
    user: `${finalists.length} aday:\n\n${listing}`,
    schema: finalSchema,
    maxTokens: 8_192,
    // Gecenin TEK gercek yargi ani: 6 adayi karsilastirip uygulama acisini yazmak.
    // Burada dusunmeye kisitlama koymuyoruz — tek cagri, ve ciktisi Codex'in brief'ine
    // giriyor.
    reasoningEffort: 'high',
    label: `final secim (${finalists.length} aday)`,
  });

  const chosen = finalists[out.n - 1];
  if (out.n === 0 || !chosen) return null;

  return {
    paper: chosen.paper,
    score: clamp(out.score ?? chosen.score),
    reason: out.reason?.trim() || chosen.reason,
    hypothesis: out.hypothesis?.trim() ?? '',
    angle: out.angle?.trim() ?? '',
    by: 'llm',
  };
}

// ---------------------------------------------------------------- YEDEK YOL

/**
 * LLM yolu coktugunde deterministik siralayici.
 *
 * Kor bir yol oldugunu BILEREK kullaniyoruz: kelime skoru "uygulanabilir mi" sorusunu
 * cevaplayamaz (bkz. dosya basi). Yine de anahtarsiz/proxy'siz bir gecede sistemin
 * hicbir sey denememesinden iyidir — ve rapor, kararin kimden geldigini gosterir.
 */
function fallback(papers: ArxivPaper[], why: string): { pick: PaperPick | null; note: string } {
  const ranked = rankPapers(papers)[0];
  if (!ranked) {
    return { pick: null, note: `LLM devre disi (${why}); deterministik siralayici da aday bulamadi` };
  }
  return {
    pick: {
      paper: ranked.paper,
      score: ranked.score,
      reason: `deterministik siralayici — eslesen kavramlar: ${ranked.hits.slice(0, 8).join(', ')}`,
      hypothesis: '',
      angle: '',
      by: 'heuristic',
    },
    note: `LLM devre disi (${why}) -> deterministik siralayiciya dusuldu, arXiv:${ranked.paper.id}`,
  };
}

// ---------------------------------------------------------------- yardimcilar

function dedupe(papers: ArxivPaper[]): ArxivPaper[] {
  const byId = new Map<string, ArxivPaper>();
  // Sorgular ortusur: ayni makale birden fazla sorgudan gelir ve modele iki kez
  // okutmak hem para hem de finaldeki yer israfidir.
  for (const p of papers) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(
  xs: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= xs.length) return;
      out[i] = await fn(xs[i]!, i);
    }
  });

  await Promise.all(workers);
  return out;
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0);
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}...`);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
