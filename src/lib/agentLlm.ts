import axios, { AxiosError } from 'axios';
import { anthropic } from './providers/anthropic';
import { gemini } from './providers/gemini';
import { openaiCompat } from './providers/openaiCompat';
import { backoffMs, sleep } from './rateLimiter';
import { env } from '../config/env';
import type { AgentMessage, AgentTurn, Provider, ToolSpec } from './providers/types';

export type {
  AgentMessage,
  AgentTurn,
  ContentBlock,
  JsonSchema,
  StopReason,
  ToolSpec,
  ToolUse,
} from './providers/types';

/**
 * TOOL CAGIRABILEN LLM ISTEMCISI — orchestrator'in tek model kapisi.
 *
 * `lib/llm.ts` DURUYOR ve DOKUNULMADI: makale secici onun uzerinde kosuyor,
 * tests/paperSelector.test.ts onu mock'luyor ve isi farkli (system+user -> JSON).
 * Burada gereken sey baska: cok turlu, tool cagirabilen, uc saglayiciya konusabilen
 * bir istemci. Ikisini tek dosyada birlestirmek, calisan bir yolu kosullarla dolu bir
 * yola cevirirdi.
 *
 * llm.ts'ten AYNEN TASINAN iki davranis — ikisi de zor kazanildi:
 *
 *   1. **Her hata geri cevrilebilir olmali.** 429/5xx/timeout uzerine ustel backoff,
 *      4xx (429 disi) uzerine denemeden dus (istek yanlissa tekrari da yanlis olur).
 *
 *   2. **Token butcesi bitisi SESSIZCE yutulmaz** (llm.ts:150). Dusunce token'lari da
 *      ayni butceden gittigi icin `max_tokens` genelde "cevap uzun oldu" degil "model
 *      dusunurken bitti" demektir; geriye yarim bir tur kalir. Ayni istegi tekrarlamak
 *      ayni yere varir — nedenini soyleyerek dusuyoruz.
 */

export class AgentLlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AgentLlmError';
  }
}

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

const PROVIDERS: Record<ProviderName, Provider> = {
  anthropic,
  openai: openaiCompat,
  gemini,
};

const MAX_ATTEMPTS = 3;

/**
 * Orchestrator yapilandirilmis mi?
 *
 * ADRES degil ANAHTAR olcut aliniyor — llm.ts'in tersine. Sebep: env.llm bir proxy'ye
 * bakiyor ve proxy anahtarsiz da cevap veriyor; orchestrator ise dogrudan saglayiciya
 * gidiyor ve anahtarsiz hicbiri cevap vermiyor. Ayrica ORCH_ENABLED acikca kapali
 * olabilir: kapaliyken sistem bugunku davranisini BIT BIT korumali.
 */
export function orchestratorConfigured(): boolean {
  return env.orchestrator.enabled && env.orchestrator.apiKey !== '';
}

export function providerFor(name: ProviderName): Provider {
  const p = PROVIDERS[name];
  if (!p) throw new AgentLlmError(`bilinmeyen saglayici: ${name} (anthropic | openai | gemini)`);
  return p;
}

export interface AgentTurnArgs {
  system: string;
  messages: readonly AgentMessage[];
  tools?: readonly ToolSpec[];
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  /** Varsayilan 0: orchestrator bir yaraticilik degil YARGI isi (llm.ts:36 ile ayni gerekce). */
  temperature?: number;
  /** Log etiketi — hangi asamanin token yaktigi gorunsun. */
  label?: string;
}

export async function agentTurn(args: AgentTurnArgs): Promise<AgentTurn> {
  const name = args.provider ?? env.orchestrator.provider;
  const provider = providerFor(name);

  const apiKey = args.apiKey ?? env.orchestrator.apiKey;
  if (!apiKey) {
    throw new AgentLlmError(`ORCH_API_KEY tanimli degil (saglayici ${name})`);
  }

  const call = provider.toCall({
    model: args.model ?? env.orchestrator.model,
    baseUrl: args.baseUrl || env.orchestrator.baseUrl || provider.defaultBaseUrl,
    apiKey,
    system: args.system,
    messages: args.messages,
    tools: args.tools ?? [],
    maxTokens: args.maxTokens ?? env.orchestrator.maxTokens,
    temperature: args.temperature ?? 0,
  });

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(call.url, call.body, {
        headers: call.headers,
        timeout: env.orchestrator.timeoutMs,
      });

      const turn = provider.fromResponse(res.data);

      if (turn.stopReason === 'max_tokens') {
        throw new AgentLlmError(
          `cevap token butcesine (${args.maxTokens ?? env.orchestrator.maxTokens}) takildi — ` +
            'ORCH_MAX_TOKENS artirilmali. Yarim bir tur ayristirmak yerine duruyoruz.',
        );
      }

      if (!turn.text && turn.toolUses.length === 0) {
        throw new AgentLlmError('model bos tur dondu (ne metin ne tool cagrisi)');
      }

      if (args.label) {
        console.log(
          `     [orch:${name}] ${args.label}: ${turn.usage.inTokens} in / ${turn.usage.outTokens} out` +
            (turn.toolUses.length ? ` | ${turn.toolUses.length} tool` : ''),
        );
      }

      return turn;
    } catch (err) {
      lastErr = err;

      // Protokol hatalari DETERMINISTIK: temperature 0 ile ayni istek ayni yere varir.
      // Yeniden denemek yalnizca gecikme ve token yakar.
      if (err instanceof AgentLlmError) break;

      const status = (err as AxiosError).response?.status;
      if (status && status < 500 && status !== 429) break;
      if (attempt === MAX_ATTEMPTS) break;

      await sleep(backoffMs(attempt - 1));
    }
  }

  const status = (lastErr as AxiosError)?.response?.status;
  throw new AgentLlmError(
    `orchestrator LLM cagrisi basarisiz (${name}/${args.model ?? env.orchestrator.model}): ${describe(lastErr)}`,
    status,
  );
}

function describe(err: unknown): string {
  const ax = err as AxiosError<{ error?: { message?: string }; message?: string }>;
  if (ax?.isAxiosError) {
    const status = ax.response?.status;
    const data = ax.response?.data;
    const apiMsg = data?.error?.message ?? data?.message;
    if (status) return `HTTP ${status}${apiMsg ? ` — ${apiMsg}` : ''}`;
    return ax.code === 'ECONNABORTED' ? `zaman asimi (${env.orchestrator.timeoutMs}ms)` : ax.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- mesaj kurucular

export function userText(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistantTurn(turn: AgentTurn): AgentMessage {
  const content: AgentMessage['content'] = [];
  if (turn.text) content.push({ type: 'text', text: turn.text });
  for (const t of turn.toolUses) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
  }
  return { role: 'assistant', content };
}

export function toolResults(
  results: Array<{ id: string; name: string; content: string; isError?: boolean }>,
): AgentMessage {
  return {
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result' as const,
      toolUseId: r.id,
      name: r.name,
      content: r.content,
      ...(r.isError ? { isError: true } : {}),
    })),
  };
}
