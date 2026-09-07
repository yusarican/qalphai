import { orchestratorConfigured } from '../../lib/agentLlm';
import { runOrchestrator } from './loop';
import { listRuns, readRun, type OrchestratorRun, type RunSummary } from './state';
import { computeLiveStats, readTrades } from '../../lib/tradeLog';
import { readChampion } from '../champion';
import { env } from '../../config/env';

export { runOrchestrator } from './loop';
export { listRuns, readRun } from './state';
export type { OrchestratorRun, RunStep, RunSummary } from './state';

/**
 * ORCHESTRATOR'IN DIS YUZU — HTTP ucu ve zamanlayici buradan gecer.
 *
 * Tek-ucus kilidi: iki orchestrator kosusu ayni anda kosarsa ikisi de agir backtest
 * kuyruguna girer, birbirini bekler ve ikisi de token yakar. Ayrica ikisi birden
 * yonlendirme yazarsa hangi teshisin hangi yonlendirmeyi dogurdugu izlenemez hale gelir.
 * Gece dongusu ve canli executor ile ayni desen (scheduler.ts:20).
 */

let running = false;
let current: string | null = null;

export function isOrchestratorRunning(): boolean {
  return running;
}

export function currentRunId(): string | null {
  return current;
}

export interface StartArgs {
  task: string;
  trigger: OrchestratorRun['trigger'];
}

/**
 * Kosuyu baslatir ve HEMEN doner (fire-and-forget).
 *
 * Kosu saatler surebilir; HTTP istegi bekletilmez. Cagiran taraf id ile poll eder —
 * gece dongusunun /api/nightly/run ucuyla ayni sekil (index.ts:33).
 */
export function startOrchestrator(args: StartArgs): { runId: string } {
  if (!orchestratorConfigured()) {
    throw new Error(
      'orchestrator kapali: ORCH_ENABLED=true ve ORCH_API_KEY gerekli (bkz. .env.example).',
    );
  }
  if (running) throw new Error(`bir orchestrator kosusu zaten suruyor: ${current}`);

  const runId = `orch-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  running = true;
  current = runId;

  void runOrchestrator({ ...args, runId })
    .catch((err) => {
      console.error(`[orchestrator] kosu dustu: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      running = false;
      current = null;
    });

  return { runId };
}

export function recentRuns(limit = 50): RunSummary[] {
  return listRuns(limit);
}

export function runDetail(id: string): OrchestratorRun | null {
  return readRun(id);
}

// ---------------------------------------------------------------- gorev sablonlari

export const PRE_NIGHTLY_TASK = `Gece dongusu birazdan kosacak. Bu kosunun amaci, gecenin arastirmasina YON vermek.

1. list_models ile kutuphaneye bak: canlida ne var, kapiyi gecemeyen ama umut vadeden ne birikmis?
2. read_live_stats ile canlinin durumuna bak (bos olabilir — o zaman kayan pencere backtest'i kullan).
3. Canlidaki modelin gate bilancosunu cikar (analyze_gates): hangi filtre kaybettiriyor?
4. Bulgularina gore gece dongusune yonlendirme yaz (add_directive). Once list_directives ile
   mevcutlari gor; celisen veya artik gecerli olmayanlari revoke_directive ile kaldir.
5. write_report ile ne buldugunu ve neden o yonlendirmeyi yazdigini anlat.

Yonlendirme yazmak ZORUNDA degilsin. Sistemin gidisati iyiyse ve elinde somut bir teshis
yoksa, "yonlendirmeye gerek yok" da gecerli bir sonuctur — ama gerekcesini yaz.`;

export const POST_NIGHTLY_TASK = `Gece dongusu yeni bitti. Bu kosunun amaci, gecenin urettigini DENETLEMEK.

1. read_report ile bu gecenin raporunu oku: hangi makale secildi, Codex ne yazdi, kapi ne dedi?
2. Aday uretildiyse read_model_source ile kodunu oku. Codex neyi kacirmis olabilir?
   Hangi gate'leri koymus, hangilerini koymamis?
3. analyze_gates ile adayin (veya sampiyonun) gate bilancosunu cikar.
4. Somut bir iyilestirme goruyorsan uygula:
   - Bir gate'i KALDIRMAK/acip kapatmak icin -> gate_surgery
   - Yeni bir filtre EKLEMEK veya giris mantigini DEGISTIRMEK icin -> ask_codex
   Ikisi de tam sinavdan gecer ve /models sayfasinda operatorun onayini bekler.
5. write_report ile bulgularini ve onerini yaz.`;

export const AUTOPSY_TASK_PREFIX = `Canli performans esigi asildi. Sampiyonun son donemine otopsi yap.

1. read_live_stats ile ne olduguna bak.
2. autopsy ile bozulmanin yasandigi pencereyi incele — NUKS TARAMASINI ACIK BIRAK.
   Ayni pencerede tum modeller cokuyorsa sorun modelde degil rejimde olabilir.
3. Teshisine gore gate_surgery veya ask_codex ile bir alternatif uret.
4. write_report ile raporla.`;

// ---------------------------------------------------------------- canli esik tetigi

export interface LiveHealth {
  breached: boolean;
  reasons: string[];
  stats: { trades: number; expectancyR: number; totalPnl: number; consecutiveLosses: number };
}

/**
 * Canli performans esigi asildi mi?
 *
 * Uc olcut, ucu de KAPANMIS islemler uzerinden (tradeLog.ts — pnlUnknown olanlar hicbir
 * sayiya katilmaz, kuru kosular haric tutulur).
 *
 * NOT: `data/live-trades.jsonl` su anda pratikte bos ve LIVE_TRADING varsayilan olarak
 * kapali. Yani bu tetik bir sure veri bulamayacak ve bu NORMALDIR — bozulma tespitinin
 * ikinci yolu, orchestrator'in kendi kayan pencere backtest'leri (agent/prompt.ts).
 * Burada esik asilmiyor diye "her sey yolunda" SONUCU CIKARILMAMALI.
 */
export const LIVE_MIN_TRADES = 15;
export const LIVE_MIN_EXPECTANCY_R = -0.15;
export const LIVE_MAX_CONSECUTIVE_LOSSES = 6;

export function checkLiveHealth(): LiveHealth {
  const trades = readTrades();
  const stats = computeLiveStats(trades);
  const reasons: string[] = [];

  let consecutive = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i]!;
    if (t.dryRun || t.pnlUnknown) continue;
    if (t.realizedPnl > 0) break;
    consecutive++;
  }

  // Az sayida islemde her olcut gurultudur; esik tetiklenmez.
  if (stats.totalTrades >= LIVE_MIN_TRADES) {
    if (stats.expectancyR < LIVE_MIN_EXPECTANCY_R) {
      reasons.push(
        `islem basina beklenti ${stats.expectancyR.toFixed(3)}R (esik ${LIVE_MIN_EXPECTANCY_R}R, ${stats.totalTrades} islem)`,
      );
    }
    if (stats.totalPnl < 0 && stats.profitFactor < 1) {
      reasons.push(`kumulatif PnL $${stats.totalPnl.toFixed(2)}, profit factor ${stats.profitFactor.toFixed(2)}`);
    }
  }

  if (consecutive >= LIVE_MAX_CONSECUTIVE_LOSSES) {
    reasons.push(`ust uste ${consecutive} kayip (esik ${LIVE_MAX_CONSECUTIVE_LOSSES})`);
  }

  return {
    breached: reasons.length > 0,
    reasons,
    stats: {
      trades: stats.totalTrades,
      expectancyR: stats.expectancyR,
      totalPnl: stats.totalPnl,
      consecutiveLosses: consecutive,
    },
  };
}

/** Canli esik tetigi icin gorev metni — teshisi baslatan sayilari ICERIR. */
export function autopsyTask(health: LiveHealth): string {
  const champ = readChampion();
  return [
    AUTOPSY_TASK_PREFIX,
    '',
    `ESIGI ASAN OLCUMLER:`,
    ...health.reasons.map((r) => `- ${r}`),
    '',
    `Canli model: ${champ?.name ?? 'promosyon kaydi yok -> builtin mechanical-v0'}`,
    `Evren: ${(champ?.symbols ?? env.nightly.symbols).join(', ')} | ${champ?.interval ?? env.nightly.interval}`,
  ].join('\n');
}
