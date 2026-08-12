import crypto from 'node:crypto';
import { SandboxPool } from './sandbox/host';
import { EMPTY_INDICATORS } from '../engine/indicatorSeries';
import type { WorkerInit, WorkerJob } from './sandbox/protocol';
import type { RecordedDecision } from '../engine/simulator';
import type { Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';

/**
 * DUVAR 5 — DAVRANISSAL kapi. Hicbir aday bunu gecmeden BACKTEST'E ULASAMAZ.
 *
 * Duvar 2/3/4 kodun NE YAPABILECEGINI kisitlar. Bu duvar, kodun NE YAPTIGINI olcer.
 * Ikisi farkli sorulardir: statik olarak temiz gorunen bir strateji yine de
 * non-deterministik, durumlu veya (bizim kesim kodumuzdaki bir bug sayesinde)
 * gelecege bakan olabilir.
 *
 * Bir aday burada duserse SEBEP Codex'e onarim turu olarak geri beslenir.
 */

export interface GauntletCheck {
  pass: boolean;
  detail: string;
}

export interface GauntletResult {
  pass: boolean;
  checks: Record<string, GauntletCheck>;
  /** Basarisiz kontrollerin Codex'e verilecek ozeti. */
  feedback: string;
}

export interface GauntletArgs {
  init: WorkerInit;
  job: WorkerJob;
  /** Bar basina ortalama sure tavani (ms). */
  maxMsPerBar?: number;
  /** Bir kosunun tamamlanmasi icin tanınan sure. Asilirsa worker OLDURULUR. */
  timeoutMs?: number;
}

const hash = (d: RecordedDecision[]): string =>
  crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex');

export async function runGauntlet(args: GauntletArgs): Promise<GauntletResult> {
  const checks: Record<string, GauntletCheck> = {};
  const timeoutMs = args.timeoutMs ?? 120_000;

  // --- 1. DETERMINIZM: iki TAZE worker, ayni girdi -> ayni cikti.
  //
  // Taze worker sart: ayni worker'da iki kez kosmak, saklanan bir state'i degil yalnizca
  // tekrarlanabilirligi olcerdi. Ayri surecler, gizli saat/rastgelelik/global state'i acar.
  const t0 = Date.now();
  const poolA = SandboxPool.create(args.init, { workers: 1, timeoutMs });
  const poolB = SandboxPool.create(args.init, { workers: 1, timeoutMs });

  let baseline: RecordedDecision[];
  try {
    const [a, b] = await Promise.all([poolA.run(args.job), poolB.run(args.job)]);
    baseline = a;
    const same = hash(a) === hash(b);
    checks['determinizm'] = {
      pass: same,
      detail: same
        ? 'iki bagimsiz surecte ayni karar akisi'
        : 'AYNI girdi farkli cikti verdi — gizli saat/rastgelelik/global state var',
    };
  } catch (err) {
    await poolA.close();
    await poolB.close();
    return fail(checks, 'calisma', err instanceof Error ? err.message : String(err));
  } finally {
    await poolA.close();
    await poolB.close();
  }

  const elapsedMs = Date.now() - t0;

  // --- 2. LOOK-AHEAD (gelecek zehri).
  //
  // Karar barindan SONRAKI her mum copa cevrilir. Strateji yalnizca gecmisi okuyorsa
  // hicbir karari degismemelidir. Degisiyorsa ya strateji ya da BIZIM kesim kodumuz
  // (engine/context.ts) gelecege bakiyor demektir.
  //
  // Bu test asil olarak KORUMANIN KENDISINI kovaliyor: context.ts `openTime < t` yerine
  // `<=` kullansaydi, karar barinin kendisi (henuz KAPANMAMIS mum) stratejiye sizardi.
  // Backtest muhtesem gorunur, canlida para kaybeder, ve hicbir birim testi bunu gostermez.
  try {
    const poison = poisonFuture(args.init);
    const poolC = SandboxPool.create(poison.init, { workers: 1, timeoutMs });
    try {
      const poisoned = await poolC.run(args.job);

      // Yalnizca zehirlenmemis bolgedeki kararlari karsilastir.
      const clean = baseline.filter((d) => d.timestamp <= poison.poisonTime);
      const dirty = poisoned.filter((d) => d.timestamp <= poison.poisonTime);

      const same = hash(clean) === hash(dirty);
      checks['look-ahead'] = {
        pass: same,
        detail: same
          ? `${clean.length} karar noktasi: gelecek copa cevrildiginde hicbir sinyal degismedi`
          : 'GELECEGI OKUYOR — karar barindan sonraki veri degisince kararlar degisti',
      };
    } finally {
      await poolC.close();
    }
  } catch (err) {
    checks['look-ahead'] = {
      pass: false,
      detail: `zehir testi kosulamadi: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // --- 3. PERFORMANS: grid'de bu sayi |hucre| ile carpilir.
  const bars = args.init.points.length * args.init.symbols.length;
  const msPerBar = bars > 0 ? elapsedMs / bars : 0;
  const maxMs = args.maxMsPerBar ?? 5;
  checks['performans'] = {
    pass: msPerBar <= maxMs,
    detail: `${msPerBar.toFixed(3)} ms/bar (tavan ${maxMs}) — ${bars} bar, ${(elapsedMs / 1000).toFixed(1)}sn`,
  };

  // --- 4. SAGLIK: dejenere strateji grid'i ve promosyon kapisini anlamsizlastirir.
  //
  // DIKKAT — "dejenere" olcusu SINYAL orani olmali, KARAR orani degil. Bir strateji her
  // mumda veto uretebilir ve bu IYIDIR: veto'lar filtre bilancosunun (backtestAnalysis)
  // yakitidir, yani "bu filtre bana ne kazandirdi / ne kaybettirdi" sorusunun ham verisi.
  // Ilk yazimda karar noktasi sayisini kullanmistim ve gauntlet, Codex'ten TALEP ettigimiz
  // davranisi dogru yapan her stratejiyi "dejenere" diye reddediyordu.
  //
  // Gercek dejenerelik: mumlarin neredeyse tamaminda POZISYON acmak — yani secici olmamak,
  // surekli piyasada olmak. Bunu allocation orani olcer.
  const allocs = baseline.flatMap((d) => d.allocations);
  const pointsWithSignal = baseline.filter((d) => d.allocations.length > 0).length;
  const signalRate = args.init.points.length > 0 ? pointsWithSignal / args.init.points.length : 0;

  const problems: string[] = [];
  if (allocs.length === 0) problems.push('hic sinyal uretmiyor');
  if (signalRate > 0.95) {
    problems.push(
      `karar noktalarinin %${(signalRate * 100).toFixed(0)}inde pozisyon aciyor (dejenere: secici degil)`,
    );
  }
  const badConf = allocs.filter((a) => !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1);
  if (badConf.length > 0) problems.push(`${badConf.length} sinyalde confidence [0,1] disinda`);

  checks['saglik'] = {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${allocs.length} sinyal, ${pointsWithSignal}/${args.init.points.length} karar noktasinda pozisyon (%${(signalRate * 100).toFixed(0)})`
        : problems.join('; '),
  };

  const pass = Object.values(checks).every((c) => c.pass);
  return { pass, checks, feedback: buildFeedback(checks) };
}

/**
 * Verinin GELECEK yarisini kullanilamaz hale getirir.
 *
 * `poisonTime` = poison indeksindeki mumun openTime'i. O ana kadar (VE O AN DAHIL) verilen
 * kararlar, o mumu GORMEMELIDIR — cunku karar `t` aninda, yani o mum daha yeni ACILIRKEN
 * veriliyor; mum henuz KAPANMADI. Dolayisiyla i >= poison olan her mum ve indikator
 * copa cevrilse bile t <= poisonTime kararlari degismemeli.
 */
function poisonFuture(init: WorkerInit): { init: WorkerInit; poisonTime: number } {
  const klines: Record<string, Kline[]> = {};
  const indicators: Record<string, TechnicalIndicators[]> = {};

  // Zehir noktasi: veri araliginin ~%70'i (yeterince karar noktasi kalsin).
  const ref = init.klines[init.symbols[0]!] ?? [];
  const poisonIdx = Math.floor(ref.length * 0.7);
  const poisonTime = ref[poisonIdx]?.openTime ?? Number.MAX_SAFE_INTEGER;

  for (const symbol of init.symbols) {
    const ks = init.klines[symbol] ?? [];
    const ind = init.indicators[symbol] ?? [];

    klines[symbol] = ks.map((k, i) =>
      k.openTime < poisonTime
        ? k
        : {
            // Cop: gercek fiyattan tamamen kopuk, ama yapisal olarak gecerli mum.
            ...k,
            open: 1e9,
            high: 1e9,
            low: 1e9,
            close: 1e9,
            volume: 0,
          },
    );

    indicators[symbol] = ind.map((x, i) =>
      (ks[i]?.openTime ?? 0) < poisonTime ? x : EMPTY_INDICATORS,
    );
  }

  return { init: { ...init, klines, indicators }, poisonTime };
}

function fail(checks: Record<string, GauntletCheck>, name: string, detail: string): GauntletResult {
  checks[name] = { pass: false, detail };
  return { pass: false, checks, feedback: buildFeedback(checks) };
}

function buildFeedback(checks: Record<string, GauntletCheck>): string {
  const failed = Object.entries(checks).filter(([, c]) => !c.pass);
  if (failed.length === 0) return '';
  return failed.map(([name, c]) => `- ${name}: ${c.detail}`).join('\n');
}
