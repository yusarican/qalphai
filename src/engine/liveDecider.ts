import { loadDataset } from './dataset';
import { SandboxPool } from '../strategy/sandbox/host';
import { compileStrategy } from '../strategy/validator';
import { buildApiDts, toSandboxSource } from '../codex/workspace';
import { INTERVAL_MS } from '../lib/klineStore';
import type { RecordedDecision } from './simulator';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';

/**
 * CANLI KARAR — ANTI-DRIFT'IN KALBI.
 *
 * Buradaki tek onemli fikir su: canli motor, backtest'ten FARKLI bir kod yolu
 * KULLANMAZ. Ayni sandbox worker'i (strategy/sandbox/worker.ts runRecordPass), ayni
 * context kesiti (engine/context.ts), ayni tahsis (engine/portfolio.ts) — tek fark,
 * karar noktasi listesinin tek elemanli olmasi: points = [at].
 *
 * Alternatif — canli icin ayri bir "sadelestirilmis" karar yolu yazmak — sistemin en
 * sinsi basarisizlik modudur: iki yol da kendi icinde tutarli calisir, ikisi de yesil
 * test verir, ama olctugumuz strateji ile parayi yoneten strateji ayrisir. O zaman
 * walk-forward, kasa, promosyon gerekceleri — hepsi gerceklesmeyen bir strateji
 * hakkinda konusuyor olur.
 *
 * Bu yuzden ayri yol YOK. Parite bir temenni degil, YAPISAL bir sonuc.
 *
 * Geriye kalan gercek risk sinyalde degil VERIDE: canli, backtest'in 540 gunluk
 * penceresini degil, yalnizca son birkac yuz mumu yukler. Warmup yetmezse veya bar
 * secimi bir kayarsa canli ile backtest IRAKSAR — ve bunu yakalayan sey scripts/parity.ts'tir
 * (ayni fonksiyonu gecmis karar noktalarinda kosup backtest'in RECORD pass'i ile karsilastirir).
 */

/** Karar barinin kapanmis mumla dolmasi icin gereken emniyet payi. */
const WARMUP_SAFETY_BARS = 20;

export interface DecideNowArgs {
  /** Sampiyon kaynagi — cagiran taraf sha256'yi DOGRULAMIS olmali (champion.loadChampionSource). */
  source: string;
  params: Record<string, number | boolean>;
  profile: StrategyProfile;
  symbols: string[];
  interval: CandleInterval;
  /** Karar ani: bir mumun openTime'i. Bu andan ONCE acilmis mumlar gorulur (kati `<`). */
  at: number;
  /** Strateji meta.warmupBars — yeterli kapali mum yoksa strateji hic cagrilmaz. */
  warmupBars: number;
  macroRiskAppetite?: 'risk_on' | 'risk_off' | 'mixed' | null;
}

export interface LiveDecision extends RecordedDecision {
  at: number;
}

/**
 * `at` aninda sampiyonun kararini uretir. Sandbox worker'inda kosar (Codex kodu ana
 * surece asla girmez), tam olarak backtest'in RECORD pass'i gibi.
 */
export async function decideNow(args: DecideNowArgs): Promise<LiveDecision> {
  const c = compileStrategy(toSandboxSource(args.source), buildApiDts());
  if (!c.ok) {
    throw new Error(
      'sampiyon derlenmedi:\n' +
        c.diagnostics.map((d) => `  [${d.code}] satir ${d.line}: ${d.message}`).join('\n'),
    );
  }

  // Veri penceresi: karar barindan warmup kadar geri. loadDataset zaten 260 bar warmup
  // ekler; ustune stratejinin kendi warmupBars'i ve bir emniyet payi konur.
  const ms = INTERVAL_MS[args.interval];
  const lookbackMs = (args.warmupBars + WARMUP_SAFETY_BARS) * ms;

  const ds = loadDataset({
    symbols: args.symbols,
    interval: args.interval,
    startDate: args.at - lookbackMs,
    endDate: args.at,
  });

  try {
    assertDecidable(ds, args);

    const pool = SandboxPool.create(
      {
        compiledJs: c.js!,
        symbols: args.symbols,
        interval: args.interval,
        points: [args.at], // <-- TEK karar noktasi. Backtest'te bu liste binlerce elemanli.
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
      },
      { workers: 1 },
    );

    try {
      const decisions = await pool.run({
        cellIndex: 0,
        params: args.params,
        profile: args.profile,
        macroRiskAppetite: args.macroRiskAppetite ?? null,
      });

      // Worker yalnizca DOLU kararlari dondurur (worker.ts:243) — sinyal de veto da
      // yoksa dizi bostur. Bu "karar yok" demektir, hata degil.
      const d = decisions[0];
      return {
        at: args.at,
        timestamp: args.at,
        allocations: d?.allocations ?? [],
        rejections: d?.rejections ?? [],
      };
    } finally {
      await pool.close();
    }
  } finally {
    ds.close();
  }
}

/**
 * Karar barinin ONCESINDE her sembol icin yeterli KAPALI mum var mi?
 *
 * Eksik veriyle karar vermek, sessizce yanlis karar vermektir: warmup dolmadiginda
 * buildStrategyContext null doner (context.ts:56), strateji hic cagrilmaz ve sembol
 * "sinyal yok" gibi gorunur. Canlida bu, gercek bir sinyali KACIRMAK demektir ve
 * hicbir yerde hata olarak gorunmez. O yuzden burada GURULTULU duruyoruz.
 */
function assertDecidable(
  ds: ReturnType<typeof loadDataset>,
  args: Pick<DecideNowArgs, 'symbols' | 'at' | 'warmupBars' | 'interval'>,
): void {
  const problems: string[] = [];
  const ms = INTERVAL_MS[args.interval];

  for (const symbol of args.symbols) {
    const ks = ds.klines[symbol] ?? [];
    const closed = ks.filter((k) => k.openTime < args.at);

    if (closed.length < args.warmupBars) {
      problems.push(
        `${symbol}: karar barindan once ${closed.length} kapali mum var (>= ${args.warmupBars} gerekli)`,
      );
      continue;
    }

    // Son kapali mum, karar barinin HEMEN oncekisi olmali. Degilse veri bayat:
    // strateji eski bir mumdan karar verir ve bunu kimse fark etmez.
    const last = closed[closed.length - 1]!;
    if (last.openTime !== args.at - ms) {
      problems.push(
        `${symbol}: son kapali mum ${new Date(last.openTime).toISOString()}, ` +
          `beklenen ${new Date(args.at - ms).toISOString()} — veri bayat, once senkron kos`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Karar verilemez:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Su an gecerli karar bari: kapanan SON mumun hemen ardindaki sinir.
 *
 * Backtest'te karar noktalari mum sinirlaridir (backtest.ts:361 decisionPoints) ve
 * `at` aninda strateji openTime < at olan mumlari gorur — yani en taze gordugu mum
 * [at - ms, at) araligindaki KAPANMIS mumdur. Canlida ayni tanim: simdiki ani iceren
 * mum sinirina asagi yuvarla. O sinirda bir onceki mum yeni kapanmistir.
 */
export function currentDecisionBar(interval: CandleInterval, now = Date.now()): number {
  const ms = INTERVAL_MS[interval];
  return Math.floor(now / ms) * ms;
}
