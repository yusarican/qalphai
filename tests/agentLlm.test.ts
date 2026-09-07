import { describe, expect, it } from 'vitest';
import { anthropic } from '../src/lib/providers/anthropic';
import { gemini, sanitizeSchema } from '../src/lib/providers/gemini';
import { openaiCompat } from '../src/lib/providers/openaiCompat';
import type { AgentMessage, ToolSpec, TurnRequest } from '../src/lib/providers/types';

/**
 * UC SAGLAYICI, TEK SEKIL.
 *
 * Agent dongusu (orchestrator/agent/loop.ts) uc API'nin hicbirini tanimiyor. Ceviri
 * yanlissa dongu duzgun gorunur ama model ya tool'lari HIC gormez ya da tool
 * sonuclarini yanlis cagriyla eslestirir — ikisi de sessizdir ve ancak "orchestrator
 * neden hicbir sey olcmuyor?" diye sorulunca fark edilir.
 */

const TOOLS: ToolSpec[] = [
  {
    name: 'list_models',
    description: 'modelleri listeler',
    schema: { type: 'object', properties: { q: { type: 'string' } }, required: [], additionalProperties: false },
  },
];

const MESSAGES: AgentMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'baslayalim' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'once listeleyeyim' },
      { type: 'tool_use', id: 'call_1', name: 'list_models', input: { q: 'hepsi' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 'call_1', name: 'list_models', content: '2 model' }],
  },
];

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: 'test-model',
  baseUrl: 'https://example.test/',
  apiKey: 'k',
  system: 'sistem',
  messages: MESSAGES,
  tools: TOOLS,
  maxTokens: 1000,
  temperature: 0,
  ...over,
});

describe('anthropic', () => {
  it('system UST SEVIYE alandir, mesaj DEGIL', () => {
    // OpenAI aliskanligiyla messages'a {role:'system'} koymak 400 verir.
    const call = anthropic.toCall(req());
    const body = call.body as { system: string; messages: Array<{ role: string }> };
    expect(body.system).toBe('sistem');
    expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('anthropic-version basligi gonderilir', () => {
    expect(anthropic.toCall(req()).headers['anthropic-version']).toBeTruthy();
    expect(anthropic.toCall(req()).headers['x-api-key']).toBe('k');
  });

  it('sondaki egik cizgi iki cizgiye donmez', () => {
    expect(anthropic.toCall(req()).url).toBe('https://example.test/v1/messages');
  });

  it('tool cagrisi ve sonucu blok olarak tasinir', () => {
    const body = anthropic.toCall(req()).body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.messages[1]!.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'list_models' });
    expect(body.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });

  it('tool YOKSA `tools` alani HIC yazilmaz', () => {
    // Bos dizi bazi surumlerde 400 veriyor; kapanis turu tool'suz kosuyor.
    expect(anthropic.toCall(req({ tools: [] })).body).not.toHaveProperty('tools');
  });

  it('yanit cozulur: metin + tool cagrisi + kullanim', () => {
    const turn = anthropic.fromResponse({
      content: [
        { type: 'text', text: 'bakiyorum' },
        { type: 'tool_use', id: 'x', name: 'autopsy', input: { from: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(turn.text).toBe('bakiyorum');
    expect(turn.toolUses).toEqual([{ id: 'x', name: 'autopsy', input: { from: 'a' } }]);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({ inTokens: 10, outTokens: 5 });
  });

  it('max_tokens SESSIZCE yutulmaz', () => {
    expect(anthropic.fromResponse({ content: [], stop_reason: 'max_tokens' }).stopReason).toBe('max_tokens');
  });
});

describe('openai-uyumlu', () => {
  it('tool sonuclari AYRI `role:tool` mesajlarina duzlestirilir', () => {
    // Eksigi 400 verir: "messages with role 'tool' must be a response to a preceding
    // message with 'tool_calls'".
    const body = openaiCompat.toCall(req()).body as { messages: Array<{ role: string; tool_call_id?: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body.messages[3]!.tool_call_id).toBe('call_1');
  });

  it('arguments NESNE degil JSON METNIDIR', () => {
    const body = openaiCompat.toCall(req()).body as {
      messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    };
    const argsText = body.messages[2]!.tool_calls![0]!.function.arguments;
    expect(typeof argsText).toBe('string');
    expect(JSON.parse(argsText)).toEqual({ q: 'hepsi' });
  });

  it('anahtar bossa bos Bearer basligi gonderilmez', () => {
    expect(openaiCompat.toCall(req({ apiKey: '' })).headers).not.toHaveProperty('Authorization');
  });

  it('bozuk arguments JSON\'u cagriyi dusurmez, gorunur kilar', () => {
    const turn = openaiCompat.fromResponse({
      choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{bozuk' } }] }, finish_reason: 'tool_calls' }],
    });
    expect(turn.toolUses[0]!.input).toHaveProperty('_parseError');
  });

  it('finish_reason "stop" olsa bile tool cagrisi varsa tool turu sayilir', () => {
    // Bazi proxy'ler boyle donduruyor; niyet acik.
    const turn = openaiCompat.fromResponse({
      choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }] }, finish_reason: 'stop' }],
    });
    expect(turn.stopReason).toBe('tool_use');
  });

  it('length SESSIZCE yutulmaz', () => {
    expect(openaiCompat.fromResponse({ choices: [{ message: { content: 'yarim' }, finish_reason: 'length' }] }).stopReason).toBe(
      'max_tokens',
    );
  });
});

describe('gemini', () => {
  it('rol adi "model"dir, "assistant" degil', () => {
    const body = gemini.toCall(req()).body as { contents: Array<{ role: string }> };
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('tool sonucu ADLA eslesir (functionCall\'in kimligi yoktur)', () => {
    const body = gemini.toCall(req()).body as {
      contents: Array<{ parts: Array<{ functionResponse?: { name: string; response: unknown } }> }>;
    };
    const fr = body.contents[2]!.parts[0]!.functionResponse!;
    expect(fr.name).toBe('list_models');
    // `response` NESNE olmali; duz metin reddedilir.
    expect(fr.response).toEqual({ result: '2 model' });
  });

  it('sema OpenAPI alt kumesine budanir', () => {
    // Budanmazsa tool katmani tumden 400 ile duser ve hata hangi alanin sorunlu
    // oldugunu SOYLEMEZ.
    const cleaned = sanitizeSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'x',
      properties: { a: { type: 'string', default: 'd', const: 1 } },
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty('additionalProperties');
    expect(cleaned).not.toHaveProperty('$schema');
    expect((cleaned.properties as Record<string, Record<string, unknown>>).a).toEqual({ type: 'string' });
  });

  it('budama girdiyi DEGISTIRMEZ', () => {
    const input = { type: 'object', additionalProperties: false };
    sanitizeSchema(input);
    expect(input).toHaveProperty('additionalProperties');
  });

  it('yanit cozulur ve kimlik uretilir', () => {
    const turn = gemini.fromResponse({
      candidates: [
        {
          content: { parts: [{ text: 'tamam' }, { functionCall: { name: 'autopsy', args: { from: 'a' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
    expect(turn.text).toBe('tamam');
    expect(turn.toolUses[0]!.name).toBe('autopsy');
    expect(turn.toolUses[0]!.id).toContain('autopsy');
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({ inTokens: 7, outTokens: 3 });
  });

  it('MAX_TOKENS SESSIZCE yutulmaz', () => {
    expect(gemini.fromResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).stopReason).toBe('max_tokens');
  });
});

describe('uc saglayici ayni tool\'u tasir', () => {
  it('tool adi ve semasi ucunde de gider', () => {
    const bodies = [anthropic.toCall(req()).body, openaiCompat.toCall(req()).body, gemini.toCall(req()).body];
    for (const b of bodies) {
      expect(JSON.stringify(b)).toContain('list_models');
      expect(JSON.stringify(b)).toContain('modelleri listeler');
    }
  });
});
