/**
 * SAGLAYICI SOZLESMESI — Anthropic / OpenAI-uyumlu / Gemini icin ortak sekil.
 *
 * Neden bir soyutlama: orchestrator'in tool dongusu (orchestrator/agent/loop.ts) UC
 * saglayicinin hicbirini tanimamali. Uc API'nin tool cagri sekli birbirinden farkli
 * (content block / tool_calls / functionCall) ve bu farkin donguye sizmasi, saglayici
 * degistirmeyi donguyu yeniden yazmak haline getirirdi.
 *
 * Neden SDK degil axios: TECHSTACK'teki "Deliberate non-choices" tablosu — ihtiyac
 * "mesaj gonder, tool cagrisi al" ve axios zaten projede. Uc SDK eklemek surum yuzeyini
 * uc katina cikarirdi.
 */

/** JSON Schema govdesi. Tool parametrelerini tarif eder. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  /** snake_case, saglayicilarin tamaminda gecerli. */
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
}

export interface ToolUse {
  /** Saglayicinin verdigi kimlik. Gemini vermez; uretiriz (bkz. gemini.ts). */
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      /**
       * Tool ADI sonucta da tasinir. Anthropic ve OpenAI yalnizca id ile eslestirir ama
       * Gemini'nin functionResponse'u ADLA eslesir — id yoktur. Adi burada tasimazsak
       * dongude id -> ad haritasi tutmak gerekirdi ve o harita, gecmisi yeniden kuran
       * her yolda (state.ts'ten devam etme) yeniden uretilmek zorunda kalirdi.
       */
      readonly name: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface AgentMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ContentBlock[];
}

/** Neden durduk. `max_tokens` SESSIZCE yutulmaz (bkz. lib/llm.ts:150). */
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'other';

export interface AgentTurn {
  readonly text: string;
  readonly toolUses: ToolUse[];
  readonly stopReason: StopReason;
  readonly usage: { readonly inTokens: number; readonly outTokens: number };
}

export interface TurnRequest {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly system: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
  readonly temperature: number;
}

export interface HttpCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface Provider {
  readonly name: 'anthropic' | 'openai' | 'gemini';
  /** ORCH_BASE_URL bos birakildiginda kullanilir. */
  readonly defaultBaseUrl: string;
  toCall(req: TurnRequest): HttpCall;
  fromResponse(data: unknown): AgentTurn;
}

/** Sondaki egik cizgileri atar — `${base}/v1/messages` iki cizgiye donusmesin. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}
