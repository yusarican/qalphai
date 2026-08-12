import { XMLParser } from 'fast-xml-parser';
import axios from 'axios';
import { sleep } from '../lib/rateLimiter';

/**
 * arXiv Atom API istemcisi.
 *
 * SADECE ABSTRACT cekilir, PDF asla. Baslik + ozet, bir "fikir karti" uretmeye yeter;
 * PDF ayristirmanin cehennemine ve ToS gri bolgesine girmeye gerek yok.
 *
 * Hiz siniri: arXiv istekler arasi >= 3sn ister ve asilirsa 429 degil 503 doner.
 * Modul seviyesinde tek-siralik (single-flight) bir kuyruk bunu ZORLAR — cagiran taraf
 * unutsa bile.
 */

const BASE = 'http://export.arxiv.org/api/query';
const MIN_GAP_MS = 3_000;
const USER_AGENT = 'tradecraftai/0.1 (arastirma amacli; iletisim: repo sahibi)';

export interface ArxivPaper {
  /** Surumsuz kimlik: '2401.01234' */
  id: string;
  version: number;
  title: string;
  summary: string;
  authors: string[];
  published: number;
  updated: number;
  categories: string[];
  absUrl: string;
}

// --- Tek siralı kuyruk: iki cagri ayni anda arXiv'e gidemez ----------------------

let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Zincir hata yerse kopmasin.
  chain = run.catch(() => undefined);
  return run;
}

interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  author?: { name: string } | Array<{ name: string }>;
  category?: { '@_term': string } | Array<{ '@_term': string }>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/** `http://arxiv.org/abs/2401.01234v2` -> { id: '2401.01234', version: 2 } */
function parseId(raw: string): { id: string; version: number } {
  const tail = raw.split('/abs/')[1] ?? raw;
  const m = tail.match(/^(.+?)v(\d+)$/);
  if (m) return { id: m[1]!, version: Number(m[2]) };
  return { id: tail, version: 1 };
}

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * `query` ONCEDEN URL-ENCODE EDILMIS olarak beklenir (queries.ts'teki gibi: `%22`, `+AND+`).
 *
 * Bu yuzden URL elle kuruluyor: axios'un `params` secenegi ona verileni bir kez daha
 * encode eder (`%22` -> `%2522`, `+` -> `%2B`) ve arXiv sorguyu tanimaz — sessizce
 * SIFIR makale doner. Ilk denemede tam olarak bu oldu: hata yok, sonuc yok. Gece
 * dongusunde bu, "bugun ilginc makale cikmamis" gibi gorunurdu.
 */
export async function searchArxiv(query: string, maxResults = 100): Promise<ArxivPaper[]> {
  return throttled(async () => {
    const url =
      `${BASE}?search_query=${query}` +
      `&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

    const res = await axios.get<string>(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30_000,
      responseType: 'text',
      // arXiv asiri yukte 503 doner (429 degil) — axios'un atmasini engelleyip elle ele aliyoruz.
      validateStatus: (s) => s < 600,
    });

    if (res.status === 503) {
      throw new Error('arXiv 503 (asiri yuk) — gece dongusu havuzdaki eski makalelerle devam eder');
    }
    if (res.status >= 400) {
      throw new Error(`arXiv HTTP ${res.status}`);
    }

    const feed = parser.parse(res.data)?.feed;
    const entries = asArray<AtomEntry>(feed?.entry);

    return entries.map((e): ArxivPaper => {
      const { id, version } = parseId(String(e.id));
      return {
        id,
        version,
        title: clean(String(e.title)),
        summary: clean(String(e.summary)),
        authors: asArray(e.author).map((a) => a.name),
        published: Date.parse(e.published),
        updated: Date.parse(e.updated),
        categories: asArray(e.category).map((c) => c['@_term']),
        absUrl: `https://arxiv.org/abs/${id}`,
      };
    });
  });
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
