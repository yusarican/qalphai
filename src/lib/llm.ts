import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { sleep } from './rateLimiter';

/**
 * OpenAI-uyumlu sohbet istemcisi (LiteLLM proxy arkasinda Gemini).
 *
 * Neden ince bir istemci: tek ihtiyacimiz "sistem + kullanici mesaji ver, JSON al".
 * Bir SDK bagimliligi eklemek, bu kadari icin surum yuzeyini bosuna buyutur — axios
 * zaten projede var.
 *
 * Iki sey ONEMLI:
 *
 * 1. **JSON PARSE ETMEK BIR SOZLESMEDIR.** Model bazen ```json cite ile sarar, bazen
 *    "Iste sonuc:" diye onsoz yazar. Cagiran taraf bunu bilmek zorunda kalmamali;
 *    `chatJson` toleransli ayristirir ve zod semasiyla DOGRULAR. Sema tutmazsa hata
 *    firlatir — yari dogru bir nesneyi cagirana teslim etmek, hatayi gece dongusunun
 *    ilerisine tasimak demektir.
 *
 * 2. **HER HATA GERI CEVRILEBILIR OLMALI.** Gece dongusunun sozlesmesi "hata durumunda
 *    hicbir sey degismez". LLM cagrisi 429/5xx/timeout yerse burada yeniden denenir,
 *    denemeler biterse TEMIZ bir Error firlatir — cagiran taraf deterministik yola
 *    duser.
 */

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatArgs {
  system: string;
  user: string;
  /** Varsayilan 0: makale secimi bir yaraticilik isi degil, yargi isi. */
  temperature?: number;
  /**
   * DUSUNCE TOKEN'LARI DA BU BUTCEDEN HARCANIR.
   *
   * gemini-3.6-flash bir "thinking" modeli: iki satirlik bir cevap icin bile birkac yuz
   * token dusunebiliyor ve bu, `max_tokens` icinden gidiyor. Butce dar olursa model
   * dusunurken biter — `finish_reason: length` ve YARIM ya da BOS bir JSON doner.
   * Bu yuzden varsayilan comert tutuldu; model zaten kisa cevap veriyorsa fazlasi
   * harcanmaz.
   */
  maxTokens?: number;
  /**
   * `low` dusunmeyi kisar, `minimal` neredeyse tamamen kapatir. Sig ve tekrarli isler
   * (grup triaji) icin dusuk; asil yargi gerektiren tek secim icin varsayilan.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Etiket yalnizca loglama icin — hangi asamanin token yaktigi gorunsun. */
  label?: string;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const MAX_ATTEMPTS = 3;

/**
 * LLM yapilandirilmis mi? Degilse cagiran taraf deterministik yola dusmeli.
 *
 * Olcut ANAHTAR degil ADRES: proxy anahtarsiz da cevap veriyor ve anahtar sartina
 * baglamak, calisan bir kurulumu bos bir env satiri yuzunden kor moda dusururdu.
 * LLM'i kapatmak isteyen LLM_BASE_URL'i bosaltir.
 */
export function llmConfigured(): boolean {
  return env.llm.baseUrl !== '';
}

export async function chat(args: ChatArgs): Promise<string> {
  return chatRaw(args, true);
}

/**
 * JSON bekleyen cagri: toleransli ayristirir, zod ile dogrular.
 *
 * `schema` zorunlu — "any dondur, cagiran bakar" bu dosyada bilerek YOK. Modelin
 * cikardigi bir alan (ornegin bos `hypothesis`) sessizce Codex brief'ine sizarsa,
 * gecenin neden bos gectigini gunler sonra ariyor oluruz.
 */
export async function chatJson<T>(
  args: ChatArgs & { schema: { parse: (v: unknown) => T } },
): Promise<T> {
  const text = await chatRaw(args, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    throw new LlmError(`model gecerli JSON dondurmedi: ${(err as Error).message} | ham: ${text.slice(0, 300)}`);
  }
  try {
    return args.schema.parse(parsed);
  } catch (err) {
    throw new LlmError(`model JSON'u semaya uymuyor: ${(err as Error).message}`);
  }
}

async function chatRaw(args: ChatArgs, json: boolean): Promise<string> {
  if (!llmConfigured()) {
    throw new LlmError('LLM_BASE_URL tanimli degil');
  }

  const url = `${env.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: env.llm.model,
    temperature: args.temperature ?? 0,
    max_tokens: args.maxTokens ?? 8_192,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  };
  if (json) body.response_format = { type: 'json_object' };
  if (args.reasoningEffort) body.reasoning_effort = args.reasoningEffort;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post<ChatCompletion>(url, body, {
        headers: {
          'Content-Type': 'application/json',
          // Proxy anahtarsiz da cevap veriyor; anahtar varsa gonderilir, yoksa
          // bos bir Bearer basligi gondermenin anlami yok.
          ...(env.llm.apiKey ? { Authorization: `Bearer ${env.llm.apiKey}` } : {}),
        },
        timeout: env.llm.timeoutMs,
      });

      const choice = res.data.choices?.[0];
      const content = choice?.message?.content;
      const u = res.data.usage;

      /**
       * `length` = model butceyi bitirdi. Dusunce token'lari da bu butceden gittigi icin
       * bu, "cevap uzun oldu"dan cok "model dusunurken bitti" anlamina gelir ve geriye
       * yarim JSON kalir. Ayni istegi tekrarlamak ayni yere varir — max_tokens veya
       * reasoningEffort ayarlanmali. Sessizce yarim JSON ayristirmaya calismaktansa
       * NEDENINI soyleyerek dusuyoruz.
       */
      if (choice?.finish_reason === 'length') {
        const think = u?.completion_tokens_details?.reasoning_tokens;
        throw new LlmError(
          `cevap token butcesine (${body.max_tokens}) takildi` +
            (think ? ` — ${think} token dusunmeye gitti` : '') +
            '; maxTokens artirilmali veya reasoningEffort dusurulmeli',
        );
      }

      if (!content?.trim()) throw new LlmError('model bos cevap dondu');

      if (args.label) {
        const think = u?.completion_tokens_details?.reasoning_tokens;
        console.log(
          `     [llm] ${args.label}: ${u?.prompt_tokens ?? '?'} in / ${u?.completion_tokens ?? '?'} out` +
            (think ? ` (${think} dusunce)` : ''),
        );
      }
      return content;
    } catch (err) {
      lastErr = err;

      // Protokol hatalari (bos cevap, butce asimi) DETERMINISTIK: temperature 0 ile ayni
      // istek ayni yere varir. Yeniden denemek yalnizca gecikme ve token yakar.
      if (err instanceof LlmError) break;

      const status = (err as AxiosError).response?.status;

      /**
       * response_format desteklenmiyorsa (proxy/model kombinasyonuna gore degisir)
       * bir kez de onsuz dene: prompt zaten "yalnizca JSON dondur" diyor, JSON modu
       * bir garanti degil kolaylik. Bunu denememek, tum LLM yolunu tek bir 400 ile
       * kapatmak olurdu.
       */
      if (status === 400 && body.response_format) {
        delete body.response_format;
        continue;
      }

      // 4xx (429 disi) yeniden denemeye degmez: istek yanlis, tekrari da yanlis olur.
      if (status && status < 500 && status !== 429) break;
      if (attempt === MAX_ATTEMPTS) break;

      await sleep(1_000 * 2 ** (attempt - 1));
    }
  }

  const status = (lastErr as AxiosError)?.response?.status;
  const detail = describe(lastErr);
  throw new LlmError(`LLM cagrisi basarisiz (${env.llm.model}): ${detail}`, status);
}

/**
 * Cevabin icinden JSON govdesini cikarir.
 *
 * Sirasiyla: ```json citesi -> ilk `{`/`[` ile son `}`/`]` arasi -> ham metin.
 * "Model duzgun cevap versin" diye prompt'a guvenmek yerine burada tolerans gostermek,
 * gecede bir turu bosa harcamaktan ucuzdur.
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();

  const first = body.search(/[{[]/);
  if (first === -1) return body;

  const opener = body[first];
  const closer = opener === '{' ? '}' : ']';
  const last = body.lastIndexOf(closer);

  return last > first ? body.slice(first, last + 1) : body;
}

function describe(err: unknown): string {
  const ax = err as AxiosError<{ error?: { message?: string } }>;
  if (ax?.isAxiosError) {
    const status = ax.response?.status;
    const apiMsg = ax.response?.data?.error?.message;
    if (status) return `HTTP ${status}${apiMsg ? ` — ${apiMsg}` : ''}`;
    return ax.code === 'ECONNABORTED' ? `zaman asimi (${env.llm.timeoutMs}ms)` : ax.message;
  }
  return err instanceof Error ? err.message : String(err);
}
