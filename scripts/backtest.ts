import { runBacktest, DEFAULT_GRID } from '../src/engine/backtest';
import { assertCoverage, loadDataset } from '../src/engine/dataset';
import { DEFAULT_COSTS, ZERO_COSTS } from '../src/engine/costModel';
import { DQ_LABELS } from '../src/engine/gridScoring';
import mechanicalV0 from '../src/strategy/builtin/mechanicalV0';
import { env, type CandleInterval } from '../src/config/env';
import type { StrategyProfile } from '../src/lib/types';

/**
 * Tek bir backtest kosar ve sonucu yazdirir.
 *
 *   npx tsx scripts/backtest.ts --days 180 --symbols BTCUSDT,ETHUSDT
 *   npx tsx scripts/backtest.ts --days 180 --no-costs      # maliyet etkisini olcmek icin
 *   npx tsx scripts/backtest.ts --days 180 --single        # grid yok, tek hucre
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const days = Number(arg('days', '180'));
  const symbols = (arg('symbols') ?? env.nightly.symbols.join(',')).split(',').map((s) => s.trim());
  const interval = (arg('interval', env.nightly.interval) ?? '4h') as CandleInterval;
  const profile = (arg('profile', 'balanced') ?? 'balanced') as StrategyProfile;
  const initialBalance = Number(arg('balance', '10000'));
  const costs = flag('no-costs') ? ZERO_COSTS : DEFAULT_COSTS;

  const endDate = Date.now();
  const startDate = endDate - days * DAY_MS;

  const strategy = mechanicalV0();

  console.log(`\nStrateji : ${strategy.meta.name} v${strategy.meta.version}`);
  console.log(`Semboller: ${symbols.join(', ')} | ${interval} | ${days} gun | profil ${profile}`);
  console.log(`Maliyet  : ${costs.takerFeeBps > 0 ? `taker ${costs.takerFeeBps}bps + slippage + funding` : 'KAPALI'}`);

  const ds = loadDataset({ symbols, interval, startDate, endDate });
  assertCoverage(ds, { symbols, interval, startDate, endDate });

  const bars = Object.values(ds.klines).reduce((s, k) => s + k.length, 0);
  console.log(`Veri     : ${bars.toLocaleString()} mum yuklendi\n`);

  const t0 = Date.now();
  const out = await runBacktest({
    strategy,
    symbols,
    interval,
    startDate,
    endDate,
    initialBalance,
    profile,
    klines: ds.klines,
    indicators: ds.indicators,
    funding: ds.funding,
    lsr: ds.lsr,
    macroRiskAppetite: null,
    intrabar: ds.intrabar,
    costs,
    grid: DEFAULT_GRID,
    ...(flag('single') ? { fixedParams: defaultParams(strategy) } : {}),
    onProgress: (done, total) => {
      if (done % 20 === 0 || done === total) {
        process.stdout.write(`\r  grid: ${done}/${total} hucre...`);
      }
    },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\r  grid: ${out.cells.length} hucre, ${elapsed}sn\n`);

  // --- Walk-forward
  console.log(`Walk-forward: ${out.plan.windows.length} pencere (${out.plan.rolling ? 'kayan' : 'tek bolme'})`);
  console.log(`  split: ${new Date(out.plan.splitTime).toISOString().slice(0, 10)}`);
  console.log(`  HUKUM: ${out.verdict}${out.fallbackUsed ? '  (hicbir hucre filtreleri gecemedi)' : ''}\n`);

  // --- Diskalifiye dagilimi: hucreler NEDEN elendi? Bu tablo, bir gecenin neden
  //     aday uretemedigini anlamanin en hizli yolu.
  if (out.scored) {
    const dqCounts = new Map<string, number>();
    for (const s of out.scored) {
      const key = s.dq ?? 'GECTI';
      dqCounts.set(key, (dqCounts.get(key) ?? 0) + 1);
    }
    console.log('Hucre elemesi:');
    for (const [k, n] of [...dqCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const label = k === 'GECTI' ? 'nitelikli' : DQ_LABELS[k as keyof typeof DQ_LABELS];
      console.log(`  ${String(n).padStart(4)}  ${label}`);
    }
    console.log();
  }

  // --- En iyi hucre
  const b = out.best;
  const r = b.results;
  const test = b.testResults!;

  console.log('EN IYI HUCRE');
  console.log(`  risk  : RR ${b.risk.rewardRatio} | SL ${b.risk.slMultiplier}xATR | CB ${b.risk.callbackMultiplier}xATR`);
  console.log(`  param : ${JSON.stringify(b.params)}`);
  if (b.plateauScore !== undefined) console.log(`  skor  : ${b.plateauScore.toFixed(3)} (plato)`);
  console.log();

  const row = (label: string, v: string) => console.log(`  ${label.padEnd(22)} ${v}`);
  console.log('TAM DONEM');
  row('PnL', `${r.totalPnlPercent >= 0 ? '+' : ''}${r.totalPnlPercent.toFixed(1)}%  ($${r.totalPnl.toFixed(0)})`);
  row('islem / kazanma', `${r.totalTrades} / %${r.winRate.toFixed(0)}`);
  row('max drawdown', `%${r.maxDrawdownPercent.toFixed(1)}`);
  row('Sharpe / Sortino', `${r.sharpeRatio.toFixed(2)} / ${r.sortinoRatio.toFixed(2)}`);
  row('MAR (CAGR/DD)', `${r.mar.toFixed(2)}`);
  row('profit factor', `${r.profitFactor.toFixed(2)}`);
  row('beklenti (R)', `${r.expectancyR.toFixed(3)}R`);
  console.log();
  row('komisyon', `$${r.totalFeesUSD.toFixed(0)}`);
  row('funding', `$${r.totalFundingUSD.toFixed(0)}`);
  row('maliyet / brut kar', `%${(r.feeShareOfGross * 100).toFixed(1)}`);
  row('devir hacmi', `$${(r.turnoverUSD / 1000).toFixed(0)}k`);
  console.log();

  console.log('TEST DILIMI (secimde kullanilmayan)');
  row('PnL', `${test.totalPnlPercent >= 0 ? '+' : ''}${test.totalPnlPercent.toFixed(1)}%`);
  row('islem', `${test.totalTrades}`);
  row('max drawdown', `%${test.maxDrawdownPercent.toFixed(1)}`);
  row('pozitif pencere', `${b.windowsPositive}/${out.plan.windows.length}`);
  console.log();

  // --- Cikis nedenleri: stratejinin nasil oldugunu anlatir.
  const byReason = new Map<string, number>();
  for (const t of out.bestRun.trades) byReason.set(t.exitReason, (byReason.get(t.exitReason) ?? 0) + 1);
  if (byReason.size > 0) {
    console.log('Cikis nedenleri: ' + [...byReason.entries()].map(([k, v]) => `${k} ${v}`).join(' | '));
  }

  const skipCounts = new Map<string, number>();
  for (const s of out.bestRun.skips) skipCounts.set(s.rule, (skipCounts.get(s.rule) ?? 0) + 1);
  if (skipCounts.size > 0) {
    console.log('Atlanan girisler: ' + [...skipCounts.entries()].map(([k, v]) => `${k} ${v}`).join(' | '));
  }

  ds.close();
}

function defaultParams(s: ReturnType<typeof mechanicalV0>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const p of s.meta.params) out[p.key] = p.default;
  return out;
}

main().catch((err) => {
  console.error('\nHATA:', err instanceof Error ? err.message : err);
  process.exit(1);
});
