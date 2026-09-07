import { agentTurn, assistantTurn, orchestratorConfigured, toolResults, userText } from '../../lib/agentLlm';
import { buildSystemPrompt, buildTaskPrompt } from './prompt';
import { buildTools, type ToolContext } from './tools';
import { newRunId, saveRun, type OrchestratorRun, type RunStep } from './state';
import { env } from '../../config/env';
import type { AgentMessage } from '../../lib/agentLlm';

/**
 * ============================================================================
 * AGENT DONGUSU — ust aklin kostugu yer.
 * ============================================================================
 *
 * Yonetici kural gece dongusunden AYNEN devralindi (orchestrator/nightly.ts:26):
 *
 *   >>> HATA DURUMUNDA HICBIR SEY DEGISMEZ. <<<
 *
 * Model coker, tool patlar, butce biter — hicbirinde sampiyona dokunulmaz, hicbirinde
 * yarim bir sonuc "sonuc" diye sunulmaz. Kosu diske yazilir ve nedenini soyler.
 *
 * Zaten yapisal olarak da dokunamaz: tool listesinde model aktive eden bir sey yok
 * (agent/tools.ts). Bu dongude yanlis giden bir sey, en fazla bosa harcanmis CPU ve
 * token demektir — asla yanlis bir canli pozisyon degil.
 *
 * ---------------------------------------------------------------- UC FREN
 *
 *  1. ADIM       (ORCH_MAX_STEPS): bir hedefe kilitlenip ayni tool'u tekrarlamayi keser.
 *  2. TOKEN      (ORCH_TOKEN_BUDGET): uzun gecmisin maliyetini kapaklar.
 *  3. AGIR HESAP (ORCH_MAX_BACKTESTS): CPU'yu korur — tools.ts icinde uygulanir.
 *
 * Fren carptiginda dongu SESSIZCE durmaz: modele "butcen bitti, elindekiyle sonuclandir"
 * denir ve TOOLSUZ bir kapanis turu daha verilir. Boylece yapilan butun hesap bir rapora
 * donusur. Sessiz kesme, saatlerce suren bir kosuyu cope atmak olurdu.
 */

export interface RunOrchestratorArgs {
  task: string;
  trigger: OrchestratorRun['trigger'];
  runId?: string;
  onProgress?: (step: number, detail: string) => void;
}

export async function runOrchestrator(args: RunOrchestratorArgs): Promise<OrchestratorRun> {
  if (!orchestratorConfigured()) {
    throw new Error(
      'orchestrator kapali: ORCH_ENABLED=true ve ORCH_API_KEY gerekli. ' +
        'Kapaliyken sistemin geri kalani bugunku davranisini birebir korur.',
    );
  }

  const run: OrchestratorRun = {
    id: args.runId ?? newRunId(),
    task: args.task,
    trigger: args.trigger,
    status: 'running',
    startedAt: Date.now(),
    provider: env.orchestrator.provider,
    model: env.orchestrator.model,
    steps: [],
    tokensUsed: 0,
    backtestsRun: 0,
    producedCandidates: [],
    directives: [],
    messages: [],
  };

  const tools = buildTools();
  const ctx: ToolContext = { run, budget: { backtestsLeft: env.orchestrator.maxBacktests } };
  const system = buildSystemPrompt();

  const messages: AgentMessage[] = [userText(buildTaskPrompt(args.task, args.trigger))];
  run.messages = messages;
  saveRun(run);

  try {
    for (let step = 1; step <= env.orchestrator.maxSteps; step++) {
      const exhausted = reasonToStop(run, step);

      const turn = await agentTurn({
        system,
        messages,
        // Fren carptiysa TOOL VERILMEZ: model kapanis metnini yazmak zorunda kalir.
        tools: exhausted ? [] : [...tools.values()].map((t) => t.spec),
        label: `adim ${step}`,
      });

      run.tokensUsed += turn.usage.inTokens + turn.usage.outTokens;
      messages.push(assistantTurn(turn));

      const record: RunStep = {
        n: step,
        at: Date.now(),
        text: turn.text,
        toolCalls: [],
        usage: turn.usage,
      };

      if (turn.toolUses.length === 0) {
        run.steps.push(record);
        run.summary = turn.text;
        run.status = 'done';
        break;
      }

      // ---------------------------------------------------------------- tool'lari kos
      const results: Array<{ id: string; name: string; content: string; isError?: boolean }> = [];

      for (const call of turn.toolUses) {
        args.onProgress?.(step, `${call.name}`);
        const started = Date.now();
        const def = tools.get(call.name);

        if (!def) {
          const msg = `bilinmeyen tool: ${call.name}. Kullanilabilirler: ${[...tools.keys()].join(', ')}`;
          results.push({ id: call.id, name: call.name, content: msg, isError: true });
          record.toolCalls.push({ name: call.name, input: call.input, ok: false, summary: msg, ms: 0 });
          continue;
        }

        try {
          const out = await def.run(call.input, ctx);
          results.push({ id: call.id, name: call.name, content: out });
          record.toolCalls.push({
            name: call.name,
            input: call.input,
            ok: true,
            summary: firstLine(out),
            ms: Date.now() - started,
          });
        } catch (err) {
          /**
           * Tool hatasi donguyu DUSURMEZ, MODELE GERI BESLENIR.
           *
           * Gece dongusunun onarim turlariyla ayni fikir (nightly.ts:202): hatanin
           * kendisi bir bilgi. "Model bulunamadi: xyz" mesajini goren model dogru id'yi
           * arar; dongu duserse ayni bilgi bir yigin izine donusur ve kimse okumaz.
           */
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ id: call.id, name: call.name, content: `HATA: ${msg}`, isError: true });
          record.toolCalls.push({
            name: call.name,
            input: call.input,
            ok: false,
            summary: msg,
            ms: Date.now() - started,
          });
        }
      }

      messages.push(toolResults(results));
      run.steps.push(record);
      saveRun(run);

      if (step === env.orchestrator.maxSteps) {
        run.status = 'stopped';
        run.error = `adim tavanina takildi (ORCH_MAX_STEPS=${env.orchestrator.maxSteps})`;
      }
    }

    if (run.status === 'running') run.status = 'stopped';
  } catch (err) {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
  } finally {
    run.finishedAt = Date.now();
    saveRun(run);
  }

  return run;
}

/**
 * Fren carpti mi — carptiysa modele ne soylenecek.
 *
 * Mesaj konusma gecmisine ENJEKTE EDILIR, sistem promptuna degil: modelin bunu
 * "simdi olan bir sey" olarak gormesi gerekiyor, bastan beri gecerli bir kural olarak
 * degil.
 */
function reasonToStop(run: OrchestratorRun, step: number): boolean {
  const overTokens = run.tokensUsed >= env.orchestrator.tokenBudget;
  const lastStep = step === env.orchestrator.maxSteps;

  if (!overTokens && !lastStep) return false;

  const text = overTokens
    ? `TOKEN BUTCESI BITTI (${run.tokensUsed} / ${env.orchestrator.tokenBudget}). ` +
      'Yeni tool cagirma. Elindeki olcumlerle bulgularini ozetle.'
    : `SON ADIM (${step}/${env.orchestrator.maxSteps}). Yeni tool cagirma. ` +
      'Elindeki olcumlerle bulgularini ozetle.';

  /**
   * Uyari, son mesaj zaten `user` ise ONA EKLENIR; yeni bir mesaj olarak eklenmez.
   *
   * Anthropic rollerin DONUSUMLU olmasini sart kosuyor: art arda iki `user` mesaji
   * "messages: roles must alternate" ile 400 doner. Bir tool turunun ardindan gelen
   * mesaj zaten `user` (tool sonuclari) oldugu icin, uyariyi ayri bir mesaj yapmak tam
   * da bu durumu uretirdi — ve yalnizca butce bittiginde, yani kosunun en sonunda,
   * yani en pahali anda.
   */
  const last = run.messages[run.messages.length - 1];
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else run.messages.push(userText(text));

  return true;
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
