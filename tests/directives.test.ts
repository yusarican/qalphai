import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_PER_TARGET,
  activeDirectives,
  addDirective,
  directiveBlock,
  readDirectives,
  revokeDirective,
} from '../src/orchestrator/directives';
import { buildNewStrategyBrief, buildRefineBrief } from '../src/codex/prompts';
import { queriesForNight } from '../src/research/queries';
import type { ChampionRecord } from '../src/orchestrator/champion';
import type { BacktestResults } from '../src/lib/types';

/**
 * YONLENDIRMENIN IKI SOZU.
 *
 * 1. **Kapaliyken hicbir sey degismez.** Aktif yonlendirme yokken gece dongusunun
 *    urettigi her prompt, karakter karakter bugunku halinde kalmali. Bu sozun testi
 *    asagidaki ilk blok — ve bu ozelligin tamaminin dayandigi sey.
 *
 * 2. **Yonlendirme kurallardan ONCE gelir.** Enjekte edilen metin HARD_RULES'tan once
 *    yerlestirilmeli ki makine tarafindan zorlanan kurallar son sozu soylesin. Sirasi
 *    tersine donerse, bir yonlendirme "800 satir sinirini yoksay" diyerek prompt
 *    duzeyinde son soz haline gelirdi (duvarlarin kendisi yine tutardi, ama Codex'in
 *    turu bosa giderdi).
 */

const FILE = path.join('data', 'orchestrator', 'directives.json');
let backup: string | null = null;

beforeEach(() => {
  backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
  if (fs.existsSync(FILE)) fs.rmSync(FILE);
});

afterEach(() => {
  if (backup !== null) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, backup);
  } else if (fs.existsSync(FILE)) {
    fs.rmSync(FILE);
  }
});

const PAPER = {
  paper: {
    id: '2401.00001',
    title: 'Test paper',
    summary: 'Bir ozet.',
    categories: ['q-fin.ST'],
    published: Date.parse('2024-01-01'),
    updated: Date.parse('2024-01-01'),
    authors: [],
    version: 1,
    absUrl: 'https://arxiv.org/abs/2401.00001',
  },
  hypothesis: 'h',
  angle: 'a',
  reason: 'r',
} as Parameters<typeof buildNewStrategyBrief>[0];

const CHAMPION = {
  strategyId: 's',
  version: 1,
  name: 'Sampiyon',
  author: 'codex',
  params: {},
  risk: {},
  symbols: [],
  interval: '4h',
  profile: 'balanced',
} as unknown as ChampionRecord;

const RESULTS = {
  totalPnlPercent: 1,
  mar: 1,
  maxDrawdownPercent: 1,
  totalTrades: 1,
  winRate: 1,
  expectancyR: 1,
  feeShareOfGross: 0.1,
} as BacktestResults;

describe('yonlendirme YOKKEN hicbir sey degismez', () => {
  it('directiveBlock BOS STRING doner', () => {
    expect(directiveBlock('codex-new')).toBe('');
    expect(directiveBlock('paper-triage')).toBe('');
  });

  it('Codex brief\'leri yonlendirme bolumu ICERMEZ', () => {
    expect(buildNewStrategyBrief(PAPER)).not.toContain('OPERASYON YONLENDIRMESI');
    expect(
      buildRefineBrief({ champion: CHAMPION, championSource: 'x', results: RESULTS, weakness: 'w' }),
    ).not.toContain('OPERASYON YONLENDIRMESI');
  });

  it('arXiv sorgu listesi bugunku uzunlugunda kalir (2 cekirdek + 1 rotasyon)', () => {
    expect(queriesForNight(0)).toHaveLength(3);
  });

  it('yonlendirme brief\'e YALNIZCA kendi blogunu ekler — tek karakter bile fazlasi degil', () => {
    /**
     * Bu test bir GERCEK regresyonu yakaladi.
     *
     * Enjeksiyon noktasi once `${directiveBlock(...)}\n${HARD_RULES}` seklindeydi: blok
     * bos donse bile araya birakilan satir sonu brief'e giriyordu ve yonlendirme YOKKEN
     * brief 4867 yerine 4868 karakter oluyordu. Tek karakter — ama "acilmadikca hicbir
     * sey degismez" sozu tam olarak boyle asinir.
     *
     * Degismez su: blok metnini ciktidan CIKARINCA, geriye bloksuz cikti BIREBIR kalmali.
     * Bunu iddia etmek, satir sonlarini elle saymaktan iyi — kirilmasi gereken tek sey
     * kirilir ve beklenti kodun kendisinden turer, benim sayimimdan degil.
     */
    const without = buildNewStrategyBrief(PAPER);

    addDirective({ target: 'codex-new', text: 'Cikis hastaligina odaklan.', rationale: 'neden', runId: 't' });

    const block = directiveBlock('codex-new');
    const withBlock = buildNewStrategyBrief(PAPER);

    expect(block).not.toBe('');
    expect(withBlock).toContain(block);
    expect(withBlock.replace(block, '')).toBe(without);
  });
});

describe('yonlendirme VARKEN', () => {
  it('blok kurallardan ONCE gelir ve "izin degil" der', () => {
    addDirective({
      target: 'codex-new',
      text: 'Cikis hastaligina odaklan.',
      rationale: 'kaybedenlerin %40i 1R gorup donuyor',
      runId: 'test',
    });

    const brief = buildNewStrategyBrief(PAPER);
    const iDirective = brief.indexOf('OPERASYON YONLENDIRMESI');
    const iRules = brief.indexOf('KATI KURALLAR');

    expect(iDirective).toBeGreaterThan(-1);
    expect(iRules).toBeGreaterThan(-1);
    expect(iDirective).toBeLessThan(iRules);
    expect(brief).toContain('IZIN DEGILDIR');
    expect(brief).toContain('Cikis hastaligina odaklan.');
    expect(brief).toContain('kaybedenlerin %40i 1R gorup donuyor');
  });

  it('hedefler birbirine SIZMAZ', () => {
    addDirective({ target: 'codex-refine', text: 'Sadece refine.', rationale: '', runId: 't' });
    expect(buildNewStrategyBrief(PAPER)).not.toContain('Sadece refine.');
    expect(
      buildRefineBrief({ champion: CHAMPION, championSource: 'x', results: RESULTS, weakness: 'w' }),
    ).toContain('Sadece refine.');
  });

  it('URL-kodlanmamis arXiv sorgusu SESSIZCE atlanmaz — listeye girmez', () => {
    // arxiv.ts:76 hand-encoded sorgu bekliyor; bosluklu bir metin sifir makale
    // dondururdu ve gece "yonlendirme ise yaramadi" diye okunurdu.
    addDirective({ target: 'arxiv-queries', text: 'trading strategy crypto', rationale: '', runId: 't' });
    expect(queriesForNight(0)).toHaveLength(3);

    addDirective({ target: 'arxiv-queries', text: 'all:%22order%20flow%22', rationale: '', runId: 't' });
    const qs = queriesForNight(0);
    expect(qs).toHaveLength(4);
    expect(qs[3]!.query).toBe('all:%22order%20flow%22');
  });
});

describe('depo', () => {
  it('suresi gecmis ve iptal edilmis yonlendirmeler aktif sayilmaz', () => {
    const live = addDirective({ target: 'paper-final', text: 'a', rationale: '', runId: 't' });
    const dead = addDirective({ target: 'paper-final', text: 'b', rationale: '', runId: 't', ttlDays: 1 });

    expect(activeDirectives('paper-final')).toHaveLength(2);
    // Bir gun sonrasindan bakildiginda ikincisi sonmus olmali.
    expect(activeDirectives('paper-final', Date.now() + 2 * 86_400_000)).toHaveLength(1);

    revokeDirective(live.id);
    expect(activeDirectives('paper-final').map((d) => d.id)).toEqual([dead.id]);
  });

  it('hedef basina tavan uygulanir — en yeniler kazanir', () => {
    for (let i = 0; i < MAX_ACTIVE_PER_TARGET + 2; i++) {
      addDirective({ target: 'codex-new', text: `y${i}`, rationale: '', runId: 't' });
    }
    const active = activeDirectives('codex-new');
    expect(active).toHaveLength(MAX_ACTIVE_PER_TARGET);
    // Hepsi diskte duruyor; yalnizca SUNULAN sayi kirpiliyor.
    expect(readDirectives()).toHaveLength(MAX_ACTIVE_PER_TARGET + 2);
  });

  it('bos metin reddedilir, cok uzun metin reddedilir', () => {
    expect(() => addDirective({ target: 'codex-new', text: '   ', rationale: '', runId: 't' })).toThrow();
    expect(() =>
      addDirective({ target: 'codex-new', text: 'x'.repeat(2001), rationale: '', runId: 't' }),
    ).toThrow();
  });

  it('bozuk dosya cokme degil BOS liste uretir — gece yonsuz kosar, hic kosmamazlik etmez', () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, '{ bozuk');
    expect(readDirectives()).toEqual([]);
    expect(directiveBlock('codex-new')).toBe('');
  });
});
