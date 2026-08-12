import fs from 'node:fs';
import path from 'node:path';
import { CODEX_WORK_DIR } from '../config/env';
import { ALLOWED_IMPORT } from '../strategy/validator';

/**
 * DUVAR 1 — dosya sistemi izolasyonu.
 *
 * Codex bir AJANDIR: verdigin dizinde gezinir, dosya okur, dosya yazar. Dolayisiyla ona
 * "motoru degistirme" demek YETMEZ — motoru GORMEMESI gerekir. Bu yuzden cwd'si repo
 * degil, her kosuda sifirdan kurulan bos bir temp dizindir.
 *
 * Icinde OLAN:  strategy-api.d.ts (sozlesme), BRIEF.md (gorev + kurallar), 2 ornek
 *               strateji, bos bir candidate/strategy.ts, tsconfig.json
 * Icinde OLMAYAN: motor, backtest, skorlama, promosyon kapisi, .env, Firestore anahtari,
 *               Binance anahtari, repo, git gecmisi.
 *
 * Yani Codex, kendi degerlendirmesini goremez -> kendi sinavini kopya cekemez.
 */

export interface Workspace {
  dir: string;
  candidateFile: string;
}

/** src/strategy/types.ts -> sandbox'in gordugu strategy-api.d.ts */
export function buildApiDts(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'strategy', 'types.ts'), 'utf8');
  // isSignal/isVeto calisma zamani degeri; .d.ts'te declare olarak gecerler.
  return src
    .replace(
      /export function isSignal[\s\S]*?\n}/,
      'export declare function isSignal(d: StrategyDecision): d is StrategySignal;',
    )
    .replace(
      /export function isVeto[\s\S]*?\n}/,
      'export declare function isVeto(d: StrategyDecision): d is StrategyVeto;',
    );
}

/**
 * Builtin bir stratejiyi sandbox'ta derlenebilir hale getirir.
 *
 * src/strategy/builtin/* dosyalari sozlesmeyi `'../types'` yolundan import eder (repo icinde
 * dogru yol budur). Sandbox'ta ise sozlesme `'./strategy-api'` olarak durur. Ayni kaynagin
 * her iki baglamda da derlenmesi icin bu tek satirlik cevrim gerekir.
 *
 * Tek bir yerde durmasi onemli: parite testi, gauntlet ve Codex'e verilen ornekler AYNI
 * donusumu kullanmali, yoksa "ayni strateji" dedigimiz sey baglamdan baglama kayar.
 */
export function toSandboxSource(source: string): string {
  return source.replace(/from '\.\.\/types'/g, `from '${ALLOWED_IMPORT}'`);
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    strict: true,
    // KRITIK: @types/node YOK. process/require/fs/Buffer TIP olarak da yoktur.
    types: [],
    lib: ['ES2022'],
    noEmit: true,
  },
  include: ['candidate/**/*.ts'],
};

export interface CreateWorkspaceArgs {
  runId: string;
  brief: string;
  examples: Record<string, string>;
}

export function createWorkspace(args: CreateWorkspaceArgs): Workspace {
  const dir = path.resolve(CODEX_WORK_DIR, args.runId);

  // Her kosu TEMIZ baslar: onceki gecenin adayi yeni geceye sizmasin.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'strategy-api.d.ts'), buildApiDts());
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), args.brief);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));

  for (const [name, content] of Object.entries(args.examples)) {
    fs.writeFileSync(path.join(dir, 'examples', name), content);
  }

  const candidateFile = path.join(dir, 'candidate', 'strategy.ts');
  fs.writeFileSync(
    candidateFile,
    `// Stratejini BURAYA yaz. BRIEF.md'yi ve strategy-api.d.ts'i once oku.\n` +
      `// Bu dosya bir StrategyFactory default export etmeli.\n`,
  );

  return { dir, candidateFile };
}

/**
 * Adayi cikarir.
 *
 * Birincil kanal DISK: Codex bir ajan, dosya yazar. Fenced code block'a guvenmek,
 * modelin cevabini kesmesi/formatlamasi durumunda sessizce bozulur.
 */
export function extractCandidate(ws: Workspace, fallbackText?: string): string | null {
  const onDisk = fs.readFileSync(ws.candidateFile, 'utf8');
  if (onDisk.includes('export default') && onDisk.length > 200) return onDisk;

  // Yedek kanal: son mesajdaki ```ts blogu.
  if (fallbackText) {
    const blocks = [...fallbackText.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)];
    const last = blocks[blocks.length - 1]?.[1];
    if (last && last.includes('export default')) return last;
  }

  return null;
}

export function destroyWorkspace(ws: Workspace): void {
  fs.rmSync(ws.dir, { recursive: true, force: true });
}
