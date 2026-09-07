/**
 * ============================================================================
 * AGIR IS KUYRUGU — tek CPU, uc talep sahibi.
 * ============================================================================
 *
 * Bu dosya var olan bir bosluğu kapatiyor. Bugun sistemde UC ayri tek-ucus kilidi var
 * ve BIRBIRLERINDEN HABERSIZLER:
 *
 *   api/backtestJobs.ts:175   `running`      — panelden baslatilan grid
 *   orchestrator/scheduler.ts `running`      — gece dongusu
 *   orchestrator/scheduler.ts `liveRunning`  — canli executor
 *
 * Her biri kendi icinde dogru: ayni anda iki grid, iki gece, iki emir turu yok. Ama
 * backtestJobs.ts:25'in kendisi soyle diyor: "Ayni anda TEK kosu — iki grid ayni CPU'da
 * birbirini ac birakir ve sonuclar (sure olcumleri) kirlenir." Bu, kilitler arasinda
 * SAGLANMIYORDU: panelden bir grid baslatilirken gece dongusu de kendi grid'ini
 * kosabiliyordu.
 *
 * Orchestrator bunu dayanilmaz hale getiriyor — tek kosuda 6'ya kadar agir backtest
 * istiyor. Koordinasyon olmadan bir otopsi, gece dongusunun sampiyon degerlendirmesini
 * dakikalarca ac birakabilir ve gecenin "elmayla elma" kiyasi bozulur.
 *
 * ---------------------------------------------------------------- TASARIM
 *
 * Surec ici FIFO. Redis yok, is kuyrugu yok — TECHSTACK'teki "Deliberate non-choices"
 * tablosundaki gerekce aynen gecerli: tek makine, tek yazar, ve kilit bu gercegin
 * durust ifadesi.
 *
 * ONCELIK YOK, bilerek. Bir oncelik siniri, "canli her zaman once" gibi gorunse de
 * yanlis olurdu: canli executor bu kuyrugu HIC kullanmiyor. Canli karar tek bar icin
 * kosuyor (liveDecider.ts, points uzunlugu 1) — saniyeler surer, grid'le yarismaz ve
 * kuyruga sokulursa bir gece kosusunun arkasinda mum kaciririr. Kuyruk yalnizca
 * DAKIKALAR suren isler icindir: grid backtest, gate analizi, otopsi.
 */

export type QueueKind = 'nightly' | 'panel-backtest' | 'orchestrator';

export interface QueueEntry {
  id: number;
  kind: QueueKind;
  label: string;
  enqueuedAt: number;
  startedAt: number | null;
}

interface Waiting extends QueueEntry {
  start: () => void;
}

let nextId = 1;
let active: QueueEntry | null = null;
const waiting: Waiting[] = [];

/**
 * Isi kuyruga sokar ve sirasi gelince kosar.
 *
 * Cagiran taraf `await` eder; yani calisma sekli degismez, yalnizca BASLAMA ani otelenir.
 * Bu, mevcut cagri yerlerine (nightly, backtestJobs) tek satirlik bir sarmalama olarak
 * girebilmesi icin onemli — ikinci bir asenkron akis semasi getirmiyor.
 */
export async function runExclusive<T>(
  kind: QueueKind,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const entry: QueueEntry = {
    id: nextId++,
    kind,
    label,
    enqueuedAt: Date.now(),
    startedAt: null,
  };

  if (active) {
    await new Promise<void>((resolve) => {
      waiting.push({ ...entry, start: resolve });
    });
  }

  active = { ...entry, startedAt: Date.now() };

  try {
    return await fn();
  } finally {
    active = null;
    const next = waiting.shift();
    // Sirayi devretmek MIKROGOREV olarak yapiliyor: `finally` icinde senkron devretmek,
    // bir sonraki isi bu isin hata yayilimindan ONCE baslatirdi ve iki is kisa bir an
    // birlikte "aktif" gorunurdu.
    if (next) queueMicrotask(() => next.start());
  }
}

export interface QueueStatus {
  active: QueueEntry | null;
  waiting: Array<Omit<QueueEntry, 'startedAt'>>;
  depth: number;
}

/** Kuyrugun o anki hali — /api/health bunu gosterir. */
export function queueStatus(): QueueStatus {
  return {
    active,
    waiting: waiting.map(({ id, kind, label, enqueuedAt }) => ({ id, kind, label, enqueuedAt })),
    depth: waiting.length + (active ? 1 : 0),
  };
}

/** Yalnizca testler icin: sureci temiz bir kuyrukla birakir. */
export function resetQueue(): void {
  active = null;
  waiting.length = 0;
}
