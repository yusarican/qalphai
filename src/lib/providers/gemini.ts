import { trimBase, type AgentTurn, type HttpCall, type JsonSchema, type Provider, type StopReason, type ToolUse, type TurnRequest } from './types';

/**
 * Google Gemini generateContent.
 *
 * Uc saglayici icinde normalize sekilden EN UZAK olani; ucu de burada yaziliyor cunku
 * ucu de sessizce yanlis calisabiliyor:
 *
 *   1. **functionCall'in KIMLIGI YOK.** Anthropic ve OpenAI her cagriya bir id verir,
 *      Gemini vermez. Sonuc, cagriya ADLA eslesir. Bu yuzden ContentBlock'un
 *      tool_result'i adi da tasiyor (providers/types.ts) ve burada id'yi biz uretiyoruz.
 *
 *   2. **Rol adi 'assistant' degil 'model'.** 'assistant' gonderilirse 400 doner.
 *
 *   3. **Sema OpenAPI ALT KUMESI.** `additionalProperties`, `$schema`, `default`,
 *      `examples` gibi alanlar reddedilir — ve hata mesaji hangi alanin sorunlu
 *      oldugunu SOYLEMEZ. Bu yuzden sema gonderilmeden once buduaniyor (sanitize).
 *      Budamayi atlarsak tool'lar calisiyor gorunur ama saglayici degistirildiginde
 *      tum tool katmani 400 ile duser.
 */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Gemini'nin OpenAPI alt kumesinde KABUL ETMEDIGI sema alanlari. */
const UNSUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  'additionalProperties',
  'default',
  'examples',
  'const',
  'oneOf',
  'allOf',
  'not',
  'patternProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

/** Semayi Gemini'nin kabul ettigi alt kumeye indirger. Derin, saf, girdiyi degistirmez. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

export const gemini: Provider = {
  name: 'gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',

  toCall(req: TurnRequest): HttpCall {
    const contents = req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.content.map((b) => {
        if (b.type === 'text') return { text: b.text };
        if (b.type === 'tool_use') return { functionCall: { name: b.name, args: b.input } };
        return {
          functionResponse: {
            name: b.name,
            // Gemini `response`un NESNE olmasini ister; duz metin reddedilir.
            response: b.isError ? { error: b.content } : { result: b.content },
          },
        };
      }),
    }));

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };

    if (req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeSchema(t.schema) as JsonSchema,
          })),
        },
      ];
    }

    return {
      url: `${trimBase(req.baseUrl)}/models/${encodeURIComponent(req.model)}:generateContent`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': req.apiKey,
      },
      body,
    };
  },

  fromResponse(data: unknown): AgentTurn {
    const res = (data ?? {}) as GeminiResponse;
    const cand = res.candidates?.[0];
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];

    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text) texts.push(part.text);
      const fc = part.functionCall;
      if (fc?.name) {
        toolUses.push({
          // Kimlik uretiliyor (bkz. dosya basi, madde 1). Ad zaten tool_result'ta
          // tasindigi icin bu id yalnizca dongu ici eslesme icin kullanilir.
          id: `gemini-${toolUses.length}-${fc.name}`,
          name: fc.name,
          input: (fc.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      text: texts.join('\n').trim(),
      toolUses,
      stopReason: mapStop(cand?.finishReason, toolUses.length > 0),
      usage: {
        inTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};

function mapStop(reason: string | undefined, hasCalls: boolean): StopReason {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (hasCalls) return 'tool_use';
  if (reason === 'STOP') return 'end';
  return 'other';
}
