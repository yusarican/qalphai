import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectPaper } from '../src/research/selector';
import type { ArxivPaper } from '../src/research/arxiv';

/**
 * Makale secicinin regresyon takimi.
 *
 * Buradaki testlerin ortak temasi tek bir sey: **SECICI GECEYI DUSUREMEZ.** Model sacma
 * numara dondurur, bir triaj grubu zaman asimina ugrar, proxy komple coker — hicbiri
 * gece dongusunu durdurmamali. Secim, gecenin en degerli ama en vazgecilebilir adimidir:
 * makale yoksa gece REFINE'a duser, LLM yoksa deterministik siralayiciya duser.
 *
 * LLM cagrisi mock'lanir. Gercek modeli test etmiyoruz (deterministik degil ve para
 * yakar); test ettigimiz sey, modelden gelen ciktinin ETRAFINDAKI mantik.
 */

const chatJson = vi.fn();
const llmConfigured = vi.fn(() => true);

vi.mock('../src/lib/llm', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
  llmConfigured: () => llmConfigured(),
  LlmError: class LlmError extends Error {},
}));

function paper(id: string, over: Partial<ArxivPaper> = {}): ArxivPaper {
  return {
    id,
    version: 1,
    title: `Paper ${id}`,
    summary: 'Time series momentum on perpetual futures with transaction costs and walk-forward tests.',
    authors: ['A'],
    published: Date.parse('2026-08-01'),
    updated: Date.parse('2026-08-01'),
    categories: ['q-fin.TR'],
    absUrl: `https://arxiv.org/abs/${id}`,
    ...over,
  };
}

/** Triaj cagrisina verilen makale sayisini prompt'tan okur (mock, batch'i gormek zorunda). */
function triageRows(args: { user: string }, score: (n: number) => number) {
  const count = args.user.match(/\[\d+\]/g)?.length ?? 0;
  return {
    papers: Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      feasible: true,
      score: score(i + 1),
      reason: `gerekce ${i + 1}`,
    })),
  };
}

const isTriage = (args: { system: string }) => args.system.includes('triajci');

beforeEach(() => {
  chatJson.mockReset();
  llmConfigured.mockReturnValue(true);
});

describe('selectPaper', () => {
  it('triajdan gecenler arasindan modelin sectigi makaleyi hipoteziyle birlikte dondurur', async () => {
    chatJson.mockImplementation(async (args: { system: string; user: string }) => {
      if (isTriage(args)) return triageRows(args, (n) => n + 4); // 1->5, 2->6, 3->7
      return {
        n: 1,
        score: 9,
        hypothesis: 'Funding ekstremlerinde kalabalik pozisyonlar tasfiye olur.',
        angle: 'Funding z-skoru esigin ustundeyken ters yonde giris.',
        reason: 'Tek somut giris kurali oneren aday.',
      };
    });

    const { pick } = await selectPaper([paper('1'), paper('2'), paper('3')], new Set());

    expect(pick?.by).toBe('llm');
    expect(pick?.score).toBe(9);
    expect(pick?.hypothesis).toContain('Funding');
    expect(pick?.angle).toContain('z-skoru');
    // Finalist listesi skora gore siralanir: en yuksek triaj skoru '3' idi, model [1]'i
    // sectiyse bu, SIRALANMIS listenin ilk elemani — yani '3'.
    expect(pick?.paper.id).toBe('3');
  });

  it('triaj esigini gecen makale yoksa null doner (gece REFINE\'a duser)', async () => {
    chatJson.mockImplementation(async (args: { system: string; user: string }) => {
      if (isTriage(args)) return triageRows(args, () => 2);
      throw new Error('final cagrisi yapilmamaliydi');
    });

    const { pick, note } = await selectPaper([paper('1'), paper('2')], new Set());

    expect(pick).toBeNull();
    expect(note).toContain('uygulanabilir degil');
  });

  it('model n=0 dedigi zaman (hicbiri uygun degil) aday uydurmaz', async () => {
    chatJson.mockImplementation(async (args: { system: string; user: string }) =>
      isTriage(args) ? triageRows(args, () => 8) : { n: 0, reason: 'hicbiri sozlesmeye sigmiyor' },
    );

    const { pick, note } = await selectPaper([paper('1')], new Set());

    expect(pick).toBeNull();
    expect(note).toContain('model hicbirini secmedi');
  });

  it('LLM tamamen cokerse deterministik siralayiciya duser', async () => {
    chatJson.mockRejectedValue(new Error('HTTP 503'));

    const { pick, note } = await selectPaper([paper('1')], new Set());

    // Triaj gruplari tek tek yutulur; sonuc "aday yok" degil, YEDEK YOL olmali.
    expect(pick?.by).toBe('heuristic');
    expect(pick?.paper.id).toBe('1');
    expect(note).toContain('deterministik');
  });

  it('secici kapaliyken LLM cagrisi hic yapilmaz', async () => {
    llmConfigured.mockReturnValue(false);

    const { pick } = await selectPaper([paper('1')], new Set());

    expect(chatJson).not.toHaveBeenCalled();
    expect(pick?.by).toBe('heuristic');
  });

  it('gorulmus makaleleri ve sorgu ortusmelerinden gelen kopyalari modele hic gostermez', async () => {
    let shown: string[] = [];
    chatJson.mockImplementation(async (args: { system: string; user: string }) => {
      if (isTriage(args)) {
        shown = args.user.match(/Paper \d+/g) ?? [];
        return triageRows(args, () => 8);
      }
      return { n: 1, hypothesis: 'h', angle: 'a', reason: 'r' };
    });

    // '1' iki sorgudan da geldi, '2' daha once islenmisti.
    await selectPaper([paper('1'), paper('2'), paper('1')], new Set(['2']));

    expect(shown).toEqual(['Paper 1']);
  });

  it('bir triaj grubu coktugunde digerleri gecerli kalir', async () => {
    let batch = 0;
    chatJson.mockImplementation(async (args: { system: string; user: string }) => {
      if (isTriage(args)) {
        if (batch++ === 0) throw new Error('zaman asimi');
        return triageRows(args, () => 8);
      }
      return { n: 1, hypothesis: 'h', angle: 'a', reason: 'r' };
    });

    // 20'lik gruplar: 25 makale = 2 grup, ilki duser.
    const pool = Array.from({ length: 25 }, (_, i) => paper(String(i + 1)));
    const { pick } = await selectPaper(pool, new Set());

    expect(pick?.by).toBe('llm');
  });

  it('modelin uydurdugu veya tekrarlayan makale numaralarini atar', async () => {
    chatJson.mockImplementation(async (args: { system: string; user: string }) => {
      if (isTriage(args)) {
        return {
          papers: [
            { n: 1, feasible: true, score: 9, reason: 'gecerli' },
            { n: 1, feasible: true, score: 9, reason: 'ayni numara tekrar' },
            { n: 99, feasible: true, score: 10, reason: 'olmayan makale' },
          ],
        };
      }
      // Finale tek aday kalmali; model yine de 2 numarayi denerse null donmeli.
      expect(args.user.match(/\[\d+\]/g)).toHaveLength(1);
      return { n: 2, hypothesis: 'h', angle: 'a', reason: 'r' };
    });

    const { pick } = await selectPaper([paper('1'), paper('2')], new Set());

    expect(pick).toBeNull();
  });
});

describe('extractJson', () => {
  it('cite icinde, onsozle veya ciplak gelen JSON govdesini bulur', async () => {
    const { extractJson } = await vi.importActual<typeof import('../src/lib/llm')>('../src/lib/llm');

    expect(JSON.parse(extractJson('```json\n{"n":3}\n```'))).toEqual({ n: 3 });
    expect(JSON.parse(extractJson('Iste sonuc:\n{"n":3}\nUmarim yardimci olur.'))).toEqual({ n: 3 });
    expect(JSON.parse(extractJson('{"n":3}'))).toEqual({ n: 3 });
    expect(JSON.parse(extractJson('```\n[{"n":1}]\n```'))).toEqual([{ n: 1 }]);
  });
});
