import axios, { AxiosError, type AxiosRequestConfig, type Method } from 'axios';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { backoffMs, sleep } from '../lib/rateLimiter';

/**
 * IMZALI (emir) trafigin TEK kapisi — binanceClient.ts'in isaret ettigi dosya.
 *
 * binanceClient.ts PUBLIC veriyi her zaman MAINNET'ten ceker (testnet'in tarihsel mumu
 * seyrektir). Burasi tam tersi: EMIR trafigi BINANCE_TESTNET=true iken testnet'e gider.
 * Ikisinin ayri dosyalar olmasi kasitli — "hangi ortama gidiyorum" sorusu tek satirda
 * cevaplanabilsin diye.
 *
 * Sample'dan (samplebackend/services/binance.ts) dort yerde BILINCLI olarak ayrilir:
 *
 *  1. HATALAR FIRLATIR, yutulmaz. Sample hata durumunda `{ price: 0 }` / `[]` donuyordu
 *     (:66, :226). Fiyatin 0 gelmesi "fiyat yok" degil "fiyat sifir" gibi akiyor ve
 *     asagida pozisyon buyuklugu hesabina giriyor. Sessiz sifir, yanlis boyutlu emrin
 *     en kisa yoludur. Burada her hata BinanceOrderError olarak yukari cikar.
 *
 *  2. BORSA FILTRELERI ZORLANIR. Sample yalnizca quantityPrecision'a yuvarliyordu (:123);
 *     LOT_SIZE.stepSize, MIN_NOTIONAL ve PRICE_FILTER.tickSize'i hic okumuyordu. Bu
 *     filtrelere uymayan emir borsada -1111 / -4164 ile reddedilir. Miktar stepSize'a
 *     ASAGI yuvarlanir (yukari yuvarlamak riski buyutur).
 *
 *  3. EMIRLER IDEMPOTENT. Her emrin bir clientOrderId'si var ve POST /order agda
 *     koparsa emir KOR SEKILDE TEKRARLANMAZ — once clientOrderId ile sorgulanir.
 *     Kor tekrar, cift pozisyon demektir.
 *
 *  4. SAAT KAYMASI TELAFI EDILIR. Binance recvWindow disindaki timestamp'i -1021 ile
 *     reddeder; laptop saati birkac saniye kayabilir. Sunucu saati bir kez okunur.
 */

const TESTNET_BASE = 'https://testnet.binancefuture.com';
const MAINNET_BASE = 'https://fapi.binance.com';

export const IS_TESTNET = env.binance.testnet;
const BASE = IS_TESTNET ? TESTNET_BASE : MAINNET_BASE;

const RECV_WINDOW = 5000;
const MAX_RETRIES = 3;

export class BinanceOrderError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly path: string,
  ) {
    super(message);
    this.name = 'BinanceOrderError';
  }
}

/**
 * MAINNET KAPISI. Gercek para yalnizca cagiran taraf BILINCLI olarak izin verirse.
 * Executor'un ilk satirinda cagrilir; testnet degilse ve izin yoksa hicbir emir gitmez.
 */
export function assertOrderVenue(allowMainnet: boolean): void {
  if (!IS_TESTNET && !allowMainnet) {
    throw new Error(
      'BINANCE_TESTNET=false — emirler GERCEK PARA ile mainnet\'e gidecekti. Reddedildi.\n' +
        'Testnet icin .env: BINANCE_TESTNET=true\n' +
        'Gercekten mainnet isteniyorsa: --allow-mainnet bayragi ile calistir.',
    );
  }
}

function credentials(): { key: string; secret: string } {
  const key = env.binance.apiKey;
  const secret = env.binance.apiSecret;
  if (!key || !secret) {
    throw new Error(
      'BINANCE_API_KEY / BINANCE_API_SECRET eksik. Testnet anahtarlari: https://testnet.binancefuture.com',
    );
  }
  return { key, secret };
}

// ---------------------------------------------------------------- saat senkronu

let clockOffsetMs = 0;
let clockSynced = false;

/** Sunucu saati ile yerel saatin farki. -1021 (timestamp out of recvWindow) icin. */
export async function syncClock(): Promise<number> {
  const res = await axios.get<{ serverTime: number }>(`${BASE}/fapi/v1/time`, { timeout: 15_000 });
  clockOffsetMs = res.data.serverTime - Date.now();
  clockSynced = true;
  return clockOffsetMs;
}

// ---------------------------------------------------------------- imzali istek

async function signed<T>(
  method: Method,
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const { key, secret } = credentials();
  if (!clockSynced) await syncClock();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    );
    query.set('recvWindow', String(RECV_WINDOW));
    query.set('timestamp', String(Date.now() + clockOffsetMs));

    const qs = query.toString();
    const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');

    const config: AxiosRequestConfig = {
      baseURL: BASE,
      url: `${path}?${qs}&signature=${signature}`,
      method,
      headers: { 'X-MBX-APIKEY': key },
      timeout: 30_000,
    };

    try {
      const res = await axios.request<T>(config);
      return res.data;
    } catch (err) {
      const ax = err as AxiosError<{ code?: number; msg?: string }>;
      const status = ax.response?.status;
      const code = ax.response?.data?.code ?? null;
      const msg = ax.response?.data?.msg ?? ax.message;

      // -1021: saat kaymis. Bir kez yeniden senkronize et ve tekrar dene.
      if (code === -1021 && attempt < MAX_RETRIES) {
        await syncClock();
        continue;
      }

      const retriable =
        status === undefined || status === 429 || status >= 500 || ax.code === 'ECONNRESET' || ax.code === 'ETIMEDOUT';

      if (!retriable || attempt === MAX_RETRIES) {
        throw new BinanceOrderError(msg, code, path);
      }

      await sleep(backoffMs(attempt));
    }
  }

  throw new BinanceOrderError('tum denemeler tukendi', null, path);
}

// ---------------------------------------------------------------- borsa filtreleri

export interface SymbolFilters {
  /** Miktar adimi (LOT_SIZE.stepSize). Emir miktari bunun tam katı olmali. */
  stepSize: number;
  minQty: number;
  /** Fiyat adimi (PRICE_FILTER.tickSize). Tetik fiyatlari bunun tam katı olmali. */
  tickSize: number;
  /** MIN_NOTIONAL — bunun altindaki notional reddedilir. */
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

interface RawFilter {
  filterType: string;
  stepSize?: string;
  minQty?: string;
  tickSize?: string;
  notional?: string;
}

interface RawSymbol {
  symbol: string;
  quantityPrecision: number;
  pricePrecision: number;
  filters: RawFilter[];
}

let filterCache: Map<string, SymbolFilters> | null = null;

/** exchangeInfo bir kez cekilir — sample bunu HER emirde yeniden cekiyordu (:93). */
export async function loadFilters(): Promise<Map<string, SymbolFilters>> {
  if (filterCache) return filterCache;

  const info = await axios.get<{ symbols: RawSymbol[] }>(`${BASE}/fapi/v1/exchangeInfo`, {
    timeout: 30_000,
  });

  const map = new Map<string, SymbolFilters>();
  for (const s of info.data.symbols) {
    const find = (t: string) => s.filters.find((f) => f.filterType === t);
    const lot = find('LOT_SIZE');
    const price = find('PRICE_FILTER');
    const notional = find('MIN_NOTIONAL');

    map.set(s.symbol, {
      stepSize: parseFloat(lot?.stepSize ?? '0.001'),
      minQty: parseFloat(lot?.minQty ?? '0'),
      tickSize: parseFloat(price?.tickSize ?? '0.01'),
      minNotional: parseFloat(notional?.notional ?? '5'),
      quantityPrecision: s.quantityPrecision,
      pricePrecision: s.pricePrecision,
    });
  }

  filterCache = map;
  return map;
}

export function filtersFor(map: Map<string, SymbolFilters>, symbol: string): SymbolFilters {
  const f = map.get(symbol);
  if (!f) throw new BinanceOrderError(`${symbol} borsada bulunamadi (exchangeInfo)`, null, '/fapi/v1/exchangeInfo');
  return f;
}

/**
 * Bir adima yuvarlama. Kayan nokta artigini (0.1+0.2) temizlemek icin adimin
 * ondalik basamagina gore kesilir.
 */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toExponential().split('e');
  const exp = Number(s[1]);
  if (exp >= 0) return 0;
  return Math.min(12, -exp + (s[0]!.split('.')[1]?.length ?? 0));
}

/**
 * IEEE-754 telafisi. Bolme, matematiksel olarak tam olan bir sonucu bir tik ALTINDA
 * verebilir: 0.3 / 0.1 = 2.9999999999999996. Bunu dogrudan Math.floor'a verirsek 2
 * cikar ve miktar TAM BIR ADIM eksilir (0.3 yerine 0.2 — %33 kucuk pozisyon, ve
 * riskUSD = miktar x stop mesafesi oldugu icin risk modeli de bozulur).
 *
 * Epsilon oransal: buyuk bolumlerde (miktar/step ~ 1e10) mutlak bir esik yetmez.
 */
const quantize = (value: number, step: number, round: (n: number) => number): number => {
  const q = value / step;
  const eps = 1e-9 * Math.max(1, Math.abs(q));
  return parseFloat((round(q + eps) * step).toFixed(decimalsOf(step)));
};

/** Miktari stepSize'a ASAGI yuvarlar. Yukari yuvarlamak riski buyutur — asla. */
export function floorToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  return quantize(qty, step, Math.floor);
}

/** Fiyati tickSize'a yuvarlar (tetik seviyeleri icin yon onemsiz — en yakin tick). */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return quantize(price, tick, Math.round);
}

// ---------------------------------------------------------------- hesap / pozisyon

export interface AccountBalance {
  totalWalletBalance: number;
  availableBalance: number;
}

export async function getAccountBalance(): Promise<AccountBalance> {
  const d = await signed<{ totalWalletBalance: string; availableBalance: string }>(
    'GET',
    '/fapi/v2/account',
  );
  const total = parseFloat(d.totalWalletBalance);
  const avail = parseFloat(d.availableBalance);

  if (!Number.isFinite(total) || !Number.isFinite(avail)) {
    throw new BinanceOrderError('hesap bakiyesi okunamadi', null, '/fapi/v2/account');
  }
  return { totalWalletBalance: total, availableBalance: avail };
}

export interface ExchangePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** Isaretli miktar (LONG > 0, SHORT < 0). */
  positionAmt: number;
  qtyBase: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnl: number;
}

export async function getOpenPositions(): Promise<ExchangePosition[]> {
  const raw = await signed<
    Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      leverage: string;
      unRealizedProfit: string;
    }>
  >('GET', '/fapi/v2/positionRisk');

  return raw
    .map((p) => {
      const amt = parseFloat(p.positionAmt);
      return {
        symbol: p.symbol,
        side: (amt >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
        positionAmt: amt,
        qtyBase: Math.abs(amt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        leverage: parseInt(p.leverage, 10),
        unrealizedPnl: parseFloat(p.unRealizedProfit) || 0,
      };
    })
    .filter((p) => p.qtyBase > 0);
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  const lev = Math.min(125, Math.max(1, Math.round(leverage)));
  await signed('POST', '/fapi/v1/leverage', { symbol, leverage: lev });
}

// ---------------------------------------------------------------- emirler

export interface FillResult {
  orderId: string;
  clientOrderId: string;
  /** Gercek ortalama dolum fiyati. TP/SL bundan turer — 0 ise pozisyon dogrulanamamistir. */
  avgPrice: number;
  executedQty: number;
  status: string;
}

interface RawOrder {
  orderId: number;
  clientOrderId: string;
  avgPrice?: string;
  executedQty?: string;
  status: string;
}

function toFill(d: RawOrder): FillResult {
  return {
    orderId: String(d.orderId),
    clientOrderId: d.clientOrderId,
    avgPrice: parseFloat(d.avgPrice ?? '0') || 0,
    executedQty: parseFloat(d.executedQty ?? '0') || 0,
    status: d.status,
  };
}

/** clientOrderId ile emri sorgular. Yoksa null (Binance -2013). */
export async function getOrderByClientId(symbol: string, clientOrderId: string): Promise<FillResult | null> {
  try {
    const d = await signed<RawOrder>('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId });
    return toFill(d);
  } catch (err) {
    if (err instanceof BinanceOrderError && err.code === -2013) return null; // "Order does not exist"
    throw err;
  }
}

/**
 * Piyasa girisi. qtyBase ZATEN stepSize'a yuvarlanmis olmali (quantizeEntry).
 *
 * IDEMPOTENSI: clientOrderId cagiran tarafindan verilir. Ag koparsa emrin borsaya
 * ULASIP ULASMADIGI bilinmez — kor tekrar CIFT POZISYON demektir. Bu yuzden belirsiz
 * hatada emir tekrarlanmaz, clientOrderId ile SORGULANIR: varsa dolum dondurulur,
 * yoksa hata yukari cikar.
 */
export async function placeMarketEntry(args: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qtyBase: number;
  clientOrderId: string;
}): Promise<FillResult> {
  const params = {
    symbol: args.symbol,
    side: args.side === 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: args.qtyBase,
    newClientOrderId: args.clientOrderId,
    newOrderRespType: 'RESULT',
  };

  try {
    return toFill(await signed<RawOrder>('POST', '/fapi/v1/order', params));
  } catch (err) {
    // Ag/zaman asimi: emir gitmis olabilir. SORGULA, tekrarlama.
    const ambiguous =
      err instanceof BinanceOrderError && (err.code === null || err.code === -1007 /* timeout */);
    if (!ambiguous) throw err;

    await sleep(1500);
    const existing = await getOrderByClientId(args.symbol, args.clientOrderId);
    if (existing) return existing;
    throw err;
  }
}

/**
 * Kosullu (TP/SL/trailing) emir. Once klasik /fapi/v1/order denenir; Binance bu emir
 * tipini o uctan kabul etmiyorsa Algo Order API'ye duser.
 *
 * Neden iki yol: sample'in yazari canli hesapta "Order type not supported for this
 * endpoint. Please use the Algo Order API endpoints instead." hatasini almis
 * (samplebackend/services/binance.ts:530) ve TAMAMEN algoOrder'a gecmis. Ama klasik uc
 * STOP_MARKET/TAKE_PROFIT_MARKET icin hala standart ve dokumante. Hangisinin gecerli
 * oldugu hesaba/ortama gore degistiginden ikisi de destekleniyor: once standart, hata
 * bunu soylerse algo.
 */
async function conditionalOrder(params: Record<string, string | number | boolean>): Promise<string> {
  try {
    const d = await signed<{ orderId: number }>('POST', '/fapi/v1/order', params);
    return String(d.orderId);
  } catch (err) {
    const useAlgo =
      err instanceof BinanceOrderError && /algo order api/i.test(err.message);
    if (!useAlgo) throw err;

    const d = await signed<{ algoId?: number; orderId?: number }>('POST', '/fapi/v1/algoOrder', {
      ...params,
      algoType: 'CONDITIONAL',
    });
    const id = d.algoId ?? d.orderId;
    if (id === undefined) throw new BinanceOrderError('algo emir id donmedi', null, '/fapi/v1/algoOrder');
    return String(id);
  }
}

/**
 * Koruyucu stop. closePosition=true: tetiklendiginde pozisyonun TAMAMINI kapatir.
 *
 * Sample bunun yerine sabit `quantity` + reduceOnly kullaniyordu (:319). Fark onemli:
 * pozisyon herhangi bir sebeple kismen kapanirsa (elle mudahale, kismi dolum), sabit
 * miktarli stop pozisyondan BUYUK kalir ve tetiklendiginde ters yonde yeni pozisyon
 * acabilir. closePosition bu sinifi tamamen ortadan kaldirir.
 */
export async function placeStopMarket(args: {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  triggerPrice: number;
}): Promise<string> {
  return conditionalOrder({
    symbol: args.symbol,
    side: args.positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: args.triggerPrice,
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  });
}

export async function placeTakeProfitMarket(args: {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  triggerPrice: number;
}): Promise<string> {
  return conditionalOrder({
    symbol: args.symbol,
    side: args.positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: args.triggerPrice,
    closePosition: 'true',
    workingType: 'MARK_PRICE',
  });
}

/**
 * Trailing stop. Simulator ile ayni anlam: activationPrice'a ULASILINCA devreye girer,
 * sonra zirveyi callbackRate% mesafeyle takip eder (simulator.ts:611 processTrailingCandle).
 *
 * closePosition trailing'de desteklenmez -> quantity + reduceOnly.
 */
export async function placeTrailingStop(args: {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  qtyBase: number;
  activationPrice: number;
  callbackRate: number;
}): Promise<string> {
  return conditionalOrder({
    symbol: args.symbol,
    side: args.positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'TRAILING_STOP_MARKET',
    quantity: args.qtyBase,
    activationPrice: args.activationPrice,
    // Binance limiti: 0.1 - 5, tek ondalik.
    callbackRate: Math.min(5, Math.max(0.1, parseFloat(args.callbackRate.toFixed(1)))),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
  });
}

/**
 * TEK bir emri iptal eder (breakeven'de eski stop'u kaldirmak icin).
 *
 * cancelAllOpenOrders BURADA KULLANILAMAZ: o, trailing stop'u da silerdi. Stop'u
 * breakeven'a tasirken trailing'e dokunmak, pozisyonun kar takibini sessizce kapatir.
 */
export async function cancelOrder(symbol: string, orderId: string): Promise<void> {
  try {
    await signed('DELETE', '/fapi/v1/order', { symbol, orderId });
    return;
  } catch (err) {
    // Klasik ucta yoksa algo emri olabilir (conditionalOrder algo'ya dusmus olabilir).
    const notFound = err instanceof BinanceOrderError && (err.code === -2011 || err.code === -2013);
    if (!notFound) throw err;
  }

  await signed('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: orderId });
}

/**
 * Sembolun TUM acik emirlerini iptal eder.
 *
 * Pozisyon kapandiginda geride kalan bacak (SL doldu -> TP hala acik) mutlaka
 * temizlenmeli: closePosition=true olan bir emir pozisyon yokken tetiklenirse borsa
 * onu bosa dusurur, ama emir defterinde birikmesi bir sonraki girisin stop'uyla
 * karisir. Mutabakatta her kapanan pozisyon icin cagrilir.
 */
export async function cancelAllOpenOrders(symbol: string): Promise<void> {
  try {
    await signed('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  } catch (err) {
    // -2011 "Unknown order sent" = zaten acik emir yok. Hata degil.
    if (err instanceof BinanceOrderError && err.code === -2011) return;
    throw err;
  }
}

/** Pozisyonu piyasa emriyle kapatir (SIGNAL_CHANGE: yon degisti). */
export async function closePositionMarket(args: {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  qtyBase: number;
  clientOrderId: string;
}): Promise<FillResult> {
  const params = {
    symbol: args.symbol,
    side: args.positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: args.qtyBase,
    reduceOnly: 'true',
    newClientOrderId: args.clientOrderId,
    newOrderRespType: 'RESULT',
  };
  return toFill(await signed<RawOrder>('POST', '/fapi/v1/order', params));
}

/**
 * Bir sembolde `since`'tan beri gerceklesen realize PnL toplami.
 *
 * Cooldown icin gerekli: simulator "yakin zamanda ayni sembol+yonde STOP yendi mi"
 * diye sorar (simulator.ts:263). Borsa bize "cikis sebebi" vermez, o yuzden sample'in
 * vekilini kullaniyoruz: zararla kapanan pozisyon = stop yenmis sayilir
 * (samplebackend/engine/executor.ts:278). Bu bir YAKLASIMDIR: TP'ye ulasmadan sinyal
 * degisimiyle zararla kapanan bir pozisyon da cooldown tetikler. Yon: fazladan bekleme
 * (muhafazakar), eksik bekleme degil.
 */
export async function getRealizedPnlSince(symbol: string, since: number): Promise<number> {
  const trades = await signed<Array<{ realizedPnl: string; commission: string; time: number }>>(
    'GET',
    '/fapi/v1/userTrades',
    { symbol, startTime: since, limit: 1000 },
  );
  return trades.reduce(
    (sum, t) => sum + (parseFloat(t.realizedPnl) || 0) - (parseFloat(t.commission) || 0),
    0,
  );
}

/** Baglanti + anahtar dogrulamasi. Emir gondermeden once cagrilir. */
export async function checkConnection(): Promise<void> {
  await axios.get(`${BASE}/fapi/v1/ping`, { timeout: 15_000 });
  await getAccountBalance(); // imza + anahtar gecerli mi
}

export const venue = { base: BASE, testnet: IS_TESTNET };
