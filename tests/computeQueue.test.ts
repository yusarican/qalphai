import { afterEach, describe, expect, it } from 'vitest';
import { queueStatus, resetQueue, runExclusive } from '../src/engine/computeQueue';

/**
 * KUYRUGUN TEK SOZU: ayni anda iki agir is kosmaz.
 *
 * backtestJobs.ts:25 bunu zaten sart kosuyordu ("iki grid ayni CPU'da birbirini ac
 * birakir ve sure olcumleri kirlenir") ama yalnizca panel icinde. Gece dongusu ve
 * orchestrator ayri kilitler tasidigi icin uc talep sahibi arasinda saglanmiyordu.
 */

afterEach(() => resetQueue());

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('runExclusive', () => {
  it('ikinci is birincisi bitmeden BASLAMAZ', async () => {
    const gate = defer();
    const order: string[] = [];

    const first = runExclusive('nightly', 'a', async () => {
      order.push('a:basladi');
      await gate.promise;
      order.push('a:bitti');
    });

    // Mikrogorev kuyrugunu bosalt: ikinci is gercekten sirada beklemeli.
    await Promise.resolve();

    const second = runExclusive('panel-backtest', 'b', async () => {
      order.push('b:basladi');
    });

    await Promise.resolve();
    expect(order).toEqual(['a:basladi']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:basladi', 'a:bitti', 'b:basladi']);
  });

  it('FIFO: kuyruga giris sirasi korunur', async () => {
    const gate = defer();
    const order: number[] = [];

    const head = runExclusive('nightly', 'head', async () => {
      await gate.promise;
    });
    await Promise.resolve();

    const rest = [1, 2, 3].map((n) =>
      runExclusive('orchestrator', `is-${n}`, async () => {
        order.push(n);
      }),
    );

    gate.resolve();
    await Promise.all([head, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('is FIRLATSA bile sira devreder — kuyruk kilitlenmez', async () => {
    // En pahali hata bu olurdu: bir gece kosusu patlar, kuyruk sonsuza kadar dolu
    // kalir ve panel/orchestrator bir daha hicbir sey kosamaz.
    const boom = runExclusive('nightly', 'patlayan', async () => {
      throw new Error('patladi');
    });

    await expect(boom).rejects.toThrow('patladi');

    const after = await runExclusive('panel-backtest', 'sonraki', async () => 'ok');
    expect(after).toBe('ok');
    expect(queueStatus().depth).toBe(0);
  });

  it('durum: kosan is ve bekleyenler gorunur', async () => {
    const gate = defer();
    const head = runExclusive('nightly', 'gece', async () => {
      await gate.promise;
    });
    await Promise.resolve();

    const queued = runExclusive('orchestrator', 'otopsi', async () => undefined);
    await Promise.resolve();

    const st = queueStatus();
    expect(st.active?.kind).toBe('nightly');
    expect(st.active?.label).toBe('gece');
    expect(st.waiting.map((w) => w.label)).toEqual(['otopsi']);
    expect(st.depth).toBe(2);

    gate.resolve();
    await Promise.all([head, queued]);
    expect(queueStatus().depth).toBe(0);
  });

  it('donen deger cagirana AYNEN ulasir', async () => {
    expect(await runExclusive('orchestrator', 'x', async () => ({ n: 42 }))).toEqual({ n: 42 });
  });
});
