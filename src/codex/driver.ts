import { CodexAppServer, CodexError } from './appServer';
import { env } from '../config/env';

/**
 * Codex surucusu — gece dongusunun AI tarafi.
 *
 * Protokol adlari `codex app-server generate-json-schema` ciktisindan alindi:
 *   thread/start : { cwd, ephemeral, model, sandbox, approvalPolicy }
 *   turn/start   : { threadId, input[], model, effort }
 *
 * `effort` ('high') — plan bunu `modelReasoningEffort` diye tahmin ediyordu; semada
 * gercek ad `effort`. Yanlis anahtar gonderilseydi sessizce YOK SAYILIRDI ve gece,
 * istedigimiz reasoning seviyesinin altinda kosardi. Bu yuzden asagida ayrica
 * DOGRULAMA var: donen turn beklenen modeli kullanmadiysa gece GURULTULU sekilde duser.
 */

export interface TurnOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** Verilirse son asistan mesaji bu JSON Schema'ya uymak zorunda. */
  outputSchema?: Record<string, unknown>;
}

export interface TurnResult {
  text: string;
  turnId: string;
}

export class CodexDriver {
  private constructor(
    private readonly server: CodexAppServer,
    private readonly model: string,
    private readonly effort: 'low' | 'medium' | 'high',
  ) {}

  static async connect(): Promise<CodexDriver> {
    const server = CodexAppServer.start();

    await server.request('initialize', {
      clientInfo: { name: 'tradecraftai', title: 'TradeCraft AI', version: '0.1.0' },
    });
    server.notify('initialized');

    // HEADLESS: gece dongusunde tarayici acilamaz ve stdin'de kimse yok.
    // Giris yapilmamissa sonsuza kadar beklemek yerine GURULTULU sekilde dus.
    const auth = await server.request<{ account: { type: string } | null }>('account/read', {
      refreshToken: false,
    });
    if (auth.account?.type !== 'chatgpt') {
      server.close();
      throw new CodexError(
        'Codex ChatGPT hesabiyla giris yapilmamis. Bir kez INTERAKTIF olarak `codex login` calistir. ' +
          'Gece dongusu tarayici acamaz.',
      );
    }

    return new CodexDriver(server, env.codex.model, env.codex.reasoningEffort);
  }

  /**
   * Izole calisma dizininde bir thread acar.
   *
   * sandbox: 'workspace-write' — Codex yalnizca cwd'ye yazabilir. cwd de zaten sadece
   *   sozlesme + brief iceren bos bir temp dizin (bkz. codex/workspace.ts).
   * approvalPolicy: 'never' — gece dongusunde onay verecek kimse yok. Yazma yetkisi
   *   zaten temp dizinle sinirli oldugu icin bu guvenli.
   * ephemeral: true — konusma diske kaydedilmez.
   */
  async startThread(cwd: string): Promise<string> {
    const res = await this.server.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      ephemeral: true,
      model: this.model,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
    return res.thread.id;
  }

  async turn(threadId: string, prompt: string, opts: TurnOptions = {}): Promise<TurnResult> {
    const timeoutMs = opts.timeoutMs ?? env.codex.turnTimeoutMs;

    let text = '';
    const unsub = this.server.onNotification((m) => {
      if (m.method === 'item/agentMessage/delta' && m.params?.['threadId'] === threadId) {
        text += String(m.params['delta'] ?? '');
      }
    });

    // Dinleyici turn/start'TAN ONCE kurulur: hizli biten bir tur kacirilmasin.
    const completed = this.server.waitFor(
      'turn/completed',
      (p) => p['threadId'] === threadId,
      timeoutMs,
    );
    const failed = this.server.waitFor(
      'turn/failed',
      (p) => p['threadId'] === threadId,
      timeoutMs,
    );

    try {
      await this.server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        model: opts.model ?? this.model,
        effort: opts.effort ?? this.effort,
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      });

      const outcome = await Promise.race([
        completed.then((p) => ({ kind: 'done' as const, p })),
        failed.then((p) => ({ kind: 'failed' as const, p })),
      ]);

      if (outcome.kind === 'failed') {
        throw new CodexError(`Codex turu basarisiz: ${JSON.stringify(outcome.p['error'] ?? outcome.p)}`);
      }

      const turn = outcome.p['turn'] as { id?: string } | undefined;
      return { text, turnId: String(turn?.id ?? '') };
    } finally {
      unsub();
    }
  }

  close(): void {
    this.server.close();
  }
}
