import { DQ_LABELS } from '../engine/gridScoring';
import { exitBreakdown } from './weakness';
import type { ChallengeResult } from '../engine/challenge';
import type { PromotionVerdict } from '../engine/promotion';
import type { ChampionRecord } from './champion';
import type { PaperPick } from '../research/selector';

/**
 * Gece raporu.
 *
 * En onemli bolum PROMOSYON KARARI ve onun GEREKCELERI. Bir gece "promote etmedim"
 * diyorsa, NEDEN etmedigini tek tek gormek gerekir — yoksa sistem sessizce hicbir sey
 * yapmayan bir cron job'a doner ve bunu kimse fark etmez.
 */

export interface ReportArgs {
  runId: string;
  before: ChampionRecord | null;
  after: ChampionRecord | null;
  promoted: boolean;
  stages: Record<string, { ok: boolean; detail: string }>;
  champ: ChallengeResult | null;
  cand: ChallengeResult | null;
  verdict: PromotionVerdict | null;
  paper: PaperPick | null;
}

export function renderReport(a: ReportArgs): string {
  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p(`# ${a.runId}`);
  p();
  p(a.promoted ? `## New champion -> ${a.after?.name} v${a.after?.version}` : '## Champion kept');
  p();
  p(`Previous champion: **${a.before?.name ?? 'Mechanical Tier-Composite v0 (builtin)'}**`);
  p();

  // --- Asamalar
  p('## Stages');
  p();
  p('| stage | status | detail |');
  p('|---|---|---|');
  for (const [name, s] of Object.entries(a.stages)) {
    p(`| ${name} | ${s.ok ? 'OK' : 'FAILED'} | ${s.detail} |`);
  }
  p();

  // --- Makale
  if (a.paper) {
    p('## Paper considered');
    p();
    p(`**${a.paper.paper.title}**`);
    p();
    p(
      `arXiv:${a.paper.paper.id} | score ${a.paper.score}/10 | selected by ${a.paper.by === 'llm' ? 'LLM' : 'keyword ranker (fallback)'} | ${a.paper.paper.categories.join(', ')}`,
    );
    p();
    p(`**Why this paper:** ${a.paper.reason}`);
    p();
    // Hipotez ve aci, gecenin *fikrini* tek bakista okunur kilar. Aday reddedilse bile
    // burasi kalir: hangi fikri denedigimiz, denemenin sonucundan bagimsiz bir kayittir.
    if (a.paper.hypothesis) {
      p(`**Hypothesis:** ${a.paper.hypothesis}`);
      p();
    }
    if (a.paper.angle) {
      p(`**Implementation angle:** ${a.paper.angle}`);
      p();
    }
    p(`> ${a.paper.paper.summary.slice(0, 600)}...`);
    p();
    p(`<${a.paper.paper.absUrl}>`);
    p();
  }

  // --- Karsilastirma
  p('## Champion vs candidate');
  p();
  p('Note: the champion was re-run TONIGHT, on the same data and the same cost model as');
  p('the candidate. Comparing against a stored number would put two different data');
  p('vintages side by side and call the difference an improvement.');
  p();
  p('| | CHAMPION | CANDIDATE |');
  p('|---|---|---|');
  p(`| verdict | ${v(a.champ, (c) => c.evaluated!.verdict)} | ${v(a.cand, (c) => c.evaluated!.verdict)} |`);
  p(`| test P&L | ${v(a.champ, (c) => pct(c.evaluated!.test.totalPnlPercent))} | ${v(a.cand, (c) => pct(c.evaluated!.test.totalPnlPercent))} |`);
  p(`| test MAR | ${v(a.champ, (c) => c.evaluated!.test.mar.toFixed(2))} | ${v(a.cand, (c) => c.evaluated!.test.mar.toFixed(2))} |`);
  p(`| test drawdown | ${v(a.champ, (c) => c.evaluated!.test.maxDrawdownPercent.toFixed(1) + '%')} | ${v(a.cand, (c) => c.evaluated!.test.maxDrawdownPercent.toFixed(1) + '%')} |`);
  p(`| trades | ${v(a.champ, (c) => String(c.evaluated!.test.totalTrades))} | ${v(a.cand, (c) => String(c.evaluated!.test.totalTrades))} |`);
  p(`| positive windows | ${v(a.champ, (c) => `${c.evaluated!.windowsPositive}/${c.evaluated!.windowCount}`)} | ${v(a.cand, (c) => `${c.evaluated!.windowsPositive}/${c.evaluated!.windowCount}`)} |`);
  p(`| **cost stress** | ${v(a.champ, (c) => pct(c.stress!.totalPnlPercent))} | ${v(a.cand, (c) => pct(c.stress!.totalPnlPercent))} |`);
  p(`| **HOLDOUT** (never seen) | ${v(a.champ, (c) => pct(c.holdout!.totalPnlPercent))} | ${v(a.cand, (c) => pct(c.holdout!.totalPnlPercent))} |`);
  p(`| plateau (qualifying neighbours) | ${v(a.champ, (c) => String(c.evaluated!.qualifiedNeighbors))} | ${v(a.cand, (c) => String(c.evaluated!.qualifiedNeighbors))} |`);
  p();

  // --- Promosyon karari
  p('## Promotion decision');
  p();
  if (!a.verdict) {
    p('No candidate was produced to evaluate. **The champion was left untouched.**');
  } else {
    p(a.verdict.promote ? '**PROMOTED** — the new champion is live.' : '**REJECTED** — the champion is kept.');
    p();
    if (a.verdict.reasons.length) {
      p('### Conditions met');
      p();
      for (const r of a.verdict.reasons) p(`- ${r}`);
      p();
    }
    if (a.verdict.blockers.length) {
      p('### Blockers');
      p();
      for (const b of a.verdict.blockers) p(`- **${b}**`);
      p();
    }
  }

  // --- Grid detayi
  if (a.cand?.ok && a.cand.selection) {
    const s = a.cand.selection;
    p('## Candidate grid');
    p();
    p(`${s.cells.length} cells | axes: ${s.axes.map((x) => `${x.name}(${x.values.length})`).join(' x ')}`);
    p();

    const QUALIFIED = 'qualified';
    const dq = new Map<string, number>();
    for (const c of s.scored ?? []) dq.set(c.dq ?? QUALIFIED, (dq.get(c.dq ?? QUALIFIED) ?? 0) + 1);

    p('| disqualification | cells |');
    p('|---|---|');
    for (const [k, n] of [...dq.entries()].sort((x, y) => y[1] - x[1])) {
      p(`| ${k === QUALIFIED ? '**qualified**' : DQ_LABELS[k as keyof typeof DQ_LABELS]} | ${n} |`);
    }
    p();

    const exits = exitBreakdown(s.bestRun.trades);
    if (Object.keys(exits).length) {
      p(`Exit reasons: ${Object.entries(exits).map(([k, n]) => `${k} ${n}`).join(' | ')}`);
      p();
    }
  }

  // --- Gauntlet
  if (a.cand?.gauntlet) {
    p('## Gauntlet');
    p();
    p('| check | result | detail |');
    p('|---|---|---|');
    for (const [k, c] of Object.entries(a.cand.gauntlet.checks)) {
      p(`| ${k} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`);
    }
    p();
  }

  // --- Reddedilen aday
  if (a.cand && !a.cand.ok) {
    p('## Candidate rejected');
    p();
    p(`Stage: **${a.cand.failure}**`);
    p();
    p('```');
    p(a.cand.feedback ?? '');
    p('```');
    p();
  }

  return L.join('\n');
}

function v(r: ChallengeResult | null, f: (c: ChallengeResult) => string): string {
  if (!r) return '—';
  if (!r.ok) return `_${r.failure}_`;
  try {
    return f(r);
  } catch {
    return '—';
  }
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
