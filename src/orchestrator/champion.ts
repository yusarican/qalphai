import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STRATEGIES_DIR } from '../config/env';
import type { RiskParams } from '../engine/riskManagement';
import type { CostConfig } from '../engine/costModel';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';

/**
 * Sampiyon kaydi — canliya cikan tek strateji.
 *
 * Kod DISKTE IMMUTABLE: strategies/champions/<id>@<v>/strategy.ts. Kayitta sha256 tutulur
 * ve executor yuklemeden ONCE dogrular. Uyusmazsa ISLEM YAPMAYI REDDEDER.
 *
 * Neden bu kadar sert: canli executor'un yukledigi kod ile backtest'i gecen kod ayni
 * degilse, sistemin urettigi her sayi (walk-forward, kasa, promosyon gerekceleri) bir
 * baska kod hakkindadir. Dosya elle duzenlenirse, yanlislikla uzerine yazilirsa veya
 * bir deploy yarim kalirsa — sha tutmaz ve sistem GURULTULU sekilde durur, sessizce
 * yanlis stratejiyle para yonetmez.
 */

export interface ChampionRecord {
  strategyId: string;
  version: number;
  name: string;
  author: 'human' | 'codex';

  /** strategies/champions/<id>@<v>/strategy.ts — degistirilemez. */
  codePath: string;
  codeSha256: string;

  params: Record<string, number | boolean>;
  risk: RiskParams;
  symbols: string[];
  interval: CandleInterval;
  profile: StrategyProfile;
  costConfig: CostConfig;

  promotedAt: number;
  promotedFromRunId: string;
  provenance?: { arxivId?: string; arxivTitle?: string; hypothesis?: string };

  /**
   * Bu kayit nasil olustu?
   *
   *   'gate'     — promosyon kapisi onayladi (gece dongusu).
   *   'operator' — panelden ELLE secildi; kapi calistirilmadi veya hukmu bypass edildi.
   *
   * Alan opsiyonel cunku bu ayrim eklenmeden once yazilmis kayitlar var; okurken
   * 'gate' varsayilir (o donemde elle secim yoktu, dolayisiyla dogru varsayim).
   */
  activatedBy?: 'gate' | 'operator';

  /**
   * Kapinin bu model hakkindaki SON hukmu — elle secimde de saklanir.
   *
   * Elle secim kapiyi bypass eder, ama hukmu SILMEZ: "operator kapiyi gecemeyen bir
   * modeli bilerek secti" ile "kapi bu modeli onayladi" ayri seylerdir ve denetim izinde
   * ayri gorunmelidir.
   */
  gate?: { promote: boolean; blockers: string[]; warnings: string[]; incumbentQualified: boolean | null };

  evaluation: {
    verdict: string;
    testPnlPct: number;
    testMar: number;
    testMaxDDPct: number;
    testTrades: number;
    windowsPositive: number;
    windowCount: number;
    stressPnlPct: number;
    holdoutPnlPct: number;
    holdoutMaxDDPct: number;
    qualifiedNeighbors: number;
    feeShareOfGross: number;
  };

  /** Canli (testnet) islem acik mi. */
  live: { enabled: boolean; startedAt: number };
}

const CURRENT = path.join(STRATEGIES_DIR, 'champion.json');
const HISTORY_DIR = path.join(STRATEGIES_DIR, 'history');

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function readChampion(): ChampionRecord | null {
  if (!fs.existsSync(CURRENT)) return null;
  return JSON.parse(fs.readFileSync(CURRENT, 'utf8')) as ChampionRecord;
}

/**
 * Sampiyonun kodunu yukler ve sha'yi DOGRULAR.
 * Uyusmazsa firlatir — cagiran taraf islem yapmayi reddetmelidir.
 */
export function loadChampionSource(rec: ChampionRecord): string {
  if (!fs.existsSync(rec.codePath)) {
    throw new Error(`Sampiyon kodu bulunamadi: ${rec.codePath}`);
  }
  const source = fs.readFileSync(rec.codePath, 'utf8');
  const actual = sha256(source);
  if (actual !== rec.codeSha256) {
    throw new Error(
      `SAMPIYON KODU DEGISMIS. Beklenen sha ${rec.codeSha256.slice(0, 12)}, bulunan ${actual.slice(0, 12)}.\n` +
        `Backtest'i gecen kod ile diskteki kod ayni degil — islem yapilmayacak.\n` +
        `Dosya: ${rec.codePath}`,
    );
  }
  return source;
}

export interface PromoteArgs {
  source: string;
  record: Omit<ChampionRecord, 'codePath' | 'codeSha256' | 'promotedAt'>;
}

/** Yeni sampiyonu yazar. Kod immutable bir dizine kopyalanir, eskisi tarihe eklenir. */
export function promoteChampion(args: PromoteArgs): ChampionRecord {
  const dir = path.join(STRATEGIES_DIR, 'champions', `${args.record.strategyId}@${args.record.version}`);
  fs.mkdirSync(dir, { recursive: true });

  const codePath = path.join(dir, 'strategy.ts');
  fs.writeFileSync(codePath, args.source);

  const rec: ChampionRecord = {
    ...args.record,
    codePath,
    codeSha256: sha256(args.source),
    promotedAt: Date.now(),
  };

  // Onceki sampiyonu tarihe al — rollback bir dosya kopyalamasidir.
  const prev = readChampion();
  if (prev) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(HISTORY_DIR, `${prev.promotedAt}.json`), JSON.stringify(prev, null, 2));
  }

  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  fs.writeFileSync(CURRENT, JSON.stringify(rec, null, 2));
  return rec;
}

/** Onceki sampiyona geri don. */
export function rollbackChampion(): ChampionRecord | null {
  if (!fs.existsSync(HISTORY_DIR)) return null;

  const files = fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => Number(b.replace('.json', '')) - Number(a.replace('.json', '')));

  const latest = files[0];
  if (!latest) return null;

  const rec = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, latest), 'utf8')) as ChampionRecord;
  fs.writeFileSync(CURRENT, JSON.stringify(rec, null, 2));
  fs.rmSync(path.join(HISTORY_DIR, latest));
  return rec;
}
