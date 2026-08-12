import fs from 'node:fs';
import path from 'node:path';
import { challenge, judge, sha256, type ChallengeResult } from '../src/engine/challenge';
import { loadMeta } from '../src/strategy/loader';
import mechanicalV0 from '../src/strategy/builtin/mechanicalV0';
import { env, type CandleInterval } from '../src/config/env';
import type { EvaluatedRun } from '../src/engine/promotion';
import type { StrategyProfile } from '../src/lib/types';
import type { Strategy } from '../src/strategy/types';

/**
 * Bir adayi sampiyona karsi yaristirir — gece dongusunun kalbi, elle kosulabilir hali.
 *
 *   npx tsx scripts/challenge.ts strategies/candidates/smoke/strategy.ts
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DAY = 86_400_000;

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Kullanim: npx tsx scripts/challenge.ts <aday.ts> [--days 540] [--holdout 90]');
    process.exit(1);
  }

  const source = fs.readFileSync(file, 'utf8');
  const days = Number(arg('days', String(env.nightly.backtestDays)));
  const holdoutDays = Number(arg('holdout', String(env.nightly.holdoutDays)));
  const symbols = (arg('symbols') ?? env.nightly.symbols.join(',')).split(',').map((s) => s.trim());
  const interval = (arg('interval', env.nightly.interval) ?? '4h') as CandleInterval;
  const profile = (arg('profile', 'balanced') ?? 'balanced') as StrategyProfile;

  const endDate = Date.now();
  const startDate = endDate - days * DAY;
  const holdoutStart = endDate - holdoutDays * DAY;

  console.log(`\nADAY     : ${path.basename(path.dirname(file))}/${path.basename(file)}`);
  console.log(`Semboller: ${symbols.join(', ')} | ${interval} | profil ${profile}`);
  console.log(`Secim    : ${iso(startDate)} -> ${iso(holdoutStart)}  (grid + walk-forward burada)`);
  console.log(`KASA     : ${iso(holdoutStart)} -> ${iso(endDate)}  (secim bunu HIC gormez)\n`);

  // --- Adayin metasini okumak icin sandbox disinda bir kez insa et.
  // (Sadece meta lazim: warmupBars, params. evaluate cagrilmayacak.)
  const strategy = await loadMeta(source);

  console.log(`Strateji : ${strategy.meta.name} v${strategy.meta.version} (${strategy.meta.author})`);
  if (strategy.meta.provenance?.arxivId) {
    console.log(`Kaynak   : arXiv:${strategy.meta.provenance.arxivId}`);
  }
  console.log();

  // --- SAMPIYON: bu gece, AYNI veri ve AYNI maliyetle yeniden kosulur.
  //     Saklanmis bir sayiyla karsilastirmak, farkli veri vintage'lariyla elma-armut yapmaktir.
  console.log('[1/2] SAMPIYON yeniden kosuluyor (elmayla elma)...');
  const champ = mechanicalV0();
  const champSource = fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');

  const champResult = await challenge({
    strategy: champ,
    source: champSource,
    sandboxed: false, // builtin: bizim kodumuz, izole etmeye gerek yok
    symbols, interval, startDate, endDate, holdoutDays,
    initialBalance: 10_000,
    profile,
    onProgress: progress('sampiyon'),
  });
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  report('SAMPIYON', champResult);

  // --- ADAY
  console.log('\n[2/2] ADAY degerlendiriliyor (validator -> gauntlet -> grid -> stres -> kasa)...');
  const candResult = await challenge({
    strategy,
    source,
    sandboxed: true,
    symbols, interval, startDate, endDate, holdoutDays,
    initialBalance: 10_000,
    profile,
    onProgress: progress('aday'),
  });
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  if (!candResult.ok) {
    console.log(`\nADAY REDDEDILDI — asama: ${candResult.failure}\n`);
    console.log(candResult.feedback);
    console.log('\nSAMPIYONA DOKUNULMADI.');
    return;
  }
  report('ADAY', candResult);

  // --- KAPI
  const championEval: EvaluatedRun | null = champResult.ok ? champResult.evaluated! : null;
  const verdict = judge(candResult, championEval);

  console.log('\n' + '='.repeat(64));
  console.log(`PROMOSYON KAPISI: ${verdict.promote ? 'GECTI — sampiyon degisiyor' : 'REDDEDILDI — sampiyon korunuyor'}`);
  console.log('='.repeat(64));

  if (verdict.reasons.length) {
    console.log('\nGecilen sartlar:');
    for (const r of verdict.reasons) console.log(`  + ${r}`);
  }
  if (verdict.blockers.length) {
    console.log('\nENGELLER:');
    for (const b of verdict.blockers) console.log(`  x ${b}`);
  }
  console.log();
}

function report(label: string, r: ChallengeResult): void {
  if (!r.ok) {
    console.log(`  ${label}: DEGERLENDIRILEMEDI (${r.failure})`);
    if (r.feedback) console.log(r.feedback.split('\n').map((l) => '    ' + l).join('\n'));
    return;
  }

  const s = r.selection!;
  const e = r.evaluated!;
  const b = s.best;

  console.log(`\n  --- ${label} ---`);
  console.log(`  hukum        : ${e.verdict}${s.fallbackUsed ? ' (hicbir hucre filtreleri gecemedi)' : ''}`);
  console.log(`  grid         : ${s.cells.length} hucre, ${s.scored?.filter((c) => !c.dq).length ?? 0} nitelikli`);
  console.log(`  en iyi risk  : RR ${b.risk.rewardRatio} | SL ${b.risk.slMultiplier} | CB ${b.risk.callbackMultiplier} | risk %${(b.risk.riskPerTradePct * 100).toFixed(1)}`);
  console.log(`  en iyi param : ${JSON.stringify(b.params)}`);
  console.log(`  plato        : ${e.qualifiedNeighbors} nitelikli komsu, ${e.dqNeighbors} diskalifiye komsu`);
  console.log(`  TEST         : ${pct(e.test.totalPnlPercent)} | MAR ${e.test.mar.toFixed(2)} | DD %${e.test.maxDrawdownPercent.toFixed(1)} | ${e.test.totalTrades} islem | ${e.windowsPositive}/${e.windowCount} pencere`);
  console.log(`  STRES        : ${pct(r.stress!.totalPnlPercent)}  (fee x1.5, slippage x2)`);
  console.log(`  KASA         : ${pct(r.holdout!.totalPnlPercent)} | DD %${r.holdout!.maxDrawdownPercent.toFixed(1)} | ${r.holdout!.totalTrades} islem`);
  console.log(`  maliyet payi : %${(e.test.feeShareOfGross * 100).toFixed(1)} (brut karin)`);

  if (r.gauntlet) {
    const g = Object.entries(r.gauntlet.checks)
      .map(([k, v]) => `${v.pass ? '+' : 'x'}${k}`)
      .join(' ');
    console.log(`  gauntlet     : ${g}`);
  }
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function progress(who: string) {
  return (stage: string, done: number, total: number) => {
    if (total > 1 && done % 40 !== 0 && done !== total) return;
    process.stdout.write(`\r  ${who}: ${stage} ${done}/${total}   `);
  };
}

main().catch((err) => {
  console.error('\nHATA:', err instanceof Error ? err.message : err);
  process.exit(1);
});
