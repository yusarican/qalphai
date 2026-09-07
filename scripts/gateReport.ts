import fs from 'node:fs';
import { analyzeGates, chooseAnalysisRisk, type GateBalance } from '../src/engine/gateAnalysis';
import { assertCoverage, loadDataset } from '../src/engine/dataset';
import { DEFAULT_COSTS, ZERO_COSTS } from '../src/engine/costModel';
import { DEFAULT_RISK_PARAMS } from '../src/engine/riskManagement';
import { listModels } from '../src/orchestrator/models';
import { loadMeta } from '../src/strategy/loader';
import mechanicalV0 from '../src/strategy/builtin/mechanicalV0';
import { env, type CandleInterval } from '../src/config/env';
import type { StrategyProfile } from '../src/lib/types';

/**
 * GATE BILANCOSU RAPORU — "hangi filtre bize ne kazandiriyor, ne kaybettiriyor?"
 *
 *   npx tsx scripts/gateReport.ts --days 540
 *   npx tsx scripts/gateReport.ts --model mechanical-v0@builtin --days 365
 *   npx tsx scripts/gateReport.ts --model "candidate:nightly-2026-08-12" --days 180
 *
 * `--model` verilmezse builtin mekanik v0 olculur. Model kimlikleri `listModels()`
 * ciktisiyla ayni (panel /models sayfasindaki satirlar).
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const days = Number(arg('days', '365'));
  const modelId = arg('model');
  const symbols = (arg('symbols') ?? env.nightly.symbols.join(',')).split(',').map((s) => s.trim());
  const interval = (arg('interval', env.nightly.interval) ?? '4h') as CandleInterval;
  const profile = (arg('profile', 'balanced') ?? 'balanced') as StrategyProfile;
  const initialBalance = Number(arg('balance', '10000'));

  const endDate = arg('end') ? Date.parse(arg('end')!) : Date.now();
  const startDate = endDate - days * DAY_MS;

  // --- Model secimi. Belirtilmezse builtin: hicbir kapidan gecmemis baslangic noktasi.
  let strategy = mechanicalV0();
  let source = fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');
  let sandboxed = false;
  let params: Record<string, number | boolean> = {};
  let risk = DEFAULT_RISK_PARAMS;
  let hasRecordedRisk = false;
  let name = strategy.meta.name;

  if (modelId) {
    const model = (await listModels()).find((m) => m.id === modelId);
    if (!model) throw new Error(`model bulunamadi: ${modelId}`);
    if (!model.runnable) throw new Error(`${model.name} kosulamaz: ${model.blockedReason}`);
    source = fs.readFileSync(model.codePath, 'utf8');
    strategy = await loadMeta(source);
    sandboxed = model.origin !== 'builtin';
    params = model.params;
    risk = model.risk;
    name = model.name;
    hasRecordedRisk = model.evaluation !== null;
  }

  if (Object.keys(params).length === 0) {
    for (const p of strategy.meta.params) params[p.key] = p.default;
  }

  // Hangi risk hucresinde olctugumuz EKRANA YAZILIR (bkz. chooseAnalysisRisk):
  // varsayilan %5 preset builtin'i likide ediyor ve karsi-olgusal olcumu anlamsiz kilar.
  const chosen = chooseAnalysisRisk({
    risk,
    hasRecordedCell: hasRecordedRisk,
    ...(arg('risk-per-trade') ? { override: Number(arg('risk-per-trade')) } : {}),
  });
  risk = chosen.risk;

  console.log(`\nModel     : ${name}${sandboxed ? ' (sandbox)' : ' (builtin)'}`);
  console.log(`Pencere   : ${iso(startDate)} -> ${iso(endDate)} (${days} gun, ${interval})`);
  console.log(`Semboller : ${symbols.join(', ')} | profil ${profile}`);
  console.log(`Parametre : ${JSON.stringify(params)}`);
  console.log(`Risk      : rr ${risk.rewardRatio}, sl ${risk.slMultiplier} — ${chosen.note}`);

  const ds = loadDataset({ symbols, interval, startDate, endDate });
  assertCoverage(ds, { symbols, interval, startDate, endDate });

  try {
    const res = await analyzeGates({
      strategy,
      source,
      sandboxed,
      symbols,
      interval,
      startDate,
      endDate,
      initialBalance,
      profile,
      params,
      risk,
      costs: flag('no-costs') ? ZERO_COSTS : DEFAULT_COSTS,
      dataset: ds,
      onProgress: (done, total, rule) => process.stdout.write(`\r  olculuyor ${done}/${total}: ${rule}          `),
    });
    process.stdout.write('\r'.padEnd(60) + '\r');

    if (res.warnings.length > 0) {
      console.log(`\n${'!'.repeat(90)}`);
      for (const w of res.warnings) console.log(`  ${w}`);
      console.log('!'.repeat(90));
    }

    const b = res.baseline;
    console.log(`\nTEMEL KOSU${res.baselineUsable ? '' : '  [KIYAS TABANI OLARAK KULLANILAMAZ]'}`);
    console.log(`  PnL ${pct(b.totalPnlPercent)} | ${b.totalTrades} islem | DD %${b.maxDrawdownPercent.toFixed(1)} | beklenti ${b.expectancyR.toFixed(3)}R`);
    console.log(
      `\nKarsi-olgu guveni: ${res.liftedConfidence.toFixed(2)} (${res.liftedConfidenceSource})` +
        ` — VARSAYIM: vetolanmis barda strateji hicbir zaman confidence uretmedi.`,
    );
    console.log(`Ek RECORD gecisi : ${res.recordPasses}\n`);

    if (!res.baselineUsable) {
      console.log('Asagidaki hukumler ANLAMSIZDIR — yukaridaki uyariya bakin.\n');
    }

    console.log(row('KURAL', 'TIP', 'TETIK', 'DPnL%', 'DR', 'DDD%', 'DISLEM', 'HUKUM'));
    console.log('-'.repeat(96));
    for (const g of res.gates) console.log(format(g));

    const unmeasured = res.gates.filter((g) => !g.counterfactual);
    if (unmeasured.length > 0) {
      console.log(`\nOLCULEMEYENLER`);
      for (const g of unmeasured) console.log(`  ${g.rule} (${g.firedCount} tetik): ${g.note}`);
    }

    console.log(
      `\nOKUMA: DPnL% = "gate OLMASAYDI" kosusunun temelden farki.` +
        `\n  pozitif -> gate KAYBETTIRIYOR (kaldirmak kar getirirdi)` +
        `\n  negatif -> gate KORUYOR (kaldirmak zarar getirirdi)\n`,
    );
  } finally {
    ds.close();
  }
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

function row(...cells: string[]): string {
  const w = [24, 15, 7, 9, 8, 8, 8, 14];
  return cells.map((c, i) => c.padEnd(w[i]!)).join('');
}

function format(g: GateBalance): string {
  const c = g.counterfactual;
  return row(
    g.rule.slice(0, 23),
    g.kind === 'strategy-veto' ? 'strateji' : 'harness',
    String(g.firedCount),
    c ? pct(c.deltaPnlPct) : '—',
    c ? c.deltaExpectancyR.toFixed(3) : '—',
    c ? c.deltaMaxDDPct.toFixed(1) : '—',
    c ? String(c.deltaTrades) : '—',
    c ? c.verdict : 'olculemedi',
  );
}

main().catch((err) => {
  console.error(`\nHATA: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
