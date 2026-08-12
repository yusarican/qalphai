import ts from 'typescript';

/**
 * DUVAR 2 + 3 — Codex'in yazdigi strateji kaynaginin STATIK reddi.
 *
 * TypeScript compiler API ile AST yurunur. Regex DEGIL: `eval` aramak icin metinde
 * "eval" gecmesine bakmak hem yanlis pozitif (yorumda gecer) hem yanlis negatif
 * (`globalThis['ev'+'al']`) uretir. AST'de bir Identifier ya `eval`dir ya degildir.
 *
 * Bu duvarin amaci Codex'i "yakalamak" degil — amaci, sozlesmenin YAPISAL olarak
 * zorlanmasi. Bir strateji saf bir fonksiyondan ibaret olmali: girdi ctx, cikti karar.
 * I/O yok, saat yok, rastgelelik yok, mumlar arasi hafiza yok. Bu kurallarin her biri
 * ihlal edilirse backtest ile canli DAVRANIS AYRISIR — yani sistemin urettigi her sayi
 * yalan olur. Guvenlikten once DOGRULUK meselesi.
 *
 * Kurallarin birebir listesi Codex'e BRIEF.md icinde verilir: hatalar surpriz degil,
 * kendi kendine yapilmis olsun.
 */

export interface ValidationIssue {
  code: string;
  line: number;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Stratejinin import etmesine izin verilen TEK modul. */
export const ALLOWED_IMPORT = './strategy-api';

/**
 * Yasakli global kimlikler. Her biri ya I/O (ag/disk), ya non-determinizm (saat,
 * rastgelelik), ya da realm kacisi (Function, eval, constructor zinciri) kapisi.
 */
const BANNED_IDENTIFIERS = new Set([
  // I/O ve surec
  'process', 'require', 'module', 'exports', '__dirname', '__filename',
  'global', 'globalThis', 'Buffer',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'navigator',
  // Kod uretimi / realm kacisi
  'eval', 'Function', 'WebAssembly', 'Reflect', 'Proxy',
  // Es zamanlilik — evaluate SENKRON olmali
  'Promise', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'Worker', 'SharedArrayBuffer', 'Atomics',
  // Non-determinizm: ayni ctx her zaman ayni karari vermeli
  'Date', 'performance', 'crypto', 'Intl',
  // Diger
  'structuredClone', 'console',
]);

/** Yasakli uye erisimleri: obj.PROP seklinde. */
const BANNED_MEMBERS = new Set([
  // ({}).constructor.constructor('return process')() — klasik vm kacis zinciri.
  'constructor',
  '__proto__',
]);

const MAX_LINES = 800;
const MAX_BYTES = 60_000;

export function validateStrategySource(source: string, fileName = 'strategy.ts'): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (code: string, node: ts.Node | null, message: string, sf?: ts.SourceFile) => {
    const line =
      node && sf ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : 0;
    issues.push({ code, line, message });
  };

  // --- Boyut sinirlari
  const lineCount = source.split('\n').length;
  if (lineCount > MAX_LINES) {
    issues.push({ code: 'TOO_LONG', line: 0, message: `${lineCount} satir (tavan ${MAX_LINES})` });
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) {
    issues.push({ code: 'TOO_BIG', line: 0, message: `dosya ${MAX_BYTES} bayti asiyor` });
  }

  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  let hasDefaultExport = false;
  let nodeCount = 0;

  const visit = (node: ts.Node): void => {
    nodeCount++;

    // --- import / require
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      const value = ts.isStringLiteral(spec) ? spec.text : '?';
      if (value !== ALLOWED_IMPORT) {
        push('FORBIDDEN_IMPORT', node, `'${value}' import edilemez. Tek izinli modul: '${ALLOWED_IMPORT}'`, sf);
      } else if (!node.importClause?.isTypeOnly) {
        // Sozlesme yalnizca TIP saglar; calisma zamani degeri yoktur.
        push('IMPORT_MUST_BE_TYPE_ONLY', node, `'${ALLOWED_IMPORT}' yalnizca 'import type' ile alinabilir`, sf);
      }
    }

    if (ts.isImportEqualsDeclaration(node)) {
      push('FORBIDDEN_IMPORT', node, 'import = ... kullanilamaz', sf);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push('FORBIDDEN_REEXPORT', node, 'baska modulden re-export yapilamaz', sf);
    }

    // dinamik import(...) ve require(...)
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        push('DYNAMIC_IMPORT', node, 'dinamik import() yasak', sf);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        push('REQUIRE', node, 'require() yasak', sf);
      }
    }

    // --- async / await / generator — evaluate SENKRON olmali (I/O nun on kosulu budur)
    if (ts.canHaveModifiers(node)) {
      const mods = ts.getModifiers(node);
      if (mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        push('ASYNC', node, 'async yasak — evaluate() senkron olmali', sf);
      }
    }
    if (ts.isAwaitExpression(node)) push('AWAIT', node, 'await yasak', sf);
    if (ts.isYieldExpression(node)) push('YIELD', node, 'yield yasak', sf);
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
      node.asteriskToken
    ) {
      push('GENERATOR', node, 'generator fonksiyon yasak', sf);
    }

    // --- yasakli kimlikler
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      // Yalnizca DEGER pozisyonunda yasak. `foo.process` (uye adi) veya
      // `{ process: 1 }` (ozellik adi) zararsizdir.
      const p = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isPropertySignature(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node);

      if (!isPropertyName) {
        push('BANNED_IDENTIFIER', node, `'${node.text}' kullanilamaz`, sf);
      }
    }

    // --- Math.random: saf gorunur ama non-deterministiktir
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      node.name.text === 'random'
    ) {
      push('MATH_RANDOM', node, 'Math.random() yasak — evaluate() deterministik olmali', sf);
    }

    // --- .constructor / __proto__ : vm realm kacisinin ana vektoru
    if (ts.isPropertyAccessExpression(node) && BANNED_MEMBERS.has(node.name.text)) {
      push('PROTOTYPE_ACCESS', node, `.${node.name.text} erisimi yasak`, sf);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      BANNED_MEMBERS.has(node.argumentExpression.text)
    ) {
      push('PROTOTYPE_ACCESS', node, `['${node.argumentExpression.text}'] erisimi yasak`, sf);
    }

    // --- ctx mutasyonu
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (rootIdentifierOf(node.left) === 'ctx') {
        push('CTX_MUTATION', node, 'ctx degistirilemez (zaten dondurulmus)', sf);
      }
    }

    // --- new: yalnizca zararsiz veri yapilari
    if (ts.isNewExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : '?';
      if (!['Map', 'Set', 'Array', 'Error'].includes(name)) {
        push('FORBIDDEN_NEW', node, `new ${name} yasak`, sf);
      }
    }

    // --- default export
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  // --- MODUL SEVIYESI MUTABLE STATE
  //
  // Durumsuzlugu TEMENNI olmaktan cikarip ZORUNLU kilan kural budur. Modul seviyesinde
  // bir `let` veya mutasyona ugrayan bir `const Map`, strateji icin mumlar arasi bir
  // hafizadir. Boyle bir strateji backtest'te (tek surecte, sirali) bir turlu, canlida
  // (yeniden baslatilan surecte, tek mum) baska turlu davranir — ve bu ayrisma
  // sessizdir. gauntlet'in statelessness testi de kovalar; bu, ilk savunma hatti.
  checkModuleState(sf, issues);

  if (!hasDefaultExport) {
    issues.push({
      code: 'NO_DEFAULT_EXPORT',
      line: 0,
      message: 'dosya bir StrategyFactory default export etmeli',
    });
  }

  if (nodeCount > 6000) {
    issues.push({ code: 'TOO_COMPLEX', line: 0, message: `${nodeCount} AST dugumu (tavan 6000)` });
  }

  return { ok: issues.length === 0, issues };
}

function checkModuleState(sf: ts.SourceFile, issues: ValidationIssue[]): void {
  const mutableConsts = new Map<string, ts.Node>();

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    const flags = stmt.declarationList.flags;
    const isConst = (flags & ts.NodeFlags.Const) !== 0;

    if (!isConst) {
      const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
      issues.push({
        code: 'MODULE_STATE',
        line,
        message: 'modul seviyesinde let/var yasak — strateji durumsuz olmali',
      });
      continue;
    }

    // const olsa bile icerigi mutasyona ugrayabilen koleksiyonlar hafizadir.
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const init = decl.initializer;
      const isMutableContainer =
        ts.isArrayLiteralExpression(init) ||
        ts.isObjectLiteralExpression(init) ||
        (ts.isNewExpression(init) &&
          ts.isIdentifier(init.expression) &&
          ['Map', 'Set', 'Array'].includes(init.expression.text));
      if (isMutableContainer) mutableConsts.set(decl.name.text, decl);
    }
  }

  if (mutableConsts.size === 0) return;

  // Bu koleksiyonlardan biri MUTASYONA ugruyor mu? (sabit lookup tablolari mesru)
  const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'set', 'add', 'delete', 'clear', 'sort', 'reverse', 'fill']);

  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(target) && mutableConsts.has(target.text) && MUTATORS.has(method)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        issues.push({
          code: 'MODULE_STATE',
          line,
          message: `modul seviyesindeki '${target.text}' mutasyona ugruyor (.${method}) — mumlar arasi hafiza yasak`,
        });
      }
    }
    // cache[k] = v / cache.k = v seklinde atama
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const isMemberWrite =
        ts.isElementAccessExpression(node.left) || ts.isPropertyAccessExpression(node.left);
      const root = isMemberWrite ? rootIdentifierOf(node.left) : null;
      if (root && mutableConsts.has(root)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        issues.push({
          code: 'MODULE_STATE',
          line,
          message: `modul seviyesindeki '${root}' mutasyona ugruyor — mumlar arasi hafiza yasak`,
        });
      }
    }
    ts.forEachChild(node, scan);
  };

  ts.forEachChild(sf, scan);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * `a.b.c[d] = x` ifadesinin kok kimligi: 'a'.
 *
 * Tip iskeleleri (`as`, `<T>`, `satisfies`, `!`, parantez) MUTLAKA soyulmali. Kirmizi
 * takim testi tam olarak buradan sizmisti: `(ctx as any).params.hack = 1` ifadesinde
 * AsExpression atlanmayinca kok 'ctx' bulunamiyor ve CTX_MUTATION kurali sessizce
 * devre disi kaliyordu. `as any`, bir saldirganin (veya sadece TS ile bogusan bir
 * modelin) ilk yazacagi sey oldugu icin bu, teorik degil pratik bir aciktir.
 */
function rootIdentifierOf(node: ts.Node): string | null {
  let cur: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;

    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }

    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }

    return null;
  }
}

// ---------------------------------------------------------------- DUVAR 3: tip kontrolu + derleme

export interface CompileResult {
  ok: boolean;
  js?: string;
  diagnostics: ValidationIssue[];
}

/**
 * Adayi sozlesmeye karsi derler. Kritik nokta: `types: []` ve `lib: ["ES2022"]` —
 * yani @types/node YOK. Bu sayede `process`, `require`, `Buffer`, `fetch` TIP
 * KONTROLUNDEN gecemez; validator'i bir sekilde atlatsalar bile burada olurler.
 *
 * Cikan diagnostic'ler Codex'e onarim turu olarak geri beslenir — bu yuzden mesajlar
 * korunur.
 */
export function compileStrategy(source: string, apiDts: string): CompileResult {
  const STRATEGY_FILE = '/strategy.ts';
  const API_FILE = '/strategy-api.d.ts';

  const files: Record<string, string> = {
    [STRATEGY_FILE]: source,
    [API_FILE]: apiDts,
  };

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    noImplicitAny: true,
    noUnusedLocals: false,
    types: [],
    lib: ['lib.es2022.d.ts'],
    noEmitOnError: true,
    skipLibCheck: true,
  };

  let emitted = '';
  const defaultHost = ts.createCompilerHost(options);

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, langVersion) => {
      const own = files[name];
      if (own !== undefined) return ts.createSourceFile(name, own, langVersion, true);
      return defaultHost.getSourceFile(name, langVersion);
    },
    readFile: (name) => files[name] ?? defaultHost.readFile(name),
    fileExists: (name) => files[name] !== undefined || defaultHost.fileExists(name),
    writeFile: (_name, text) => {
      emitted = text;
    },
  };

  const program = ts.createProgram([STRATEGY_FILE], options, host);
  const emitResult = program.emit();

  const all = [
    ...ts.getPreEmitDiagnostics(program),
    ...emitResult.diagnostics,
  ].filter((d) => !d.file || d.file.fileName === STRATEGY_FILE);

  const diagnostics: ValidationIssue[] = all.map((d) => {
    const line =
      d.file && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
        : 0;
    return {
      code: `TS${d.code}`,
      line,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    };
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, js: emitted, diagnostics: [] };
}
