import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getJob, isRunning, listRuns, readRun, startBacktest } from './backtestJobs';
import { buildRiskCells, DEFAULT_GRID, MAX_CELLS, type GridSpec } from '../engine/backtest';
import { loadLiveChampion, runLiveOnce } from '../engine/liveExecutor';
import { PROFILES, MAX_LEVERAGE } from '../engine/portfolio';
import { computeLiveStats, readTrades } from '../lib/tradeLog';
import { readState } from '../lib/liveState';
import { readChampion } from '../orchestrator/champion';
import { activateModel, listModels } from '../orchestrator/models';
import { publicGet } from '../services/binanceClient';
import * as ex from '../services/binanceOrders';
import { readPortfolio, writePortfolio } from '../config/portfolio';
import { env, REPORTS_DIR } from '../config/env';

/**
 * PANEL API'si.
 *
 * Kural: bu katman HESAPLAMA YAPMAZ, motoru cagirir. Panelde gorunen her sayi, motorun
 * kendi fonksiyonlarindan (tradeLog.computeLiveStats, engine/challenge, liveExecutor)
 * cikar. Panele ozel bir "winrate" formulu yazmak, sistemin kendisiyle celisen ikinci
 * bir gercek uretmek olurdu — ve o ikisi ayrisinca hangisinin dogru oldugunu kimse
 * bilemezdi.
 *
 * Ikinci kural: veri YOKSA sifir uydurulmaz. Motor hic kosmadiysa API bunu acikca soyler
 * (`hasData: false`), panel de "henuz kosmadi" der. Bos bir winrate %0 DEGILDIR.
 */

export const api = Router();

const hasKeys = () => Boolean(env.binance.apiKey && env.binance.apiSecret);

/* ------------------------------------------------------------------ durum --- */

api.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    testnet: env.binance.testnet,
    liveTrading: env.live.enabled,
    hasKeys: hasKeys(),
    interval: env.nightly.interval,
    nightlyCron: env.nightly.cron,
  });
});

/** Sampiyon + operator evreni + motor modu. Panelin ust seridi bunu okur. */
api.get('/overview', async (_req, res, next) => {
  try {
    const rec = readChampion();
    const champ = await loadLiveChampion();
    const trades = readTrades();
    const stats = computeLiveStats(trades);
    const state = readState(champ.id);

    let balance: { totalWalletBalance: number; availableBalance: number } | null = null;
    if (hasKeys()) {
      try {
        balance = await ex.getAccountBalance();
      } catch {
        // Anahtar var ama borsa okunamadi: bakiye YOK, sifir DEGIL.
        balance = null;
      }
    }

    res.json({
      champion: {
        id: champ.id,
        name: champ.name,
        promoted: rec !== null,
        author: rec?.author ?? 'human',
        version: rec?.version ?? 0,
        promotedAt: rec?.promotedAt ?? null,
        profile: champ.profile,
        interval: champ.interval,
        params: champ.params,
        risk: champ.risk,
        provenance: rec?.provenance ?? null,
        evaluation: rec?.evaluation ?? null,
        liveEnabled: rec?.live.enabled ?? false,
        // Backtest konsolunun toplam hucre matematigi icin: toplam = sweep.cells x risk.
        sweep: champ.sweep,
      },
      universe: champ.universe,
      symbols: champ.symbols,
      disabled: champ.disabled,
      engine: {
        testnet: env.binance.testnet,
        liveTrading: env.live.enabled,
        hasKeys: hasKeys(),
        lastRunAt: state.lastRunAt || null,
        openPositions: state.positions.length,
      },
      balance,
      stats,
      hasData: stats.totalTrades > 0,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ canli --- */

/** Canli panel: acik pozisyonlar (borsa mark fiyatiyla), kapanmis islemler, istatistik. */
api.get('/live', async (_req, res, next) => {
  try {
    const champ = await loadLiveChampion();
    const state = readState(champ.id);
    const trades = readTrades();
    const stats = computeLiveStats(trades);

    // Acik pozisyonlar defterden gelir (riskUSD, giris stop'u yalnizca orada var), mark
    // fiyati borsadan. Borsa okunamiyorsa mark yerine null doner — panel "-" gosterir,
    // 0 gostermez.
    let marks = new Map<string, { markPrice: number; unrealizedPnl: number }>();
    if (hasKeys()) {
      try {
        const live = await ex.getOpenPositions();
        marks = new Map(live.map((p) => [p.symbol, { markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl }]));
      } catch {
        marks = new Map();
      }
    }

    const positions = state.positions.map((p) => {
      const m = marks.get(p.symbol) ?? null;
      return {
        ...p,
        markPrice: m?.markPrice ?? null,
        unrealizedPnl: m?.unrealizedPnl ?? null,
        /** Giris stop'una gore R mesafesi — pozisyon ne kadar risk tasiyor. */
        rMultiple:
          m && p.riskUSD > 0
            ? (m.unrealizedPnl / p.riskUSD)
            : null,
      };
    });

    res.json({
      champion: { id: champ.id, name: champ.name, interval: champ.interval, profile: champ.profile },
      engine: { testnet: env.binance.testnet, liveTrading: env.live.enabled, hasKeys: hasKeys() },
      lastRunAt: state.lastRunAt || null,
      positions,
      stats,
      trades: trades.slice(-100).reverse(),
      hasData: stats.totalTrades > 0 || state.positions.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Canli kosuyu ELLE tetikle.
 *
 * dryRun VARSAYILAN OLARAK env.live.enabled'in tersidir — panelden gonderilen bir bayrakla
 * gercek emir GONDERILEMEZ. Emir gondermek bir deploy kararidir (LIVE_TRADING=true),
 * bir buton tiklamasi degil. Panel yalnizca "simdi kos" diyebilir; "gercek parayla kos"
 * diyemez.
 */
api.post('/live/run', async (_req, res, next) => {
  try {
    const result = await runLiveOnce({ dryRun: !env.live.enabled });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- portfoy --- */

/**
 * Portfoy: sampiyonun evreni + operatorun actigi/kapattigi semboller + canli fiyat.
 *
 * Evren SAMPIYONDAN gelir, panelden degil. Panelden sembol EKLENEMEZ (config/portfolio.ts):
 * eklemek, backtest'in hic olcmedigi bir sembolde para riske etmek olurdu.
 */
api.get('/portfolio', async (_req, res, next) => {
  try {
    const champ = await loadLiveChampion();
    const cfg = readPortfolio();
    const state = readState(champ.id);
    const trades = readTrades();

    // 24s ticker — public (mainnet) veri, anahtar gerektirmez.
    let tickers = new Map<string, { price: number; change24h: number; volume24h: number }>();
    try {
      const raw = await publicGet<Array<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }>>(
        '/fapi/v1/ticker/24hr',
        { weight: 40 },
      );
      tickers = new Map(
        raw.map((t) => [
          t.symbol,
          {
            price: parseFloat(t.lastPrice),
            change24h: parseFloat(t.priceChangePercent),
            volume24h: parseFloat(t.quoteVolume),
          },
        ]),
      );
    } catch {
      tickers = new Map();
    }

    const openBySymbol = new Set(state.positions.map((p) => p.symbol));

    const assets = champ.universe.map((symbol) => {
      const t = tickers.get(symbol) ?? null;
      const symTrades = trades.filter((tr) => tr.symbol === symbol && !tr.pnlUnknown && !tr.dryRun);
      const wins = symTrades.filter((tr) => tr.realizedPnl > 0).length;

      return {
        symbol,
        enabled: !cfg.disabled.includes(symbol),
        hasOpenPosition: openBySymbol.has(symbol),
        price: t?.price ?? null,
        change24h: t?.change24h ?? null,
        volume24h: t?.volume24h ?? null,
        /** Bu sembolun CANLI gecmisi — backtest degil, gercekten olan. */
        live: {
          trades: symTrades.length,
          winRate: symTrades.length > 0 ? (wins / symTrades.length) * 100 : null,
          pnl: symTrades.reduce((s, tr) => s + tr.realizedPnl, 0),
        },
      };
    });

    res.json({
      champion: { id: champ.id, name: champ.name, profile: champ.profile, interval: champ.interval },
      assets,
      disabled: cfg.disabled,
      updatedAt: cfg.updatedAt || null,
      /** Profil, kaldirac ve tahsis tavanlarini belirler — panel bunlari GOSTERIR, degistirmez. */
      profileSpec: PROFILES[champ.profile],
      maxLeverage: MAX_LEVERAGE,
      engine: { liveTrading: env.live.enabled, testnet: env.binance.testnet },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sembolleri ac/kapat.
 *
 * Yalnizca evrenin ALT KUMESI kabul edilir. Evren disi bir sembol gelirse istek TUMUYLE
 * reddedilir — kismi uygulamak, operatorun gonderdiginden BASKA bir portfoy kaydetmek olur.
 */
api.put('/portfolio', async (req, res, next) => {
  try {
    const champ = await loadLiveChampion();
    const body = req.body as { disabled?: unknown };

    if (!Array.isArray(body.disabled) || body.disabled.some((s) => typeof s !== 'string')) {
      return res.status(400).json({ error: 'govde {disabled: string[]} olmali' });
    }

    const disabled = (body.disabled as string[]).map((s) => s.trim().toUpperCase());
    const unknown = disabled.filter((s) => !champ.universe.includes(s));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `sampiyonun evreninde olmayan sembol: ${unknown.join(', ')}. Evren: ${champ.universe.join(', ')}`,
      });
    }

    const cfg = writePortfolio(disabled);
    const stillOpen = readState(champ.id).positions.filter((p) => disabled.includes(p.symbol));

    return res.json({
      ...cfg,
      enabled: champ.universe.filter((s) => !cfg.disabled.includes(s)),
      /**
       * Kapatilan sembolde ACIK pozisyon varsa panel bunu sessizce gecmemeli: pozisyon
       * kapanmaz, yonetilmeye (BE/TP/SL) devam eder. Kapatmak "yeni giris yok" demektir,
       * "pozisyondan cik" DEMEZ — o, operatorun borsada verecegi ayri bir karardir.
       */
      openOnDisabled: stillOpen.map((p) => ({ symbol: p.symbol, side: p.side })),
    });
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- model --- */

/**
 * Canliya alinabilecek TUM modeller: builtin + gecmis sampiyonlar + degerlendirilmis
 * adaylar. Her satirda kapinin o model hakkindaki hukmu de doner — elle secim kapiyi
 * bypass eder ama operator neyi bypass ettigini GORMELIDIR.
 */
api.get('/models', async (_req, res, next) => {
  try {
    res.json({ models: await listModels() });
  } catch (err) {
    next(err);
  }
});

/**
 * Bir modeli elle canliya alir.
 *
 * ACIK POZISYONLARA DOKUNMAZ: defter sampiyon degistiginde pozisyonlari korur
 * (lib/liveState.ts:94), yalnizca cikis/cooldown gecmisi silinir. Yeni model devraldigi
 * pozisyonlari yonetmeye (breakeven/TP/SL) devam eder.
 *
 * Canli islem otomatik ACILMAZ: secim "bundan sonra bu strateji" demektir, "para riske
 * et" demez. Ikincisi panelden ayrica acilir.
 */
api.post('/models/:id/activate', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const champBefore = await loadLiveChampion();
    const openBefore = readState(champBefore.id).positions;

    const { record, gatePassed } = await activateModel(id);

    return res.json({
      champion: { id: `${record.strategyId}@${record.version}`, name: record.name, version: record.version },
      activatedBy: record.activatedBy,
      /** false ise: operator kapiyi gecemeyen bir modeli bilerek secti. */
      gatePassed,
      gate: record.gate ?? null,
      /**
       * Devralinan acik pozisyonlar. Panel bunu sessizce gecmemeli: pozisyonlar kapanmadi
       * ve artik YENI model tarafindan yonetiliyor.
       */
      inheritedPositions: openBefore.map((p) => ({ symbol: p.symbol, side: p.side })),
      liveEnabled: record.live.enabled,
    });
  } catch (err) {
    // Aktivasyon hatalari operator hatasidir (yanlis id, kodu degismis model), 500 degil.
    const message = err instanceof Error ? err.message : String(err);
    if (/bulunamadi|zaten canlida|canliya alinamaz|degisti/.test(message)) {
      return res.status(400).json({ error: message });
    }
    return next(err);
  }
});

/* -------------------------------------------------------------- backtest --- */

api.get('/backtest/runs', (_req, res) => {
  res.json({ running: isRunning(), runs: listRuns() });
});

api.post('/backtest/runs', async (req, res) => {
  const b = req.body as Record<string, unknown>;

  let grid: GridSpec | undefined;
  try {
    grid = parseGrid(b.grid);
  } catch (err) {
    // Gecersiz grid 400'dur, 409 degil: istek SU AN degil, HIC kabul edilemez.
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  /*
   * TOPLAM hucre kapisi — burada, kosu baslamadan once.
   *
   * Motorun tavani (runBacktest) zaten vardi ama ancak veri indirildikten sonra, yani
   * dakikalar sonra konusuyordu: operator "768 risk hucresi, tavanin altinda" gorup
   * Start'a basiyor, kosu ilerleme cubugunu doldurduktan sonra "13824 hucre" diye
   * dusuyordu. Carpan strateji ekseninden geliyor ve o eksen sampiyonun meta'sinda
   * duruyor — HTTP ucu onu okuyabilir, dolayisiyla okumali.
   */
  try {
    const riskCells = grid
      ? buildRiskCells(grid).length
      : buildRiskCells(DEFAULT_GRID).length;
    // fixedParams: strateji ekseni taranmaz, carpan 1'e iner.
    const sweep = (await loadLiveChampion()).sweep;
    const paramCells = b.fixedParams === true ? 1 : sweep.cells;
    const total = paramCells * riskCells;

    // Stratejinin KENDI tavani (meta.maxSweepCells): asilirsa runBacktest grid'i kurarken
    // duser. Aday kodunun sorunu, operatorun degil — ama bunu da simdi soylemek gerekir.
    if (paramCells > sweep.maxCells) {
      return res.status(400).json({
        error:
          `Strateji parametre grid'i ${paramCells} hucre, stratejinin kendi tavani ` +
          `${sweep.maxCells}. Aday meta'sindaki sweep listeleri kisalmali.`,
      });
    }

    if (total > MAX_CELLS) {
      return res.status(400).json({
        error:
          `Grid cok buyuk: ${paramCells} strateji x ${riskCells} risk = ${total} hucre ` +
          `(tavan ${MAX_CELLS}). Risk eksenlerini kisalt ya da strateji parametrelerini ` +
          `sabitle — sabitlemek carpani 1'e indirir.`,
      });
    }
  } catch (err) {
    // Sampiyon meta'si okunamadi (sha uyusmazligi, derleme hatasi): kosu zaten
    // baslayamazdi, sebebini simdi soyle.
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const job = startBacktest({
      symbols: Array.isArray(b.symbols) ? (b.symbols as string[]) : undefined,
      interval: b.interval as never,
      days: typeof b.days === 'number' ? b.days : undefined,
      profile: b.profile as never,
      initialBalance: typeof b.initialBalance === 'number' ? b.initialBalance : undefined,
      noCosts: b.noCosts === true,
      fixedParams: b.fixedParams === true,
      ...(grid ? { grid } : {}),
    });
    res.status(202).json({ id: job.id, status: job.status });
  } catch (err) {
    // Tek kosu kurali — 409, cunku istek gecerli ama SU AN kabul edilemez.
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const GRID_AXES = ['rewardRatios', 'slMultipliers', 'callbackMultipliers', 'riskPerTradePcts'] as const;

/**
 * Operatorun grid'ini dogrular. Verilmediyse undefined doner (motor DEFAULT_GRID kullanir).
 *
 * Eksen degerleri ARTAN SIRAYA sokulur ve tekrarlar atilir — bu kozmetik degil:
 * gridScoring'in plato havuzlamasi "±1 indeks = o eksende bir sonraki deger" varsayimi
 * uzerine kurulu (Chebyshev komsulugu). Karisik sirali bir eksende komsuluk anlamsiz
 * bir sey olcer ve plato skoru sessizce yalan soyler. Tekrarli deger de ayni hucreyi
 * iki kez kosturup komsu havuzunu kendisiyle sisirirdi.
 */
function parseGrid(raw: unknown): GridSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('grid bir nesne olmali: { rewardRatios, slMultipliers, callbackMultipliers, riskPerTradePcts }');
  }

  const src = raw as Record<string, unknown>;
  const out = {} as Record<(typeof GRID_AXES)[number], number[]>;

  for (const axis of GRID_AXES) {
    const v = src[axis];
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(`grid.${axis} bos olmayan bir sayi dizisi olmali`);
    }
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        throw new Error(`grid.${axis} yalnizca pozitif sonlu sayi icerebilir (gelen: ${JSON.stringify(n)})`);
      }
    }
    out[axis] = [...new Set(v as number[])].sort((x, y) => x - y);
  }

  // riskPerTradePct bir ORAN (0.05 = %5). 1'i gecen bir deger neredeyse kesinlikle
  // yuzde olarak yazilmistir; sessizce kabul etmek bakiyenin 5 katini riske etmek demek.
  for (const n of out.riskPerTradePcts) {
    if (n >= 1) {
      throw new Error(`grid.riskPerTradePcts oran cinsinden olmali (0.05 = %5); gelen ${n}`);
    }
  }

  // Yalnizca risk eksenlerinin carpimi — sampiyon meta'si okunmadan yapilabilen ucuz
  // on kontrol. Strateji ekseniyle CARPILMIS tavan bir alt blokta (POST govdesinde),
  // yine kosu baslamadan once.
  const riskCells = GRID_AXES.reduce((n, axis) => n * out[axis].length, 1);
  if (riskCells > MAX_CELLS) {
    throw new Error(`Risk grid'i ${riskCells} hucre, tavan ${MAX_CELLS}. Eksen listelerini kisalt.`);
  }

  return {
    rewardRatios: out.rewardRatios,
    slMultipliers: out.slMultipliers,
    callbackMultipliers: out.callbackMultipliers,
    riskPerTradePcts: out.riskPerTradePcts,
  };
}

/** Ilerleme pollemesi. Bitmisse sonucun tamami doner. */
api.get('/backtest/runs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (job) {
    return res.json({
      id: job.id,
      status: job.status,
      stage: job.stage,
      done: job.done,
      total: job.total,
      error: job.error ?? null,
      params: job.params,
      strategyName: job.strategyName,
      result: job.result ?? null,
    });
  }

  const stored = readRun(req.params.id);
  if (!stored) return res.status(404).json({ error: 'kosu bulunamadi' });
  return res.json({
    id: stored.id,
    status: 'done' as const,
    stage: 'bitti',
    done: 1,
    total: 1,
    error: null,
    params: stored.params,
    strategyName: stored.strategyName,
    result: stored,
  });
});

/* --------------------------------------------------------------- raporlar --- */

api.get('/reports', (_req, res) => {
  if (!fs.existsSync(REPORTS_DIR)) return res.json([]);
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.md')).sort().reverse();
  return res.json(files);
});

api.get('/reports/:name', (req, res) => {
  const file = path.join(REPORTS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'rapor bulunamadi' });
  res.type('text/markdown');
  return res.send(fs.readFileSync(file, 'utf8'));
});
