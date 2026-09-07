import axios from 'axios';
import { env } from '../config/env';

/**
 * WEB ARAMASI — otopsinin ucuncu ve en az guvenilir kaynagi.
 *
 * "O donemde piyasada ne oldu?" sorusunun bir kismi turetilebilir sayilarla
 * (engine/marketContext.ts) cevaplanamaz: bir borsanin cokmesi, bir regulasyon karari,
 * bir likidasyon kaskadi. Bu katman onun icin.
 *
 * UC KURAL:
 *
 *  1. **Opsiyonel.** ORCH_WEB_SEARCH_PROVIDER bos ise tool orchestrator'a HIC verilmez
 *     (agent/tools.ts). Anahtarsiz kurulumda otopsi eksiksiz calisir, sadece daha dar.
 *
 *  2. **Deterministik DEGIL ve oyle etiketlenir.** Ayni sorgu yarin baska sonuc verebilir.
 *     Sonuclar rapora KAYNAK URL'siyle yazilir; ozet olarak degil alinti olarak.
 *
 *  3. **Kanit degil IPUCU.** Bir otopsi hipotezi web sonucuna dayaniyorsa, rapor bunu
 *     acikca soyler. Bir sayi web'den gelemez — sayilar market.db'den gelir.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Saglayici verirse yayin tarihi. */
  published?: string;
}

export interface SearchResponse {
  provider: string;
  query: string;
  results: SearchResult[];
  unavailable?: string;
}

export function webSearchConfigured(): boolean {
  return env.orchestrator.webSearchProvider !== '' && env.orchestrator.webSearchKey !== '';
}

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 8;

export async function webSearch(query: string): Promise<SearchResponse> {
  const provider = env.orchestrator.webSearchProvider;
  const base: SearchResponse = { provider: provider || '(kapali)', query, results: [] };

  if (!webSearchConfigured()) {
    return { ...base, unavailable: 'ORCH_WEB_SEARCH_PROVIDER / ORCH_WEB_SEARCH_KEY tanimli degil' };
  }

  try {
    switch (provider) {
      case 'brave':
        return { ...base, results: await brave(query) };
      case 'tavily':
        return { ...base, results: await tavily(query) };
      case 'exa':
        return { ...base, results: await exa(query) };
      default:
        return { ...base, unavailable: `bilinmeyen saglayici: ${provider}` };
    }
  } catch (err) {
    // Otopsi disari cevap vermedigi icin durmaz.
    return { ...base, unavailable: `arama basarisiz: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function brave(q: string): Promise<SearchResult[]> {
  const res = await axios.get<{ web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } }>(
    'https://api.search.brave.com/res/v1/web/search',
    {
      params: { q, count: MAX_RESULTS },
      headers: { Accept: 'application/json', 'X-Subscription-Token': env.orchestrator.webSearchKey },
      timeout: TIMEOUT_MS,
    },
  );
  return (res.data.web?.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: strip(r.description ?? ''),
    ...(r.age ? { published: r.age } : {}),
  }));
}

async function tavily(q: string): Promise<SearchResult[]> {
  const res = await axios.post<{ results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> }>(
    'https://api.tavily.com/search',
    { query: q, max_results: MAX_RESULTS, api_key: env.orchestrator.webSearchKey },
    { timeout: TIMEOUT_MS },
  );
  return (res.data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: strip(r.content ?? ''),
    ...(r.published_date ? { published: r.published_date } : {}),
  }));
}

async function exa(q: string): Promise<SearchResult[]> {
  const res = await axios.post<{ results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }> }>(
    'https://api.exa.ai/search',
    { query: q, numResults: MAX_RESULTS, contents: { text: { maxCharacters: 600 } } },
    { headers: { 'x-api-key': env.orchestrator.webSearchKey }, timeout: TIMEOUT_MS },
  );
  return (res.data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: strip(r.text ?? ''),
    ...(r.publishedDate ? { published: r.publishedDate } : {}),
  }));
}

/** HTML etiketlerini ve fazla boslugu atar — snippet'ler prompt'a giriyor. */
function strip(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}
