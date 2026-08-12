import fs from 'node:fs';
import { currentDecisionBar, decideNow } from './liveDecider';
import { DEFAULT_RISK_PARAMS, type RiskParams } from './riskManagement';
import { DEFAULT_COSTS, type CostConfig } from './costModel';
import { DEFAULT_USE_TRAILING, cooldownMsFor } from './execConfig';
import {
  EXCHANGE_ONLY_SKIPS,
  planActions,
  type ClosedBar,
  type PlannedOpen,
  type SkipReason,
} from './livePlan';
import { computeIndicatorSeriesCached } from './indicatorSeries';
import { DEFAULT_MAX_SWEEP_CELLS, paramCellCount } from './backtest';
import { loadChampionSource, readChampion, type ChampionRecord } from '../orchestrator/champion';
import { loadMeta } from '../strategy/loader';
import { ensureFunding, ensureKlines, getKlines, openReadOnly, INTERVAL_MS } from '../lib/klineStore';
import {
  pruneExits,
  readState,
  writeState,
  type LedgerPosition,
  type LiveState,
} from '../lib/liveState';
import * as ex from '../services/binanceOrders';
import { appendTrade } from '../lib/tradeLog';
import { env } from '../config/env';
import { resolveLiveSymbols } from '../config/portfolio';
import type { Allocation, Rejection } from './portfolio';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';

/**
 * CANLI (TESTNET) EXECUTOR — kararin KIRLI yarisi.
 *
 * Ne YAPILACAGINA livePlan.planActions karar verir (saf, test edilebilir). Bu dosya
 * yalnizca onu GERCEKLESTIRIR: veriyi tazeler, borsayla mutabakat kurar, emirleri
 * gonderir, defteri gunceller.
 *
 * "Backtest ne yaptiysa onu yap" kurali burada iki yerde BOZULMAK ZORUNDA. Ikisi de
 * borsanin fizigidir; gizlemek yerine yaziyorum:
 *
 *  1. MIKTAR modellenen dolumdan, SEVIYELER gercek dolumdan turer.
 *     Simulator once entryFill'i (slippage'li fiyat) hesaplar, sonra HEM miktari HEM
 *     TP/SL'i ondan turetir (simulator.ts:289-325). Canlida bu imkansiz: miktar emirden
 *     ONCE bilinmek zorunda, gercek dolum ise emirden SONRA ogrenilir. Cozum: miktar,
 *     backtest'in kullandigi maliyet modeliyle TAHMIN edilen dolumdan (livePlan);
 *     TP/SL ise GERCEK dolumdan (asagida). Gercek dolum, simulator'un modelledigi
 *     entryFill'in canlidaki karsiligidir — koruma seviyeleri ondan turemezse R
 *     mesafesi kurgu olur.
 *
 *  2. BREAKEVEN'i biz tasiriz, borsa tasimaz.
 *     Binance'te "fiyat +1R'a gelince stop'u girise cek" diye bir emir tipi yok.
 *     Simulator bunu HER MUMDA kontrol eder (processPositionCandle -> applyBreakeven).
 *     Biz de her mum kapanisinda kontrol ediyoruz — ayni granulerlik. Executor'un mum
 *     basina kosmasi bu yuzden bir tercih degil, bir SART.
 */

export interface LiveAction {
  symbol: string;
  side: 'LONG' | 'SHORT';
  kind: 'OPENED' | 'SKIPPED' | 'CLOSED' | 'BREAKEVEN' | 'FAILED';
  reason?: string;
  qtyBase?: number;
  margin?: number;
  leverage?: number;
  entryFill?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  riskUSD?: number;
}

export interface LiveRunResult {
  decisionBar: number;
  dryRun: boolean;
  testnet: boolean;
  champion: string;
  balance: number;
  availableMargin: number;
  /** Bu kosuda karar icin degerlendirilen semboller (evren eksi operatorun kapattiklari). */
  symbols: string[];
  /** Operatorun panelden kapattiklari — bunlarda sinyal ARANMADI. */
  disabled: string[];
  allocations: Allocation[];
  /**
   * Stratejinin VETO'lari + harness redleri (NO_ATR_SIZING, ALLOCATION_CAP, ...).
   * "Neden tahsis yok" sorusunun cevabi burada durur; sessizce yutulursa 0 tahsis'in
   * sebebi teshis EDILEMEZ hale gelir.
   */
  rejections: Rejection[];
  /** Degerlendirildi, ne sinyal ne veto uretti — strateji "bekle" dedi. */
  noSignal: string[];
  actions: LiveAction[];
  /** Borsada olup defterde olmayan pozisyonlar — bunlara DOKUNULMAZ. */
  unmanaged: string[];
  /**
   * Backtest'in ALACAGI ama borsanin ALDIRMADIGI pozisyonlar (EXCHANGE_ONLY_SKIPS).
   * Bos degilse: bu kosu backtest'ten IRAKSADI ve sonuclari kiyaslanamaz.
   */
  divergences: LiveAction[];
}

export interface LiveRunArgs {
  /** true: hicbir emir gonderilmez, ne yapilacagi raporlanir. */
  dryRun: boolean;
  allowMainnet?: boolean;
  /** Sampiyon live.enabled=false olsa bile kos. */
  force?: boolean;
  /** Karar bari — verilmezse su anki bar. */
  at?: number;
  /** Anahtar yoksa (yalniz kuru kosu) sizing icin varsayilan bakiye. */
  fallbackBalance?: number;
}

export interface Champion {
  id: string;
  name: string;
  source: string;
  params: Record<string, number | boolean>;
  profile: StrategyProfile;
  risk: RiskParams;
  costs: CostConfig;
  /** Canlida ISLEM ACILABILECEK semboller — evren eksi operatorun kapattiklari. */
  symbols: string[];
  /** Sampiyonun BACKTEST'TE olculdugu tam evren. Panel "neyi kapatabilirim"i buradan bilir. */
  universe: string[];
  /** Operatorun panelden kapattiklari (universe \ symbols). */
  disabled: string[];
  interval: CandleInterval;
  warmupBars: number;
  /**
   * Stratejinin KENDI grid ekseni: taranacak parametreler ve kac kombinasyon ettikleri.
   *
   * Panele acilmasinin sebebi: backtest'in toplam hucre sayisi risk grid'i x BU sayidir.
   * Panel bu carpani bilmezse operatore "768 risk hucresi, tavanin altinda" der, motor
   * ayni grid'i 18 ile carpip reddeder — ve bunu ancak veri indirildikten sonra yapar.
   */
  sweep: {
    cells: number;
    /** Stratejinin kendi tavani (meta.maxSweepCells) — `cells` bunu asamaz. */
    maxCells: number;
    axes: Array<{ key: string; values: Array<number | boolean> }>;
  };
  record: ChampionRecord | null;
}

/** Sampiyonu yukler. Promosyon kaydi varsa kod sha256 ile DOGRULANIR. */
export async function loadLiveChampion(): Promise<Champion> {
  const rec = readChampion();

  // sha uyusmazsa loadChampionSource FIRLATIR — backtest'i gecen kod ile diskteki kod
  // ayni degilse tek emir bile gitmemeli (champion.ts:78).
  const source = rec
    ? loadChampionSource(rec)
    : fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');

  const meta = (await loadMeta(source)).meta;

  const params: Record<string, number | boolean> = rec?.params ?? {};
  if (!rec) for (const p of meta.params) params[p.key] = p.default;

  /**
   * Evren = sampiyonun sinavini verdigi sembol kumesi. Operator panelden bunu yalnizca
   * DARALTABILIR (config/portfolio.ts). Kapatilan sembolde bu kosuda pozisyon acilmaz;
   * o sembolde ZATEN ACIK olan pozisyon yetim kalmaz — asagidaki mutabakat onu defterden
   * okumaya ve yonetmeye (BE/TP/SL) devam eder, cunku champ.symbols'dan dusen sembol
   * "yonetilmeyen" degil, "yeni giris yapilmayan"dir.
   */
  const universe = rec?.symbols ?? [...env.nightly.symbols];
  const symbols = resolveLiveSymbols(universe);

  return {
    id: rec ? `${rec.strategyId}@${rec.version}` : 'mechanical-v0@builtin',
    name: rec ? rec.name : meta.name,
    source,
    params,
    profile: rec?.profile ?? 'balanced',
    risk: rec?.risk ?? DEFAULT_RISK_PARAMS,
    costs: rec?.costConfig ?? DEFAULT_COSTS,
    symbols,
    universe,
    disabled: universe.filter((s) => !symbols.includes(s)),
    interval: rec?.interval ?? env.nightly.interval,
    warmupBars: meta.warmupBars,
    sweep: {
      cells: paramCellCount(meta.params),
      maxCells: meta.maxSweepCells ?? DEFAULT_MAX_SWEEP_CELLS,
      axes: meta.params
        .filter((p) => p.sweep && p.sweep.length > 1)
        .map((p) => ({ key: p.key, values: [...p.sweep!] })),
    },
    record: rec,
  };
}

export async function runLiveOnce(args: LiveRunArgs): Promise<LiveRunResult> {
  // --- 0) VENUE KAPISI. Gercek para yalnizca bilincli izinle.
  ex.assertOrderVenue(args.allowMainnet ?? false);

  const champ = await loadLiveChampion();

  if (champ.record && !champ.record.live.enabled && !args.force) {
    throw new Error(
      `Sampiyon ${champ.id} icin canli islem KAPALI (champion.json: live.enabled=false).\n` +
        'Acmak icin champion.json duzenle veya --force ile kos.',
    );
  }

  const at = args.at ?? currentDecisionBar(champ.interval);
  const ms = INTERVAL_MS[champ.interval];
  const cooldownMs = cooldownMsFor(champ.interval);

  const state = readState(champ.id);
  pruneExits(state, cooldownMs, at);

  const actions: LiveAction[] = [];

  // --- 1) VERI. Yalnizca KAPANMIS mumlar cekilir (to = at - 1).
  //
  // `to = at` deseydik Binance o an OLUSMAKTA OLAN mumu da dondururdu ve ensureKlines
  // onu SQLite'a yazardi. O yarim mum kalici olarak cache'te kalir; sonraki her backtest
  // onu gercek bir mum sanar ve o barin high/low'u YALAN olur. Tek karakter, kalici veri
  // bozulmasi.
  const syncFrom = at - (champ.warmupBars + 60) * ms;

  // Veri, islem acilacak sembollerin BIRLESIMI defterde ACIK olanlarla cekilir. Operator
  // bir sembolu kapattiginda o sembolde yeni giris olmaz — ama acik pozisyonu hala
  // yonetiyoruz (breakeven, TP/SL) ve yonetmek MUM ISTER. Yalnizca champ.symbols'i
  // cekseydik, kapatilan sembolun acik pozisyonu koruma seviyeleri guncellenmeden
  // ortada kalirdi.
  const dataSymbols = new Set([...champ.symbols, ...state.positions.map((p) => p.symbol)]);
  for (const symbol of dataSymbols) {
    await ensureKlines(symbol, champ.interval, syncFrom, at - 1);
    await ensureFunding(symbol, syncFrom, at - 1);
  }

  // --- 2) BORSA MUTABAKATI. Defter borsaya gore duzeltilir.
  const hasKeys = Boolean(env.binance.apiKey && env.binance.apiSecret);
  let balance = args.fallbackBalance ?? 10_000;
  let availableMargin = balance;
  let unmanaged: string[] = [];
  let filters: Map<string, ex.SymbolFilters> | null = null;

  if (hasKeys) {
    await ex.checkConnection();
    const acct = await ex.getAccountBalance();
    // Sizing TOPLAM bakiyeden (simulator'daki balance() ile ayni anlam); margin butcesi
    // KULLANILABILIR bakiyeden — acik pozisyonlarin tuttugu margin dusulmus hali.
    balance = acct.totalWalletBalance;
    availableMargin = acct.availableBalance;
    filters = await ex.loadFilters();
    unmanaged = await reconcile(state, champ, args.dryRun, actions);
  } else if (!args.dryRun) {
    throw new Error('Emir gondermek icin BINANCE_API_KEY / BINANCE_API_SECRET gerekli.');
  }

  // --- 3) BREAKEVEN. Simulator her mumda tasir; biz de her mum kapanisinda.
  await manageBreakeven(state, champ, at, args.dryRun, actions);

  // --- 4) KARAR. Backtest ile AYNI sandbox yolu, tek karar noktasinda.
  const decision = await decideNow({
    source: champ.source,
    params: champ.params,
    profile: champ.profile,
    symbols: champ.symbols,
    interval: champ.interval,
    at,
    warmupBars: champ.warmupBars,
    // Backtest de makro istahi null ile kosar (nightly.ts). Canlida farkli bir deger
    // kullanmak, olculmemis bir strateji kosmak olurdu.
    macroRiskAppetite: null,
  });

  /**
   * Karar veren her sembol ya bir tahsis ya bir red uretir. Geri kalanlar icin strateji
   * cagrildi ve "bekle" dedi. Bu ayrim raporda TUTULUR: "strateji bekliyor" ile "strateji
   * hepsini veto etti" ayni satira dusurulurse, 0 tahsis'in sebebi teshis edilemez.
   */
  const decided = new Set([
    ...decision.allocations.map((a) => a.symbol),
    ...decision.rejections.map((r) => r.symbol),
  ]);
  const noSignal = champ.symbols.filter((s) => !decided.has(s));

  // --- 5) PLAN. Kapilarin tamami burada (saf, test edilebilir).
  const bars: Record<string, ClosedBar | null> = {};
  for (const alloc of decision.allocations) {
    bars[alloc.symbol] = lastClosedBar(champ, alloc.symbol, at);
  }

  const plan = planActions({
    allocations: decision.allocations,
    bars,
    balance,
    availableMargin,
    risk: champ.risk,
    costs: champ.costs,
    state,
    at,
    cooldownMs,
    filters,
    unmanaged,
  });

  // --- 6) YURUTME.
  for (const step of plan) {
    if (step.kind === 'SKIP') {
      actions.push({ symbol: step.alloc.symbol, side: step.alloc.side, kind: 'SKIPPED', reason: step.reason });
    } else if (step.kind === 'CLOSE') {
      await closePosition(state, step.position, step.reason, args.dryRun, actions);
    } else {
      await openPosition({ state, champ, step, at, filters, dryRun: args.dryRun, actions });
    }
  }

  state.lastRunAt = Date.now();
  state.lastDecisionBar = at;
  if (!args.dryRun) writeState(state);

  const divergences = actions.filter(
    (a) => a.kind === 'SKIPPED' && EXCHANGE_ONLY_SKIPS.includes(a.reason as SkipReason),
  );

  return {
    decisionBar: at,
    dryRun: args.dryRun,
    testnet: ex.IS_TESTNET,
    champion: `${champ.name} (${champ.id})`,
    balance,
    availableMargin,
    symbols: champ.symbols,
    disabled: champ.disabled,
    allocations: decision.allocations,
    rejections: decision.rejections,
    noSignal,
    actions,
    unmanaged,
    divergences,
  };
}

// ---------------------------------------------------------------- mutabakat

/**
 * Defteri borsayla eslestirir.
 *
 * Defterde olup borsada olmayan = kapanmis (stop/TP yendi). Cikis sebebi realize PnL'den
 * cikarsanir ve cooldown gecmisine yazilir; geride kalan koruma emirleri temizlenir.
 *
 * Borsada olup defterde olmayan = BIZIM ACMADIGIMIZ pozisyon (elle acilmis ya da defter
 * kaybolmus). Bunlari SAHIPLENMIYORUZ: riskUSD'sini, giris ATR'sini ve stop mesafesini
 * bilmiyoruz — yani RISK_CAP'e katamayiz ve stop'unu yonetemeyiz. Sessizce ustune islem
 * yapmak yerine o sembolu tamamen es geciyoruz ve yuksek sesle raporluyoruz.
 */
async function reconcile(
  state: LiveState,
  champ: Champion,
  dryRun: boolean,
  actions: LiveAction[],
): Promise<string[]> {
  const live = await ex.getOpenPositions();
  const bySymbol = new Map(live.map((p) => [p.symbol, p]));

  const stillOpen: LedgerPosition[] = [];

  for (const pos of state.positions) {
    // Yon de tutmali: ayni sembolde TERS yonde duran bir pozisyon bizimki DEGILDIR.
    const onExchange = bySymbol.get(pos.symbol);
    if (onExchange && onExchange.side === pos.side) {
      stillOpen.push(pos);
      continue;
    }

    // Kapanmis. Sebebi borsa soylemez -> realize PnL vekili (bkz. binanceOrders.ts).
    let realized = 0;
    let pnlUnknown = false;
    try {
      realized = await ex.getRealizedPnlSince(pos.symbol, pos.entryTime);
    } catch {
      // PnL okunamadi: cooldown'u KAPATMAK yerine ACIK varsay (muhafazakar taraf).
      realized = -1;
      pnlUnknown = true;
    }

    const reason = realized < 0 ? 'STOP' : 'PROFIT';
    const exitTime = Date.now();
    state.exits.push({
      symbol: pos.symbol,
      side: pos.side,
      exitTime,
      reason,
      realizedPnl: realized,
    });

    /**
     * Kalici deftere yaz. state.exits budanir (cooldown penceresi), bu satir budanmaz —
     * panelin winrate'i ve PnL egrisi bunun uzerinde durur.
     *
     * pnlUnknown=true olan satir istatistige KATILMAZ: yukaridaki -1 bir cikis sebebi
     * vekilidir, bir zarar olcumu degil. Onu gercek zarar sayarsak winrate'i kendi
     * hatamizla asagi cekmis oluruz.
     */
    appendTrade({
      symbol: pos.symbol,
      side: pos.side,
      championId: champ.id,
      entryTime: pos.entryTime,
      exitTime,
      entryFill: pos.entryFill,
      qtyBase: pos.qtyBase,
      margin: pos.margin,
      leverage: pos.leverage,
      confidence: pos.confidence,
      riskUSD: pos.riskUSD,
      reason,
      realizedPnl: realized,
      pnlUnknown,
      dryRun,
    });

    // Geride kalan bacagi temizle (SL doldu -> TP hala emir defterinde).
    if (!dryRun) await ex.cancelAllOpenOrders(pos.symbol);

    actions.push({
      symbol: pos.symbol,
      side: pos.side,
      kind: 'CLOSED',
      reason: `${reason} (realize $${realized.toFixed(2)})`,
    });
  }

  state.positions = stillOpen;

  const managed = new Set(stillOpen.map((p) => p.symbol));
  // EVREN uzerinden bakilir, canli kume uzerinden degil: operator bir sembolu kapatinca
  // borsadaki yetim pozisyon GORUNMEZ olmamali — kapatmak, gormezden gelmek degildir.
  return live.filter((p) => !managed.has(p.symbol) && champ.universe.includes(p.symbol)).map((p) => p.symbol);
}

// ---------------------------------------------------------------- breakeven

/**
 * simulator.ts:538 ile ayni kural: fiyat breakevenTriggerPrice'a DEGDIYSE stop girise
 * (± tampon) cekilir. Simulator bunu mumun high/low'u ile olcer — biz de son KAPANMIS
 * mumun high/low'u ile.
 *
 * Sira kasitli: ONCE yeni stop konur, SONRA eskisi iptal edilir. Tersi olsaydi pozisyon
 * iki cagri arasinda KORUMASIZ kalirdi (sample de bu sirayi kullaniyor: binance.ts:363).
 */
async function manageBreakeven(
  state: LiveState,
  champ: Champion,
  at: number,
  dryRun: boolean,
  actions: LiveAction[],
): Promise<void> {
  const beR = champ.risk.breakevenAtR;
  if (beR === false) return;

  for (const pos of state.positions) {
    const stopDist = Math.abs(pos.entryFill - pos.initialStopPrice);
    if (!(stopDist > 0)) continue;

    const isLong = pos.side === 'LONG';
    const bePrice = isLong
      ? pos.entryFill * (1 + champ.risk.breakevenBufferPct / 100)
      : pos.entryFill * (1 - champ.risk.breakevenBufferPct / 100);

    // Stop zaten breakeven'a (veya otesine) tasinmis mi?
    const already = isLong ? pos.initialStopPrice >= bePrice : pos.initialStopPrice <= bePrice;
    if (already) continue;

    const trigger = isLong ? pos.entryFill + beR * stopDist : pos.entryFill - beR * stopDist;

    const bar = lastClosedBar(champ, pos.symbol, at);
    if (!bar) continue;

    const hit = isLong ? bar.high >= trigger : bar.low <= trigger;
    if (!hit) continue;

    if (!dryRun) {
      const f = ex.filtersFor(await ex.loadFilters(), pos.symbol);
      const newStop = ex.roundToTick(bePrice, f.tickSize);

      const newId = await ex.placeStopMarket({
        symbol: pos.symbol,
        positionSide: pos.side,
        triggerPrice: newStop,
      });

      if (pos.slOrderId) {
        try {
          await ex.cancelOrder(pos.symbol, pos.slOrderId);
        } catch {
          // Eski stop iptal edilemedi: pozisyonda iki stop var, ikisi de closePosition.
          // Ilk tetiklenen kapatir, digeri bosa duser — zararsiz, ama sessiz gecme.
          actions.push({
            symbol: pos.symbol,
            side: pos.side,
            kind: 'FAILED',
            reason: 'eski stop iptal edilemedi (iki stop acik — elle kontrol)',
          });
        }
      }

      pos.slOrderId = newId;
      pos.initialStopPrice = newStop;
    }

    actions.push({
      symbol: pos.symbol,
      side: pos.side,
      kind: 'BREAKEVEN',
      stopPrice: bePrice,
      reason: `+${beR}R'a ulasti — stop breakeven'a tasindi`,
    });
  }
}

// ---------------------------------------------------------------- emirler

async function openPosition(a: {
  state: LiveState;
  champ: Champion;
  step: PlannedOpen;
  at: number;
  filters: Map<string, ex.SymbolFilters> | null;
  dryRun: boolean;
  actions: LiveAction[];
}): Promise<void> {
  const { state, step, dryRun, actions } = a;
  const { alloc } = step;
  const isLong = alloc.side === 'LONG';

  if (dryRun) {
    actions.push({
      symbol: alloc.symbol,
      side: alloc.side,
      kind: 'OPENED',
      reason: 'DRY-RUN (emir gonderilmedi)',
      qtyBase: step.qtyBase,
      margin: step.margin,
      leverage: alloc.leverage,
      entryFill: step.estFill,
      stopPrice: step.estStopPrice,
      takeProfitPrice: step.estTakeProfitPrice,
      riskUSD: step.riskUSD,
    });
    return;
  }

  await ex.setLeverage(alloc.symbol, alloc.leverage);

  // clientOrderId karar barina baglanir: ayni bar iki kez islenirse (yeniden baslatma,
  // cakisan cron) borsa AYNI id'yi reddeder -> cift pozisyon olmaz.
  const clientOrderId = `tc-${a.at}-${alloc.symbol}-${alloc.side}`.slice(0, 36);

  let fill: ex.FillResult;
  try {
    fill = await ex.placeMarketEntry({
      symbol: alloc.symbol,
      side: alloc.side,
      qtyBase: step.qtyBase,
      clientOrderId,
    });
  } catch (err) {
    actions.push({
      symbol: alloc.symbol,
      side: alloc.side,
      kind: 'FAILED',
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  /**
   * GERCEK dolum fiyati. Simulator TP/SL'i entryFill'den turetir (simulator.ts:320) —
   * canlida entryFill'in karsiligi budur. Modellenen fiyattan turetseydik koruma
   * seviyeleri pozisyonun gercek maliyetine gore KAYIK olurdu ve R mesafesi kurgu olurdu.
   */
  let entryFill = fill.avgPrice;
  if (!(entryFill > 0)) {
    const pos = (await ex.getOpenPositions()).find((p) => p.symbol === alloc.symbol);
    entryFill = pos?.entryPrice ?? 0;
  }
  if (!(entryFill > 0)) {
    actions.push({
      symbol: alloc.symbol,
      side: alloc.side,
      kind: 'FAILED',
      reason: 'dolum fiyati okunamadi — pozisyon KORUMASIZ olabilir, elle kontrol et',
    });
    return;
  }

  const filled = fill.executedQty > 0 ? fill.executedQty : step.qtyBase;

  const slPrice = isLong
    ? entryFill * (1 - step.stopLossPct / 100)
    : entryFill * (1 + step.stopLossPct / 100);
  const tpPrice = isLong
    ? entryFill * (1 + step.takeProfitPct / 100)
    : entryFill * (1 - step.takeProfitPct / 100);

  const f = ex.filtersFor(a.filters ?? (await ex.loadFilters()), alloc.symbol);
  const stopTrigger = ex.roundToTick(slPrice, f.tickSize);
  const tpTrigger = ex.roundToTick(tpPrice, f.tickSize);

  // Hard stop HER ZAMAN konur — trailing'de bile. Simulator'da da hard stop bir TABANDIR:
  // exitLevel = max(trail, stopLossPrice) (simulator.ts:656).
  let slOrderId: string | null = null;
  let tpOrderId: string | null = null;

  try {
    slOrderId = await ex.placeStopMarket({
      symbol: alloc.symbol,
      positionSide: alloc.side,
      triggerPrice: stopTrigger,
    });
  } catch (err) {
    // Stop konulamadi -> pozisyon KORUMASIZ. Acik birakmaktansa hemen kapat.
    actions.push({
      symbol: alloc.symbol,
      side: alloc.side,
      kind: 'FAILED',
      reason: `stop konulamadi (${err instanceof Error ? err.message : err}) — pozisyon kapatiliyor`,
    });
    await ex.closePositionMarket({
      symbol: alloc.symbol,
      positionSide: alloc.side,
      qtyBase: filled,
      clientOrderId: `${clientOrderId}-x`.slice(0, 36),
    });
    return;
  }

  if (DEFAULT_USE_TRAILING) {
    tpOrderId = await ex
      .placeTrailingStop({
        symbol: alloc.symbol,
        positionSide: alloc.side,
        qtyBase: filled,
        activationPrice: tpTrigger, // simulator: activationPrice = tpPrice (simulator.ts:354)
        callbackRate: step.callbackRatePct,
      })
      .catch((err: unknown) => {
        // Trailing gitmedi ama hard stop DURUYOR — pozisyon korumasiz degil.
        actions.push({
          symbol: alloc.symbol,
          side: alloc.side,
          kind: 'FAILED',
          reason: `trailing konulamadi: ${err instanceof Error ? err.message : err} (hard stop duruyor)`,
        });
        return null;
      });
  } else {
    tpOrderId = await ex.placeTakeProfitMarket({
      symbol: alloc.symbol,
      positionSide: alloc.side,
      triggerPrice: tpTrigger,
    });
  }

  state.positions.push({
    symbol: alloc.symbol,
    side: alloc.side,
    entryTime: Date.now(),
    entryFill,
    qtyBase: filled,
    margin: step.margin,
    leverage: alloc.leverage,
    confidence: alloc.confidence,
    riskUSD: step.riskUSD,
    initialStopPrice: stopTrigger,
    activationPrice: DEFAULT_USE_TRAILING ? tpTrigger : undefined,
    callbackRate: DEFAULT_USE_TRAILING ? step.callbackRatePct : undefined,
    entryOrderId: fill.orderId,
    slOrderId,
    tpOrderId,
    decisionBar: a.at,
  });

  actions.push({
    symbol: alloc.symbol,
    side: alloc.side,
    kind: 'OPENED',
    qtyBase: filled,
    margin: step.margin,
    leverage: alloc.leverage,
    entryFill,
    stopPrice: stopTrigger,
    takeProfitPrice: tpTrigger,
    riskUSD: step.riskUSD,
  });
}

/** Ters sinyal geldi: pozisyonu piyasa emriyle kapat (simulator: SIGNAL_CHANGE). */
async function closePosition(
  state: LiveState,
  pos: LedgerPosition,
  reason: 'SIGNAL_CHANGE',
  dryRun: boolean,
  actions: LiveAction[],
): Promise<void> {
  if (!dryRun) {
    // Once koruma emirlerini kaldir: reduceOnly trailing pozisyon kapandiktan sonra emir
    // defterinde kalirsa BIR SONRAKI girisi kismen kapatabilir.
    await ex.cancelAllOpenOrders(pos.symbol);
    await ex.closePositionMarket({
      symbol: pos.symbol,
      positionSide: pos.side,
      qtyBase: pos.qtyBase,
      clientOrderId: `tc-close-${Date.now()}-${pos.symbol}`.slice(0, 36),
    });
  }

  state.positions = state.positions.filter((p) => p !== pos);
  state.exits.push({
    symbol: pos.symbol,
    side: pos.side,
    exitTime: Date.now(),
    reason,
    realizedPnl: 0,
  });

  actions.push({ symbol: pos.symbol, side: pos.side, kind: 'CLOSED', reason });
}

// ---------------------------------------------------------------- veri

/**
 * Karar barindan ONCEKI son kapali mum + o mumun ATR'si.
 *
 * simulator'un priceAt (kati `openTime < t`) ve atrAt kesitiyle AYNI — strateji neyi
 * gorduyse sizing de onu gorur. `<=` olsaydi henuz kapanmamis mum girerdi ve canli,
 * backtest'in hic gormedigi bir fiyattan pozisyon buyuklugu hesaplardi.
 */
function lastClosedBar(champ: Champion, symbol: string, at: number): ClosedBar | null {
  const db = openReadOnly();
  try {
    const from = at - (champ.warmupBars + 60) * INTERVAL_MS[champ.interval];
    const closed = getKlines(db, symbol, champ.interval, from, at).filter((k) => k.openTime < at);
    if (closed.length === 0) return null;

    const series = computeIndicatorSeriesCached(symbol, champ.interval, closed);
    const j = closed.length - 1;

    const bar = closed[j]!;
    const atr = series[j]?.atr;

    return {
      close: bar.close,
      high: bar.high,
      low: bar.low,
      atr: typeof atr === 'number' && atr > 0 ? atr : 0,
    };
  } finally {
    db.close();
  }
}
