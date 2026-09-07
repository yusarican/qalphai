import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config/env';
import type { AgentMessage } from '../../lib/agentLlm';

/**
 * ORCHESTRATOR KOSU KAYDI.
 *
 * Bir kosu saatler surebiliyor (tek gate analizi dakikalar, otopsi + nuks taramasi
 * daha fazla). Sureç bu sirada olurse — yeniden baslatma, guc kesintisi, `start.sh`'in
 * Ctrl+C'si — hicbir sey kaybolmamali: yapilan agir hesaplar diskte, konusma gecmisi
 * diskte, ve rapor yarim da olsa okunabilir olmali.
 *
 * Neden JSON: gece raporlariyla ayni gerekce. Bu bir zaman serisi degil, kosu basina
 * tek bir kayit ve okuyan taraf (panel) tamamini birden istiyor.
 */

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface RunStep {
  n: number;
  at: number;
  /** Modelin o turdaki metni (varsa). */
  text: string;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; summary: string; ms: number }>;
  usage: { inTokens: number; outTokens: number };
}

export interface OrchestratorRun {
  id: string;
  task: string;
  trigger: 'pre-nightly' | 'post-nightly' | 'manual' | 'live-threshold';
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  provider: string;
  model: string;

  steps: RunStep[];
  /** Kosu boyunca harcanan token (giris + cikis). */
  tokensUsed: number;
  /** Kac agir backtest kosuldu — ORCH_MAX_BACKTESTS freni bunun uzerinde. */
  backtestsRun: number;

  /** Modelin son sozu. */
  summary?: string;
  error?: string;
  /** Uretilen aday model kimlikleri — /models sayfasinda gorunurler. */
  producedCandidates: string[];
  /** Yazilan yonlendirmeler. */
  directives: string[];
  reportPath?: string;

  /** Devam edebilmek icin konusma gecmisi. */
  messages: AgentMessage[];
}

const RUNS_DIR = path.join(DATA_DIR, 'orchestrator', 'runs');

export function newRunId(): string {
  return `orch-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
}

export function saveRun(run: OrchestratorRun): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
}

export function readRun(id: string): OrchestratorRun | null {
  try {
    // path.basename: id URL'den geliyor, dizin disina cikamamali.
    return JSON.parse(
      fs.readFileSync(path.join(RUNS_DIR, `${path.basename(id)}.json`), 'utf8'),
    ) as OrchestratorRun;
  } catch {
    return null;
  }
}

/** Kosu listesi — konusma gecmisi HARIC (tel uzerinde megabaytlar tutar). */
export type RunSummary = Omit<OrchestratorRun, 'messages' | 'steps'> & { stepCount: number };

export function listRuns(limit = 50): RunSummary[] {
  if (!fs.existsSync(RUNS_DIR)) return [];

  const out: RunSummary[] = [];
  for (const f of fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as OrchestratorRun;
      const { messages: _m, steps, ...rest } = r;
      out.push({ ...rest, stepCount: steps?.length ?? 0 });
    } catch {
      // Yarim yazilmis kayit — listeyi dusurme (tradeLog.ts:48 ile ayni gerekce).
    }
  }

  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
