import { decisionPoints } from '../src/engine/backtest';
import { decideNow } from '../src/engine/liveDecider';
import { loadDataset } from '../src/engine/dataset';
import { loadLiveChampion } from '../src/engine/liveExecutor';
import { SandboxPool } from '../src/strategy/sandbox/host';
import { compileStrategy } from '../src/strategy/validator';
import { buildApiDts, toSandboxSource } from '../src/codex/workspace';
import type { RecordedDecision } from '../src/engine/simulator';

/**
 * PARITE TESTI — testnet'e TEK EMIR gonderilmeden once gecilmesi gereken kapi.
 *
 * Soru: canli yol ile backtest yolu AYNI sinyali mi uretiyor?
 *
 *   npx tsx scripts/parity.ts [--days 120] [--samples 80]
 *
 * NE OLCULUYOR (ve ne olculmuyor)
 *
 * Sinyal MANTIGI artik iki yolda da ayni koddur: canli motor da backtest de stratejiyi
 * ayni sandbox worker'inda (strategy/sandbox/worker.ts) kosar. Yani "iki ayri karar
 * motoru birbirinden ayrisir" sinifi YAPISAL olarak kapatildi — ayri bir canli karar
 * yolu artik yok.
 *
 * Geriye kalan ve BU TESTIN kovaladigi risk VERIDE ve BAR SECIMINDE:
 *
 *   - Canli, backtest'in 540 gunluk penceresini degil yalnizca son birkac yuz mumu
 *     yukler. Warmup yetmezse indikatorler (EMA200, ADX, Fib) FARKLI cikar ve strateji
 *     ayni mumda baska bir karar verir.
 *   - Karar bari bir mum kayarsa (kapanmamis mumu dahil etmek, `<` yerine `<=`) canli,
 *     backtest'in gormedigi bir fiyattan karar verir.
 *
 * Ikisi de SESSIZDIR: her iki taraf da kendi icinde tutarli calisir, hicbir test kirmizi
 * yanmaz, ve sistem gerceklesmeyen bir strateji hakkinda rapor uretir. Bu test tam olarak
 * o ayrismayi arar: gecmis karar noktalarinda canli fonksiyonun ta kendisini (decideNow —
 * executor'un cagirdigi fonksiyon) kosar ve backtest'in RECORD pass'i ile karsilastirir.
 *
 * Kirmizi yanarsa: walk-forward, kasa, promosyon gerekceleri, heatmap — HEPSI baska bir
 * strateji hakkindadir. Bir log satiri degil, bir DURDURMA sebebidir.
 */

const DAY = 86_400_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const days = Number(arg('days', '120'));
  const maxSamples = Number(arg('samples', '80'));

  // Canli motorun yukledigi sampiyonun AYNISI (sha dogrulanir).
  const champ = await loadLiveChampion();
  const { symbols, interval, params, profile } = champ;

  const endDate = Date.now();
  const startDate = endDate - days * DAY;

  console.log(`\nSampiyon : ${champ.name} (${champ.id})`);
  console.log(`Semboller: ${symbols.join(', ')} | ${interval}`);
  console.log(`Pencere  : ${days} gun\n`);

  const points = decisionPoints(startDate, endDate, interval).filter((t) => t < endDate);

  // --- YOL A: backtest yolu — tum karar noktalari TEK worker init'inde.
  console.log('Yol A: backtest (RECORD pass, tum noktalar tek seferde)...');

  const ds = loadDataset({ symbols, interval, startDate, endDate });

  const c = compileStrategy(toSandboxSource(champ.source), buildApiDts());
  if (!c.ok) throw new Error('sampiyon derlenmedi: ' + JSON.stringify(c.diagnostics));

  const pool = SandboxPool.create(
    {
      compiledJs: c.js!,
      symbols,
      interval,
      points,
      klines: ds.klines,
      indicators: ds.indicators,
      funding: ds.funding,
    },
    { workers: 1 },
  );

  const backtest = await pool.run({ cellIndex: 0, params, profile, macroRiskAppetite: null });
  await pool.close();
  ds.close();

  const btByTime = new Map(backtest.map((d) => [d.timestamp, d]));

  /**
   * Ornekleme: canli yol her cagrida kendi veri penceresini yukler ve kendi worker'ini
   * kurar — pahali. Her noktayi kosmak yerine ONEMLI noktalari kosuyoruz:
   *
   *   - backtest'in KARAR URETTIGI tum noktalar (canli bunlari kacirirsa: sessiz kayip)
   *   - arti bir miktar SESSIZ nokta (canli buralarda sinyal uretirse: hayalet islem)
   *
   * Ikinci grup en az birincisi kadar onemli: yalnizca karar noktalarina bakan bir test,
   * canlinin FAZLADAN pozisyon actigi durumu goremez.
   */
  const decided = points.filter((t) => btByTime.has(t));
  const silent = points.filter((t) => !btByTime.has(t));

  const sample = [...pick(decided, Math.ceil(maxSamples / 2)), ...pick(silent, Math.floor(maxSamples / 2))].sort(
    (a, b) => a - b,
  );

  console.log(`Yol B: canli (liveDecider.decideNow — executor'un cagirdigi fonksiyon)...`);
  console.log(`       ${sample.length} nokta ornekleniyor (${decided.length} kararli / ${silent.length} sessiz)\n`);

  let matched = 0;
  const mismatches: string[] = [];

  for (const at of sample) {
    const live = await decideNow({
      source: champ.source,
      params,
      profile,
      symbols,
      interval,
      at,
      warmupBars: champ.warmupBars,
      macroRiskAppetite: null,
    });

    const a = norm(btByTime.get(at));
    const b = norm(live);

    if (a === b) matched++;
    else if (mismatches.length < 5) {
      mismatches.push(
        `  ${new Date(at).toISOString()}\n    backtest: ${a || '(karar yok)'}\n    canli   : ${b || '(karar yok)'}`,
      );
    }
  }

  const rate = sample.length > 0 ? (matched / sample.length) * 100 : 0;

  console.log(`Ornek noktasi: ${sample.length}`);
  console.log(`Eslesen      : ${matched}  (%${rate.toFixed(2)})\n`);

  if (matched === sample.length && sample.length > 0) {
    console.log('PARITE TAM. Canli yol ile backtest yolu birebir ayni sinyali uretiyor.');
    console.log('Testnet execution icin guvenli.\n');
    return;
  }

  console.log('PARITE BOZUK — TESTNET EMRI GONDERILMEMELI.\n');
  if (mismatches.length) {
    console.log('Ilk uyusmazliklar:');
    for (const m of mismatches) console.log(m);
  }
  console.log(
    '\nBu, sistemin urettigi her sayinin (walk-forward, kasa, promosyon gerekceleri)\n' +
      'gerceklesmeyen bir strateji hakkinda oldugu anlamina gelir. Once bunu duzelt.\n',
  );
  process.exit(1);
}

/** Bir kararin karsilastirilabilir imzasi: sembol sirasindan bagimsiz. */
function norm(d: RecordedDecision | { allocations: RecordedDecision['allocations'] } | undefined): string {
  if (!d) return '';
  return [...d.allocations]
    .sort((x, y) => x.symbol.localeCompare(y.symbol))
    .map((x) => `${x.symbol}:${x.side}:${x.confidence}:${x.leverage}:${x.allocationPercent}`)
    .join('|');
}

/** Diziyi esit araliklarla n elemana indirir (bas ve son dahil). */
function pick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]!);
  return out;
}

main().catch((err) => {
  console.error('\nHATA:', err instanceof Error ? err.message : err);
  process.exit(1);
});
