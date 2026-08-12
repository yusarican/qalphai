import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';
import { buildStrategyContext } from '../../engine/context';
import { allocate } from '../../engine/portfolio';
import { lastIndexBefore } from '../../engine/context';
import type { RecordedDecision } from '../../engine/simulator';
import type { Rejection } from '../../engine/portfolio';
import type { StrategyDecision, StrategyMeta, StrategySignal } from '../types';
import type { WorkerInit, WorkerJob, WorkerResult } from './protocol';

/**
 * DUVAR 4 — calisma zamani izolasyonu.
 *
 * Bu worker BIZIM kodumuzdur ve tam Node yetkisine sahiptir. Codex'in kodu ise burada
 * degil, asagida kurulan vm REALM'inin icinde kosar. Ikisi arasindaki sinir tek bir
 * kurala dayanir:
 *
 *   >>> SANDBOX'A ASLA HOST OBJESI GECIRILMEZ. <<<
 *
 * Bir host objesi (ornegin duz bir ctx nesnesi) realm'e verilseydi, strateji
 * `ctx.constructor.constructor('return process')()` ile HOST realm'ine tirmanabilirdi —
 * cunku o objenin prototip zinciri disaridan gelir. Bu, Node vm'inden kacmanin
 * 1 numarali yoludur. Bu yuzden ctx realm'e JSON STRING olarak gecer ve realm'in
 * KENDI JSON.parse'i ile, realm'in KENDI Object prototipiyle insa edilir.
 *
 * Neden ayri bir thread: vm icindeki sonsuz bir dongu ayni thread'den kesilemez.
 * Tek guvenilir durdurma yolu worker.terminate()'dir — ve bu, ancak strateji ayri
 * bir thread'deyse mumkundur. Yani worker sadece hiz icin degil, DURDURULABILIRLIK
 * icin de sart.
 *
 * Durust risk beyani: Node vm'i bir GUVENLIK siniri degildir. Bu yigin (realm'de modul
 * yok, host objesi yok, kod uretimi yok, ayri thread, kaynak limitleri + statik AST
 * reddi) kazara non-determinizmi, degerlendirme oyununu ve siradan kacisi guvenilir
 * bicimde durdurur; taze bir V8 CVE'si olan kararli bir dusmana karsi kanit degildir.
 * "Dusman" kendi makinemizde bilerek calistirdigimiz bir model oldugu icin bu, dogru takas.
 */

const init = workerData as WorkerInit;

// --- Realm kurulumu -------------------------------------------------------------

const realm = vm.createContext(Object.create(null), {
  codeGeneration: {
    strings: false, // eval / new Function realm ICINDE olur
    wasm: false,
  },
});

/**
 * Realm'e yalnizca zararsiz, DETERMINISTIK intrinsic'ler verilir.
 * Date yok (saat = non-determinizm), Math.random yok, console yok, timer yok.
 */
vm.runInContext(
  `
  'use strict';
  globalThis.Math = Math;
  globalThis.JSON = JSON;
  globalThis.Object = Object;
  globalThis.Array = Array;
  globalThis.Number = Number;
  globalThis.String = String;
  globalThis.Boolean = Boolean;
  globalThis.Map = Map;
  globalThis.Set = Set;
  globalThis.Error = Error;
  globalThis.isNaN = isNaN;
  globalThis.isFinite = isFinite;
  globalThis.parseFloat = parseFloat;
  globalThis.parseInt = parseInt;

  // Rastgelelik ve saat: sessizce yanlis sonuc uretmesindense GURULTULU olsun.
  // (Validator zaten reddeder; bu, ikinci savunma hatti.)
  Math.random = function () { throw new Error('Math.random() yasak: strateji deterministik olmali'); };
  globalThis.Date = undefined;

  Object.freeze(Math);
  Object.freeze(JSON);
  `,
  realm,
);

/**
 * Codex'in derlenmis JS'i. CommonJS olarak emit edildigi icin bir `exports` kabi verilir.
 * compileFunction parsingContext ile realm'e baglanir — fonksiyonun [[Realm]]'i sandbox'tir,
 * yani icinde uretilen her obje sandbox prototipini alir.
 */
const loader = vm.compileFunction(
  `${init.compiledJs}\nreturn exports.default;`,
  ['exports'],
  { parsingContext: realm },
);

const factory = loader(vm.runInContext('({})', realm)) as () => {
  meta: StrategyMeta;
  evaluate: (ctx: unknown) => StrategyDecision;
};

/** meta sabittir; bir kez okunur. */
const meta: StrategyMeta = factory().meta;

/**
 * Strateji'yi cagirir. Uc sey burada olur ve ucu de kasitlidir:
 *
 * 1. HER CAGRIDA TAZE INSTANCE (`factory()`).
 *    Validator modul seviyesi `let`/mutable-const'u yasakliyor, ama factory'nin ICINDEKI
 *    closure state'i goremez:
 *        const factory = () => { let memo = null; return { evaluate(ctx){ ...memo... } }; };
 *    Bu, modul seviyesi DEGILDIR — yani statik kontrolden gecer. Tek bir instance'i tum
 *    mumlarda yeniden kullansaydik, o `memo` mumlar arasi bir HAFIZA olurdu ve strateji
 *    backtest'te (tek surec, sirali) bir turlu, canlida (her mumda yeniden baslayan surec)
 *    baska turlu davranirdi. Bu ayrisma SESSIZDIR ve sistemin urettigi her sayiyi yalanlar.
 *    Instance'i her mumda yeniden yaratmak bu ihtimali YAPISAL olarak yok eder.
 *    (Maliyet: kucuk bir obje alokasyonu. Kazanc: durumsuzluk artik bir temenni degil.)
 *
 * 2. ctx realm ICINDE JSON'dan uretilir — host objesi asla sandbox'a girmez.
 *
 * 3. Donen karar JSON ile "yikanir" — sandbox prototipli bir obje host'a sizmaz.
 */
const callInRealm = vm.compileFunction(
  `
  'use strict';
  var ctx = JSON.parse(ctxJson);
  ctx.params = JSON.parse(paramsJson);

  // Derin dondurma REALM ICINDE: strateji ne veriyi bozabilir ne de ctx'e not birakabilir.
  (function freeze(o) {
    if (o === null || typeof o !== 'object') return;
    Object.freeze(o);
    for (var k of Object.getOwnPropertyNames(o)) freeze(o[k]);
  })(ctx);

  var strategy = factory();
  var d = strategy.evaluate(ctx);
  return d === null || d === undefined ? null : JSON.stringify(d);
  `,
  ['factory', 'ctxJson', 'paramsJson'],
  { parsingContext: realm },
) as (factory: unknown, ctxJson: string, paramsJson: string) => string | null;

// --- Is dongusu -----------------------------------------------------------------

parentPort?.on('message', (job: WorkerJob) => {
  try {
    const result = runRecordPass(job);
    parentPort?.postMessage({ ok: true, cellIndex: job.cellIndex, decisions: result } satisfies WorkerResult);
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      cellIndex: job.cellIndex,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResult);
  }
});

function runRecordPass(job: WorkerJob): RecordedDecision[] {
  const paramsJson = JSON.stringify(job.params);
  const out: RecordedDecision[] = [];

  const btcKlines = init.klines['BTCUSDT'];
  const btcInd = init.indicators['BTCUSDT'];

  for (const at of init.points) {
    // BTC rejim baglami — signalRunner.decideAt ile AYNI tanim.
    let btc: { price: number; sma200: number | null } | null = null;
    if (btcKlines && btcInd) {
      const bj = lastIndexBefore(btcKlines, at);
      if (bj >= 0 && bj < btcInd.length) {
        btc = { price: btcKlines[bj]!.close, sma200: btcInd[bj]!.sma200 };
      }
    }

    const signals: Array<{ symbol: string; signal: StrategySignal; atr: number; price: number }> = [];
    const rejections: Rejection[] = [];

    for (const symbol of init.symbols) {
      const klines = init.klines[symbol] ?? [];
      const indicators = init.indicators[symbol] ?? [];

      // LOOK-AHEAD DISIPLINI: ctx her zaman BIZIM context.ts'imizle kesilir.
      // Sandbox'taki kod hicbir zaman ham mum dizisine erisemez, yalnizca bu kesiti gorur.
      const ctx = buildStrategyContext({
        symbol,
        interval: init.interval,
        at,
        klines,
        indicators,
        funding: init.funding[symbol] ?? [],
        lsr: null,
        macroRiskAppetite: job.macroRiskAppetite,
        btc,
        params: job.params,
        warmupBars: meta.warmupBars,
      });
      if (!ctx) continue;

      // history buyuk ve cogu strateji kullanmiyor — needs.history yoksa gonderme
      // (serilestirme maliyeti yoksa 250 indikator objesi × her karar noktasi).
      const payload = meta.needs?.history
        ? ctx
        : { ...ctx, history: [] };

      const raw = callInRealm(factory, JSON.stringify(payload), paramsJson);
      if (raw === null) continue;

      const d = JSON.parse(raw) as StrategyDecision;
      if (d === null) continue;

      if ('veto' in d && d.veto === true) {
        rejections.push({ symbol, rule: String(d.rule).slice(0, 32), side: d.wouldBe });
        continue;
      }

      const sig = d as StrategySignal;
      if (
        (sig.side !== 'LONG' && sig.side !== 'SHORT') ||
        typeof sig.confidence !== 'number' ||
        !Number.isFinite(sig.confidence) ||
        sig.confidence < 0 ||
        sig.confidence > 1
      ) {
        rejections.push({ symbol, rule: 'INVALID_SIGNAL' });
        continue;
      }

      const j = lastIndexBefore(klines, at);
      const atr = j >= 0 && j < indicators.length ? indicators[j]!.atr : null;
      const price = j >= 0 ? klines[j]!.close : 0;
      if (!atr || !(atr > 0) || !(price > 0)) {
        rejections.push({ symbol, rule: 'NO_ATR_SIZING', side: sig.side });
        continue;
      }

      signals.push({ symbol, signal: sig, atr, price });
    }

    // KALDIRAC VE TAHSIS BURADA — sandbox'in DISINDA. Strateji bunlara dokunamaz.
    const { allocations, rejections: capRejections } = allocate({
      signals,
      profile: job.profile,
      riskOff: job.macroRiskAppetite === 'risk_off',
    });

    if (allocations.length > 0 || rejections.length > 0 || capRejections.length > 0) {
      out.push({ timestamp: at, allocations, rejections: [...rejections, ...capRejections] });
    }
  }

  return out;
}
