import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileStrategy, validateStrategySource } from '../src/strategy/validator';

/**
 * KIRMIZI TAKIM — validator'in dusmanca girdilere karsi regresyon takimi.
 *
 * Her ornek REDDEDILMEK zorunda ve test HANGI KURALLA reddedildigini dogrular
 * (yalnizca "reddedildi" demek yetmez: yanlis sebeple reddetmek, dogru sebebi
 * kacirdigimizi gizler).
 *
 * Bu dosya kalicidir. Validator'a her dokunusta bu 20 ornek yeniden kosar —
 * korumanin kendisinin regresyon takimi budur.
 */

const OK_HEADER = `import type { Strategy, StrategyContext, StrategyDecision, StrategyFactory } from './strategy-api';`;

/** Gecerli, minimal bir strateji — kontrol grubu. */
const VALID = `${OK_HEADER}

function evaluate(ctx: StrategyContext): StrategyDecision {
  const rsi = ctx.indicators.rsi;
  if (rsi === null) return null;
  if (rsi < 30) return { side: 'LONG', confidence: 0.7 };
  if (rsi > 70) return { side: 'SHORT', confidence: 0.7 };
  return { veto: true, rule: 'NO_EDGE' };
}

const factory: StrategyFactory = (): Strategy => ({
  meta: {
    id: 'rsi-test', name: 'RSI', version: 1, author: 'codex',
    warmupBars: 50, needs: {}, params: [],
  },
  evaluate,
});

export default factory;`;

interface Hostile {
  name: string;
  code: string;
  /** Beklenen reddetme kodu. */
  expect: string;
}

const HOSTILE: Hostile[] = [
  {
    name: 'fs import ederek diske yazmak',
    expect: 'FORBIDDEN_IMPORT',
    code: `import fs from 'node:fs';\n${VALID}`,
  },
  {
    name: 'dinamik import ile modul cekmek',
    expect: 'DYNAMIC_IMPORT',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'void import("node:fs");\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'require() ile modul cekmek',
    expect: 'REQUIRE',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const f = require("fs");\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'process.env okumak',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const k = process.env.SECRET;\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'globalThis uzerinden kacmak',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const g = globalThis;\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'fetch ile ag cagrisi',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'void fetch("http://evil.example");\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'eval',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'eval("1+1");\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'new Function ile kod uretmek',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const f = new Function("return 1");\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'constructor.constructor zinciri (klasik vm kacisi)',
    expect: 'PROTOTYPE_ACCESS',
    code: VALID.replace(
      'const rsi = ctx.indicators.rsi;',
      'const p = ({}).constructor.constructor("return process")();\n  const rsi = ctx.indicators.rsi;',
    ),
  },
  {
    name: "['constructor'] ile ayni kacis, koseli parantezle",
    expect: 'PROTOTYPE_ACCESS',
    code: VALID.replace(
      'const rsi = ctx.indicators.rsi;',
      'const c = ({} as any)["constructor"];\n  const rsi = ctx.indicators.rsi;',
    ),
  },
  {
    name: '__proto__ ile prototip zehirleme',
    expect: 'PROTOTYPE_ACCESS',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const p = ({} as any).__proto__;\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'Date.now() — saat okumak non-deterministiktir',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'const t = Date.now();\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'Math.random() — rastgelelik',
    expect: 'MATH_RANDOM',
    code: VALID.replace('if (rsi < 30)', 'if (Math.random() > 0.5) return null;\n  if (rsi < 30)'),
  },
  {
    name: 'async evaluate — I/O nun on kosulu',
    expect: 'ASYNC',
    code: VALID.replace('function evaluate(ctx: StrategyContext): StrategyDecision {', 'async function evaluate(ctx: StrategyContext): Promise<StrategyDecision> {'),
  },
  {
    name: 'setTimeout',
    expect: 'BANNED_IDENTIFIER',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', 'setTimeout(() => {}, 0);\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'modul seviyesinde let — mumlar arasi hafiza',
    expect: 'MODULE_STATE',
    code: VALID.replace(OK_HEADER, `${OK_HEADER}\n\nlet lastSignal: string | null = null;`),
  },
  {
    name: 'modul seviyesinde Map + .set() — gizli hafiza',
    expect: 'MODULE_STATE',
    code: VALID.replace(OK_HEADER, `${OK_HEADER}\n\nconst memo = new Map<number, number>();`).replace(
      'const rsi = ctx.indicators.rsi;',
      'memo.set(ctx.now, 1);\n  const rsi = ctx.indicators.rsi;',
    ),
  },
  {
    name: 'modul seviyesinde dizi + .push()',
    expect: 'MODULE_STATE',
    code: VALID.replace(OK_HEADER, `${OK_HEADER}\n\nconst seen: number[] = [];`).replace(
      'const rsi = ctx.indicators.rsi;',
      'seen.push(ctx.now);\n  const rsi = ctx.indicators.rsi;',
    ),
  },
  {
    name: 'ctx mutasyonu — dondurulmus veriye yazmaya calismak',
    expect: 'CTX_MUTATION',
    code: VALID.replace('const rsi = ctx.indicators.rsi;', '(ctx as any).params.hack = 1;\n  const rsi = ctx.indicators.rsi;'),
  },
  {
    name: 'default export yok',
    expect: 'NO_DEFAULT_EXPORT',
    code: VALID.replace('export default factory;', 'export { factory };'),
  },
];

describe('validator — kontrol grubu', () => {
  it('gecerli strateji KABUL edilir (validator asiri kisitlayici degil)', () => {
    const r = validateStrategySource(VALID);
    if (!r.ok) console.error(r.issues);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('gecerli strateji sozlesmeye karsi DERLENIR ve JS uretir', () => {
    const apiDts = buildApiDts();
    const c = compileStrategy(VALID, apiDts);
    if (!c.ok) console.error(c.diagnostics);
    expect(c.ok).toBe(true);
    expect(c.js).toContain('exports.default');
  });
});

describe('validator — kirmizi takim (her biri reddedilmeli)', () => {
  for (const h of HOSTILE) {
    it(h.name, () => {
      const r = validateStrategySource(h.code);
      expect(r.ok).toBe(false);
      const codes = r.issues.map((i) => i.code);
      // Yalnizca "reddedildi" yetmez — DOGRU sebeple reddedilmis olmali.
      expect(codes).toContain(h.expect);
    });
  }
});

describe('tip kontrolu duvari (types: [] — @types/node YOK)', () => {
  /**
   * Bu duvarin isi, NODE GLOBAL'lerini tip sisteminde yok saymaktir. @types/node
   * yuklenmedigi icin process/require/Buffer/__dirname diye bir sey YOKTUR — validator
   * bir sekilde atlatilsa bile derleyici bunlari tanimaz.
   *
   * Dikkat: eval/Function ES standardinin parcasidir ve lib.es2022'de TANIMLIDIR, yani
   * bu duvar onlari GECIRIR. Onlari Duvar 2 (validator: BANNED_IDENTIFIER) ve Duvar 4
   * (vm realm'inde codeGeneration.strings = false) durdurur. Katmanlarin isbolumu budur;
   * hicbir duvar tek basina yeterli degildir ve oyle olduklarini varsaymak hatadir.
   */
  it.each(['process', 'require', 'Buffer', '__dirname'])(
    'Node global i "%s" tip kontrolunden GECEMEZ (@types/node yok)',
    (globalName) => {
      const sneaky = VALID.replace(
        'const rsi = ctx.indicators.rsi;',
        `const leak = ${globalName};\n  const rsi = ctx.indicators.rsi;`,
      );
      const c = compileStrategy(sneaky, buildApiDts());
      expect(c.ok).toBe(false);
      expect(c.diagnostics.some((d) => d.message.includes(globalName))).toBe(true);
    },
  );

  it('eval TIP olarak gecerlidir (lib.es2022) — onu Duvar 2 durdurur, Duvar 3 degil', () => {
    const sneaky = VALID.replace(
      'const rsi = ctx.indicators.rsi;',
      'const p = (0, eval)("process");\n  const rsi = ctx.indicators.rsi;',
    );
    // Duvar 3 (derleyici) bunu GECIRIR — cunku eval standart bir global'dir.
    expect(compileStrategy(sneaky, buildApiDts()).ok).toBe(true);
    // Ama Duvar 2 (validator) reddeder. Katmanli savunmanin somut kaniti.
    const v = validateStrategySource(sneaky);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('BANNED_IDENTIFIER');
  });

  it('sozlesme disi alan dondurmek (leverage) DERLENMEZ', () => {
    // Stratejinin kaldiraca dokunma girisimi burada olur: donus tipinde boyle bir alan YOK.
    const greedy = VALID.replace(
      "return { side: 'LONG', confidence: 0.7 };",
      "return { side: 'LONG', confidence: 0.7, leverage: 50 };",
    );
    const c = compileStrategy(greedy, buildApiDts());
    expect(c.ok).toBe(false);
    expect(c.diagnostics.some((d) => d.message.includes('leverage'))).toBe(true);
  });

  it('async evaluate DERLENMEZ (Promise, StrategyDecision degil)', () => {
    const asyncCode = VALID.replace(
      'function evaluate(ctx: StrategyContext): StrategyDecision {',
      'async function evaluate(ctx: StrategyContext): Promise<StrategyDecision> {',
    );
    const c = compileStrategy(asyncCode, buildApiDts());
    expect(c.ok).toBe(false);
  });
});

/** src/strategy/types.ts -> sandbox'in gordugu strategy-api.d.ts */
function buildApiDts(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'strategy', 'types.ts'), 'utf8');
  // Tip korumalari (isSignal/isVeto) calisma zamani degeri; .d.ts'te declare edilir.
  return src
    .replace(/export function isSignal[\s\S]*?\n}/, 'export declare function isSignal(d: StrategyDecision): d is StrategySignal;')
    .replace(/export function isVeto[\s\S]*?\n}/, 'export declare function isVeto(d: StrategyDecision): d is StrategyVeto;');
}
