import 'dotenv/config';

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Zorunlu env degiskeni eksik: ${key}`);
  }
  return v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} sayi olmali, geldi: ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function list(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export type CandleInterval = '1h' | '4h' | '1d';

export const env = {
  port: num('PORT', 3001),
  nodeEnv: str('NODE_ENV', 'development'),
  frontendUrl: str('FRONTEND_URL', 'http://localhost:3000'),

  binance: {
    testnet: bool('BINANCE_TESTNET', true),
    apiKey: str('BINANCE_API_KEY', ''),
    apiSecret: str('BINANCE_API_SECRET', ''),
  },

  live: {
    /**
     * Canli execution zamanlayicisi. Her MUM KAPANISINDA kosar — gunde bir kez degil.
     *
     * Neden mum basina: breakeven'i borsa degil BIZ tasiyoruz (Binance'te "+1R'a gelince
     * stop'u girise cek" diye bir emir tipi yok) ve simulator bunu her mumda kontrol eder.
     * Gunde bir kez kossaydik 4h'lik alti mumun besinde breakeven kacar, canli pozisyonlar
     * backtest'in modelledigi korumadan YOKSUN kalirdi.
     *
     * enabled=false: zamanlayici yine kosar ama KURU — ne yapacagini loglar, emir gondermez.
     * Emir gondermek bilincli bir tercih olmali: LIVE_TRADING=true.
     */
    enabled: bool('LIVE_TRADING', false),
  },

  /**
   * Makale secen model (OpenAI-uyumlu route). Codex'ten AYRI tutulur: biri kod yazar,
   * digeri gunde ~300 abstract okuyup eleme yapar. Ikincisi ucuz ve genis baglamli
   * olmali; ayni modeli iki ise kosmak, secim asamasini gereksiz pahalilastirir.
   *
   * baseUrl bos ise LLM secici DEVRE DISI kalir ve gece deterministik siralayiciya
   * duser — sistem modelsiz de kosar, sadece daha kor kosar. (Kapatma anahtari adres,
   * apiKey degil: proxy anahtarsiz da cevap veriyor.)
   */
  llm: {
    baseUrl: str('LLM_BASE_URL', 'https://api.interneteco.systems/v1'),
    apiKey: str('LLM_API_KEY', ''),
    model: str('LLM_MODEL', 'gemini-3.6-flash'),
    timeoutMs: num('LLM_TIMEOUT_MS', 120_000),
    /** Bir gecede LLM'e okutulacak makale tavani (maliyet freni). */
    maxPapers: num('LLM_MAX_PAPERS', 240),
  },

  /**
   * MAIN ORCHESTRATOR — sistemin tamamini goren ust akil.
   *
   * Makale secicisinden (env.llm) ve Codex'ten (env.codex) AYRI tutulur, cunku isi
   * baskadir: biri abstract eler, digeri kod yazar, bu ise KARAR verir — canliyi ve
   * kutuphaneyi okur, otopsi yapar, gece arastirmasina yon verir. Tool cagirabilen bir
   * modele ihtiyaci var; env.llm'in istemcisi (lib/llm.ts) tool desteklemiyor.
   *
   * VARSAYILAN KAPALI. `enabled=false` veya `apiKey` bos oldugunda orchestrator hic
   * kurulmaz ve sistemin geri kalani bugunku davranisini BIT BIT korur — env.llm'in
   * `llmConfigured()` deseninin aynisi (lib/llm.ts:75).
   */
  orchestrator: {
    enabled: bool('ORCH_ENABLED', false),
    provider: str('ORCH_PROVIDER', 'anthropic') as 'anthropic' | 'openai' | 'gemini',
    model: str('ORCH_MODEL', 'claude-opus-5'),
    /** Bos ise saglayicinin varsayilan adresi kullanilir (bkz. lib/providers/). */
    baseUrl: str('ORCH_BASE_URL', ''),
    apiKey: str('ORCH_API_KEY', ''),
    timeoutMs: num('ORCH_TIMEOUT_MS', 300_000),
    maxTokens: num('ORCH_MAX_TOKENS', 16_384),
    /**
     * Tek kosuda azami tool turu. Agent dongusu bir hedefe kilitlenip ayni tool'u
     * tekrarlayabilir; bu fren, sonsuz donguyu BUTCE degil ADIM cinsinden keser.
     */
    maxSteps: num('ORCH_MAX_STEPS', 40),
    /**
     * Tek kosuda azami AGIR backtest. Bir grid kosusu dakikalar suruyor (backtest.ts:36);
     * frensiz bir agent bir gecede CPU'yu tumuyle yiyebilir.
     */
    maxBacktests: num('ORCH_MAX_BACKTESTS', 6),
    /** Kosu basina token freni (giris + cikis toplami). */
    tokenBudget: num('ORCH_TOKEN_BUDGET', 2_000_000),
    /** Gece dongusunden ONCE: o gecenin arastirmasina yon verecek zaman. */
    preCron: str('ORCH_PRE_CRON', '0 1 * * *'),
    /** Gece dongusunden SONRA: adayi ve raporu okuyup otopsi/varyant uretir. */
    postCron: str('ORCH_POST_CRON', '30 6 * * *'),
    /** Bos = web arama tool'u HIC kaydedilmez. */
    webSearchProvider: str('ORCH_WEB_SEARCH_PROVIDER', '') as '' | 'brave' | 'tavily' | 'exa',
    webSearchKey: str('ORCH_WEB_SEARCH_KEY', ''),
  },

  codex: {
    model: str('CODEX_MODEL', 'gpt-5.6-sol'),
    reasoningEffort: str('CODEX_REASONING_EFFORT', 'high') as 'low' | 'medium' | 'high',
    // 30 dk. Ilk kosuda 15 dk yetmedi: REFINE fallback'i AYNI thread'de IKINCI tur olarak
    // calisir (once makale okunur, uygulanamaz denir, sonra sampiyon gelistirilir) ve
    // high-effort reasoning ile bu, tek turluk butceyi asiyor.
    turnTimeoutMs: num('CODEX_TURN_TIMEOUT_MS', 1_800_000),
  },

  mail: {
    smtpUser: str('SMTP_USER', ''),
    smtpPass: str('SMTP_PASS', ''),
    to: str('NOTIFICATION_EMAIL', ''),
    fromName: str('NOTIFICATION_FROM_NAME', 'TradeCraft AI'),
  },

  nightly: {
    symbols: list('SYMBOLS', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']),
    interval: str('CANDLE_INTERVAL', '4h') as CandleInterval,
    backtestDays: num('BACKTEST_DAYS', 540),
    /**
     * Secim yolundaki HICBIR kodun goremedigi holdout penceresi ("kasa").
     * Backtest/sweep/scoring bu araligi keser; ona dokunan tek yer promosyon kapisidir.
     */
    holdoutDays: num('HOLDOUT_DAYS', 90),
    cron: str('NIGHTLY_CRON', '30 2 * * *'),
  },
} as const;

/** Veri dosyalarinin koku (repo koku altinda, gitignore'lu). */
export const DATA_DIR = 'data';
export const REPORTS_DIR = 'reports';
export const STRATEGIES_DIR = 'strategies';
export const CODEX_WORK_DIR = '.codex-work';
