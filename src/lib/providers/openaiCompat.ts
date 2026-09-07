import { trimBase, type AgentTurn, type HttpCall, type Provider, type StopReason, type ToolUse, type TurnRequest } from './types';

/**
 * OpenAI-uyumlu /chat/completions (OpenAI, LiteLLM proxy, vLLM, OpenRouter...).
 *
 * Buradaki asil is DUZLESTIRME. Normalize sekilde bir mesajin icerigi bir BLOK DIZISI;
 * OpenAI'da ise tool sonuclari AYRI mesajlardir (`role:'tool'`) ve tool cagrilari
 * asistan mesajinin `tool_calls` alanindadir. Yani tek bir AgentMessage, birden fazla
 * OpenAI mesajina acilabilir.
 *
 * Iki tuzak, ikisi de sessiz:
 *   1. `tool_calls` tasiyan bir asistan mesajindan SONRA, her cagri icin BIRER `tool`
 *      mesaji gelmeli — eksigi 400 verir ("messages with role 'tool' must be a response
 *      to a preceding message with 'tool_calls'").
 *   2. `arguments` bir NESNE degil, JSON METNIDIR. Nesne gondermek sessizce bos argumana
 *      donusebiliyor.
 */

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

export const openaiCompat: Provider = {
  name: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',

  toCall(req: TurnRequest): HttpCall {
    const messages: ChatMessage[] = [{ role: 'system', content: req.system }];

    for (const m of req.messages) {
      const texts = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      const calls = m.content.filter((b) => b.type === 'tool_use');
      const results = m.content.filter((b) => b.type === 'tool_result');

      if (m.role === 'assistant') {
        // Asistan turu: metin + tool cagrilari TEK mesajda.
        const msg: ChatMessage = { role: 'assistant', content: texts.join('\n') || null };
        if (calls.length > 0) {
          msg.tool_calls = calls.map((b) => {
            const c = b as { id: string; name: string; input: Record<string, unknown> };
            return {
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            };
          });
        }
        messages.push(msg);
        continue;
      }

      // Kullanici turu: once tool sonuclari (her biri AYRI mesaj), sonra serbest metin.
      for (const b of results) {
        const r = b as { toolUseId: string; content: string };
        messages.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
      }
      if (texts.length > 0) messages.push({ role: 'user', content: texts.join('\n') });
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages,
    };

    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }

    return {
      url: `${trimBase(req.baseUrl)}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        // Proxy'ler anahtarsiz da cevap verebiliyor; bos bir Bearer gondermenin anlami yok
        // (lib/llm.ts:134 ile ayni gerekce).
        ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body,
    };
  },

  fromResponse(data: unknown): AgentTurn {
    const res = (data ?? {}) as OpenAiResponse;
    const choice = res.choices?.[0];
    const toolUses: ToolUse[] = [];

    for (const [i, call] of (choice?.message?.tool_calls ?? []).entries()) {
      const name = call.function?.name;
      if (!name) continue;
      toolUses.push({
        id: call.id ?? `${name}-${i}`,
        name,
        // Model bozuk JSON uretebilir. Cagriyi tumden dusurmek yerine BOS argumanla
        // gecmek de yanlis olurdu — tool o zaman yanlis girdiyle kosar. Hatayi burada
        // gorunur kiliyoruz: dongu bunu tool hatasi olarak modele geri besler.
        input: parseArgs(call.function?.arguments),
      });
    }

    return {
      text: (choice?.message?.content ?? '').trim(),
      toolUses,
      stopReason: mapStop(choice?.finish_reason, toolUses.length > 0),
      usage: {
        inTokens: res.usage?.prompt_tokens ?? 0,
        outTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  },
};

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: v };
  } catch {
    return { _parseError: raw.slice(0, 500) };
  }
}

function mapStop(reason: string | undefined, hasCalls: boolean): StopReason {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  // Bazi proxy'ler tool cagrisi dondururken finish_reason'i 'stop' birakiyor. Cagri
  // varsa niyet acik: bu bir tool turudur.
  if (hasCalls) return 'tool_use';
  if (reason === 'stop') return 'end';
  return 'other';
}
