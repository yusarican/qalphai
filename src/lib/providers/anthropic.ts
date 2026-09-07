import { trimBase, type AgentTurn, type HttpCall, type Provider, type StopReason, type ToolUse, type TurnRequest } from './types';

/**
 * Anthropic Messages API.
 *
 * Bu, normalize sekle EN YAKIN saglayici: tool cagrilari zaten mesaj icerigi icinde
 * blok olarak duruyor, yani cevirinin cogu birebir. Iki tuzak:
 *
 *   1. `anthropic-version` basligi ZORUNLU. Yoksa 400 doner ve hata metni versiyondan
 *      bahsetmez — "invalid request" diye okunur ve saatlerce sema aranir.
 *   2. `system` bir MESAJ DEGIL, govdenin ust seviye alani. messages dizisine
 *      {role:'system'} koymak 400 verir (OpenAI aliskanligiyla yapilan tipik hata).
 */

const VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: Array<
    | { type: 'text'; text?: string }
    | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  >;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const anthropic: Provider = {
  name: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',

  toCall(req: TurnRequest): HttpCall {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          };
        }),
      })),
    };

    // Tool'suz bir tur da mumkun (son ozet turu). Bos `tools` dizisi gondermek bazi
    // surumlerde 400 veriyor; alani HIC yazmamak her zaman gecerli.
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    return {
      url: `${trimBase(req.baseUrl)}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': VERSION,
      },
      body,
    };
  },

  fromResponse(data: unknown): AgentTurn {
    const res = (data ?? {}) as AnthropicResponse;
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];

    for (const block of res.content ?? []) {
      if (block.type === 'text' && block.text) texts.push(block.text);
      if (block.type === 'tool_use' && block.name) {
        toolUses.push({
          id: block.id ?? `${block.name}-${toolUses.length}`,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      text: texts.join('\n').trim(),
      toolUses,
      stopReason: mapStop(res.stop_reason),
      usage: {
        inTokens: res.usage?.input_tokens ?? 0,
        outTokens: res.usage?.output_tokens ?? 0,
      },
    };
  },
};

function mapStop(reason: string | undefined): StopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  return 'other';
}
