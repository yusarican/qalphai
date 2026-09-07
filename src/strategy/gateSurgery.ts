import ts from 'typescript';
import { loadMeta } from './loader';
import { toSandboxSource } from '../codex/workspace';
import type { StrategyMeta, StrategyParamSpec } from './types';

/**
 * ============================================================================
 * GATE CERRAHISI — bir gate'i KALDIRMAYI bir grid eksenine cevirir.
 * ============================================================================
 *
 * gateAnalysis.ts "bu filtre bize ne kaybettiriyor?" sorusunu OLCUYOR. Bu dosya bir
 * sonraki adimi atiyor: olcumun isaret ettigi degisikligi tasiyan GERCEK bir model
 * uretiyor — sinava girebilen, kutuphaneye yazilabilen, operatorun aktive edebilecegi
 * bir strategy.ts.
 *
 * ---------------------------------------------------------------- DONUSUM
 *
 * Her `return { veto: true, rule: 'X', ... }` YERELDE sarilir:
 *
 *     if (cond) {
 *       return { veto: true, rule: 'LOW_VOLUME', wouldBe: side };     // once
 *     }
 *     if (cond) {
 *       if (ctx.params['gate_LOW_VOLUME'] !== false)
 *         return { veto: true, rule: 'LOW_VOLUME', wouldBe: side };   // sonra
 *     }
 *
 * Neden `if` KOSULUNU degil RETURN'u sariyoruz: donusum boylece tamamen YEREL kaliyor.
 * Cevredeki yapiyi (dongu, ic ice kosul, erken donus, else dali) hic tanimasi gerekmiyor
 * ve Codex'in yazdigi keyfi kodda da ayni sekilde guvenli. Gate kapaliyken akis
 * fonksiyonun geri kalanina duser — "bu filtre orada degilmis gibi" tam olarak budur.
 *
 * ---------------------------------------------------------------- NEDEN AST
 *
 * validator.ts ile ayni arac, ayni gerekce (TECHSTACK.md): regex hem yanlis pozitif
 * ("veto: true" bir yorum icinde) hem yanlis negatif (satira bolunmus nesne literali)
 * uretir. AST'te bir dugum ya bir ReturnStatement'tir ya degildir.
 *
 * Ama YAZARKEN AST kullanmiyoruz: TypeScript printer'i tum dosyayi yeniden bicimler
 * (yorumlar kayar, string tirnaklari degisir, satir sayisi patlar). Bunun yerine dugum
 * KONUMLARIYLA cerrahi metin ekleme yapiliyor — dosyanin geri kalani BAYT BAYT ayni
 * kaliyor. Uretilen aday insan ve Codex tarafindan okunacak; okunamayan bir diff,
 * gozden gecirilemeyen bir degisikliktir.
 */

/** Uretilen parametre adinin oneki. `ctx.params['gate_LOW_VOLUME']` */
export const GATE_PARAM_PREFIX = 'gate_';

export const gateParamKey = (rule: string): string => `${GATE_PARAM_PREFIX}${rule}`;

export interface DetectedGate {
  rule: string;
  line: number;
  /** Karsi-olgusal olcum bu kural icin yapilabilir mi (veto `wouldBe` tasiyor mu)? */
  hasDirection: boolean;
  /** Mekanik olarak parametrelestirilebilir mi? */
  removable: boolean;
  /** Degilse nedeni — uydurma yapilmaz, Codex'e devredilir. */
  reason?: string;
}

export interface GateSurgeryResult {
  source: string;
  /** Kaynakta bulunan TUM veto noktalari (parametrelestirilenler dahil). */
  detected: DetectedGate[];
  /** Gercekten parametrelestirilen kurallar. */
  applied: string[];
  /** Istendi ama yapilamadi — nedeniyle. */
  skipped: Array<{ rule: string; reason: string }>;
  /** Uretilen grid'in strateji ekseni kac hucre (2^applied.length). */
  sweepCells: number;
}

/** Ayni anda acilabilecek azami gate ekseni. Her eksen hucre sayisini IKIYE katlar. */
export const MAX_GATES_AT_ONCE = 3;

// ---------------------------------------------------------------- tespit

/**
 * Kaynaktaki veto noktalarini bulur ve her birinin kaldirilabilirligini yargilar.
 *
 * Cagiran taraf bunu cerrahiden ONCE cagirip operatore/orchestrator'a "neyi
 * degistirebilirim" listesini gosterebilir.
 */
export function detectGates(source: string): DetectedGate[] {
  const sf = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.ES2022, true);
  const out: DetectedGate[] = [];

  const visit = (node: ts.Node): void => {
    const found = vetoReturn(node);
    if (found) out.push(judge(sf, node as ts.ReturnStatement, found));
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return out;
}

interface VetoShape {
  rule: string | null;
  hasDirection: boolean;
  obj: ts.ObjectLiteralExpression;
}

/** Dugum bir `return { veto: true, rule: ... }` mi? Degilse null. */
function vetoReturn(node: ts.Node): VetoShape | null {
  if (!ts.isReturnStatement(node) || !node.expression) return null;

  // `return ({...})` de gecerli — parantezlerin icine bakilir.
  let expr: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isObjectLiteralExpression(expr)) return null;

  let isVeto = false;
  let rule: string | null = null;
  let hasDirection = false;

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;

    if (key === 'veto' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) isVeto = true;
    // Kural adi STRING LITERAL olmali. Hesaplanmis bir ad (`rule: makeRule()`) statik
    // olarak bilinemez; o kural icin uretilecek parametrenin adi da bilinemez.
    if (key === 'rule' && ts.isStringLiteralLike(prop.initializer)) rule = prop.initializer.text;
    if (key === 'wouldBe') hasDirection = true;
  }

  return isVeto ? { rule, hasDirection, obj: expr } : null;
}

/**
 * `ctx` bu dugumun kapsaminda mi?
 *
 * Veto bir yardimci fonksiyondan donuyorsa (`function lowVol(ti) { return {veto:...} }`)
 * `ctx.params` oraya erisilemez ve enjekte edilen kosul DERLENMEZ. Boyle bir gate
 * mekanik olarak kaldirilamaz; UYDURULMAZ, raporlanir ve Codex'e devredilir.
 */
function ctxInScope(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === 'ctx') return true;
      }
    }
  }
  return false;
}

function judge(sf: ts.SourceFile, node: ts.ReturnStatement, shape: VetoShape): DetectedGate {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const base = { line, hasDirection: shape.hasDirection };

  if (!shape.rule) {
    return {
      ...base,
      rule: '(hesaplanmis)',
      removable: false,
      reason: 'kural adi string literal degil — uretilecek parametrenin adi statik olarak bilinemez',
    };
  }
  if (!ctxInScope(node)) {
    return {
      ...base,
      rule: shape.rule,
      removable: false,
      reason: '`ctx` bu kapsamda yok (veto bir yardimci fonksiyondan donuyor) — enjekte edilen kosul derlenmez',
    };
  }
  return { ...base, rule: shape.rule, removable: true };
}

// ---------------------------------------------------------------- cerrahi

export interface GateSurgeryArgs {
  source: string;
  /** Parametrelestirilecek kurallar. Bos ise kaldirilabilir TUM kurallar (tavana kadar). */
  rules?: string[];
  /**
   * Modelin uretimdeki parametre degerleri. Gate DISI her parametre bunlara SABITLENIR
   * ve `sweep`i silinir — bkz. rewriteParams.
   */
  pinnedParams?: Record<string, number | boolean>;
  /** Yeni modelin kimligi. Verilmezse `<id>-gate-<kurallar>`. */
  newId?: string;
  newName?: string;
}

export async function gateSurgery(args: GateSurgeryArgs): Promise<GateSurgeryResult> {
  const detected = detectGates(args.source);
  const removable = detected.filter((g) => g.removable);

  const wanted = args.rules?.length
    ? args.rules
    : removable.map((g) => g.rule).slice(0, MAX_GATES_AT_ONCE);

  const skipped: Array<{ rule: string; reason: string }> = [];
  const applied: string[] = [];

  for (const rule of wanted) {
    const hit = detected.find((g) => g.rule === rule);
    if (!hit) {
      skipped.push({ rule, reason: 'kaynakta boyle bir veto kurali yok' });
      continue;
    }
    if (!hit.removable) {
      skipped.push({ rule, reason: hit.reason! });
      continue;
    }
    if (applied.length >= MAX_GATES_AT_ONCE) {
      skipped.push({
        rule,
        reason:
          `ayni anda en fazla ${MAX_GATES_AT_ONCE} gate acilabilir — her eksen strateji ` +
          'grid hucrelerini IKIYE katlar',
      });
      continue;
    }
    applied.push(rule);
  }

  if (applied.length === 0) {
    return { source: args.source, detected, applied, skipped, sweepCells: 1 };
  }

  const meta = (await loadMeta(args.source)).meta;
  let out = injectGuards(args.source, applied);
  out = rewriteMeta(out, meta, applied, args);

  /**
   * Cikti ADAY BICIMINDE olmali.
   *
   * Cerrahinin urunu her zaman bir adaydir — asla motor icinde duran bir dosya degil.
   * Aday `challenge()`'a girerken validateStrategySource RAW kaynaga bakar ve yalnizca
   * './strategy-api' import'una izin verir (validator.ts:32). Builtin ise '../types'
   * import ediyor, cunku motor icinde dogru yol odur.
   *
   * Bu satir olmadan builtin'den uretilen her gate varyanti FORBIDDEN_IMPORT ile
   * duserdi — ve dusme yeri gece dongusunun ortasi olurdu, burasi degil. Cevrim
   * zaten idempotent: aday biciminde olan bir kaynagi degistirmez.
   */
  return { source: toSandboxSource(out), detected, applied, skipped, sweepCells: 2 ** applied.length };
}

/**
 * Veto return'lerini `ctx.params[...] !== false` kosuluyla sarar.
 *
 * Duzenlemeler SONDAN BASA uygulanir: bir ekleme kendinden sonraki hicbir dugumun
 * konumunu kaydirmasin. Bastan sona yapilsaydi ikinci ekleme yanlis ofsete duserdi ve
 * sonuc, derlenen ama BASKA bir sey yapan bir kaynak olurdu — sessiz hatalarin en pahalisi.
 */
function injectGuards(source: string, rules: string[]): string {
  const sf = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.ES2022, true);
  const want = new Set(rules);
  const edits: Array<{ start: number; end: number; text: string }> = [];

  const visit = (node: ts.Node): void => {
    const shape = vetoReturn(node);
    if (shape?.rule && want.has(shape.rule) && ctxInScope(node)) {
      const ret = node as ts.ReturnStatement;
      const start = ret.getStart(sf);
      const original = source.slice(start, ret.getEnd());
      edits.push({
        start,
        end: ret.getEnd(),
        text:
          `if (ctx.params['${gateParamKey(shape.rule)}'] !== false) ` +
          // Tek satira sikistiriliyor: cok satirli bir nesne literalini korurken araya
          // blok acmak girintiyi bozar ve diff'i okunmaz kilar.
          `{ ${original.replace(/\s*\n\s*/g, ' ')} }`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * meta.params dizisini YENIDEN YAZAR ve kimligi degistirir.
 *
 * Neden dizinin tamami: amac "modelin uretimdeki hali, SADECE su gate'ler acik/kapali"
 * kosusudur. Gate disi parametreler taraniyor kalirsa grid iki soruyu birden sorar
 * (hangi esik + hangi gate) ve gate ekseninin etkisi digerlerinin gurultusunde kaybolur.
 * Bu yuzden gate disi her parametre pinlenir (`sweep` silinir), gate parametreleri ise
 * [true,false] taranir. maxSweepCells tam olarak 2^N'e ayarlanir.
 */
function rewriteMeta(
  source: string,
  meta: StrategyMeta,
  applied: string[],
  args: GateSurgeryArgs,
): string {
  const sf = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.ES2022, true);
  const metaObj = findMetaObject(sf);
  if (!metaObj) {
    throw new Error('meta nesnesi bulunamadi — gate cerrahisi kaynagi degistiremez');
  }

  const pinned = args.pinnedParams ?? {};
  const specs: StrategyParamSpec[] = meta.params.map((p) => ({
    key: p.key,
    type: p.type,
    default: pinned[p.key] ?? p.default,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.doc ? { doc: p.doc } : {}),
    // sweep BILEREK dusuruluyor — bkz. fonksiyon basi.
  }));

  for (const rule of applied) {
    specs.push({
      key: gateParamKey(rule),
      type: 'boolean',
      default: true,
      sweep: [true, false],
      doc: `${rule} veto kurali acik mi (false = filtre kaldirilir)`,
    });
  }

  const cells = 2 ** applied.length;
  const ruleList = applied.join(', ');
  const newId = args.newId ?? `${meta.id}-gate-${applied.map((r) => r.toLowerCase()).join('-')}`;
  const newName = args.newName ?? `${meta.name} [gate: ${ruleList}]`;

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const replaceProp = (name: string, text: string): void => {
    const prop = metaObj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    );
    if (prop) {
      edits.push({ start: prop.getStart(sf), end: prop.getEnd(), text });
      return;
    }
    // Alan yoksa nesnenin basina eklenir (acilis suslu parantezden sonra).
    edits.push({ start: metaObj.getStart(sf) + 1, end: metaObj.getStart(sf) + 1, text: `\n    ${text},` });
  };

  replaceProp('id', `id: '${newId}'`);
  replaceProp('name', `name: ${JSON.stringify(newName)}`);
  replaceProp('version', `version: ${(meta.version ?? 1) + 1}`);
  replaceProp('params', `params: ${renderParams(specs)}`);
  replaceProp('maxSweepCells', `maxSweepCells: ${cells}`);

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  return `${banner(applied)}${out}`;
}

function findMetaObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'meta' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function renderParams(specs: StrategyParamSpec[]): string {
  const lines = specs.map((s) => {
    const parts = [`key: '${s.key}'`, `type: '${s.type}'`, `default: ${JSON.stringify(s.default)}`];
    if (s.sweep) parts.push(`sweep: ${JSON.stringify(s.sweep)}`);
    if (s.min !== undefined) parts.push(`min: ${s.min}`);
    if (s.max !== undefined) parts.push(`max: ${s.max}`);
    if (s.doc) parts.push(`doc: ${JSON.stringify(s.doc)}`);
    return `      { ${parts.join(', ')} }`;
  });
  return `[\n${lines.join(',\n')},\n    ]`;
}

function banner(applied: string[]): string {
  return `/**
 * GATE CERRAHISI ILE URETILDI (src/strategy/gateSurgery.ts) — elle yazilmadi.
 *
 * Acilan gate eksenleri: ${applied.join(', ')}
 *
 * Her biri \`ctx.params['${GATE_PARAM_PREFIX}<KURAL>']\` ile acilip kapanabilir; grid
 * ikisini de tariyor. Gate DISI parametreler kaynak modelin uretimdeki degerlerine
 * SABITLENDI, boylece grid tek bir soruyu soruyor: bu filtreler ise yariyor mu?
 *
 * Bu model hicbir kapidan gecmis DEGILDIR ve canliya OTOMATIK ALINMAZ.
 */
`;
}
