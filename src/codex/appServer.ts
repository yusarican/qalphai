import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * `codex app-server` ile JSON-RPC konusan istemci.
 *
 * Cekirdek (framing, pending map, notification listener, waitFor) kullanicinin verdigi
 * samplecodexintegration.ts'ten alindi — orasi dogruydu. Ustune gece dongusunun ihtiyac
 * duydugu sey eklendi: TIMEOUT, hata bildirimleri, ve headless calisma.
 *
 * Protokol adlari TAHMIN EDILMEDI: `codex app-server generate-json-schema` ile uretilen
 * gercek semadan okundu. (Ilk plan `modelReasoningEffort` diye tahmin ediyordu; gercek ad
 * `effort`. Sema uretilebiliyorken tahmin etmek, gecenin sessizce yanlis modelle kosmasi
 * demekti.)
 */

type JsonObject = Record<string, unknown>;
type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type RpcNotification = { method?: string; params?: JsonObject };

export class CodexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexError';
  }
}

export class CodexAppServer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: RpcNotification) => void>();
  private exited = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[codex] ${text}`);
    });

    child.on('exit', (code) => {
      this.exited = true;
      const err = new CodexError(`codex app-server kapandi (${code ?? 'sinyal'})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  static start(): CodexAppServer {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: 'pipe' });
    return new CodexAppServer(child);
  }

  request<T>(method: string, params: JsonObject): Promise<T> {
    if (this.exited) return Promise.reject(new CodexError('codex app-server calismiyor'));
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (m: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Bir bildirimi bekler. Sample'da bu SONSUZA KADAR bekliyordu — gece dongusunde
   * bu, tum sistemin sessizce asilmasi demektir. Timeout sart.
   */
  waitFor(
    method: string,
    predicate: (p: JsonObject) => boolean,
    timeoutMs: number,
  ): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new CodexError(`'${method}' ${Math.round(timeoutMs / 1000)}sn icinde gelmedi`));
      }, timeoutMs);

      const unsubscribe = this.onNotification((m) => {
        if (m.method === method && m.params && predicate(m.params)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(m.params);
        }
      });
    });
  }

  close(): void {
    if (!this.exited) this.child.kill();
  }

  private send(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcResponse & RpcNotification;
    try {
      message = JSON.parse(line);
    } catch {
      return; // JSON olmayan satirlar (banner vs.) yok sayilir
    }

    if (typeof message.id === 'number') {
      const req = this.pending.get(message.id);
      if (!req) return;
      this.pending.delete(message.id);
      if (message.error) req.reject(new CodexError(message.error.message ?? 'Codex RPC hatasi'));
      else req.resolve(message.result);
      return;
    }

    for (const l of this.listeners) l(message);
  }
}
