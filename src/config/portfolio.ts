import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env';

/**
 * OPERATOR PORTFOYU — "sampiyon hangi sembollerde canliya cikabilir?"
 *
 * Sampiyonun sembol listesi (champion.json:symbols) BACKTEST'IN OLCTUGU evrendir; o liste
 * stratejinin sinavini verdigi kumedir ve buradan DEGISTIRILEMEZ. Bu dosya yalnizca o
 * kumeyi DARALTIR: operator bir sembolu kapatabilir, ama sampiyonun hic gormedigi bir
 * sembolu ACAMAZ.
 *
 * Neden tek yonlu: sembol EKLEMEK, walk-forward'un, kasanin ve promosyon kapisinin hicbir
 * sey soylemedigi bir sembolde para riske etmek demektir — yani panelden, sinavi verilmemis
 * bir strateji kosturmak. Daraltmak ise her zaman guvenli tarafta: alinmayan pozisyon
 * kimseyi iflas ettirmez.
 *
 * Dosya yoksa: HERSEY ACIK (varsayilan davranis degismez).
 */

const FILE = path.join(DATA_DIR, 'portfolio.json');

export interface PortfolioConfig {
  /** Kapatilan semboller. Whitelist degil BLACKLIST — yeni sampiyon yeni sembol
   *  getirdiginde sessizce kapali kalmasin, varsayilan olarak acik gelsin. */
  disabled: string[];
  updatedAt: number;
}

const EMPTY: PortfolioConfig = { disabled: [], updatedAt: 0 };

export function readPortfolio(): PortfolioConfig {
  if (!fs.existsSync(FILE)) return { ...EMPTY };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<PortfolioConfig>;
    return {
      disabled: Array.isArray(raw.disabled) ? raw.disabled.map(String) : [],
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch {
    // Bozuk dosya sessizce "hersey kapali" anlamina GELMEZ — o, farkinda olmadan
    // motoru durdurmak olurdu. Varsayilana don.
    return { ...EMPTY };
  }
}

export function writePortfolio(disabled: string[]): PortfolioConfig {
  const cfg: PortfolioConfig = {
    disabled: [...new Set(disabled.map((s) => s.trim().toUpperCase()).filter(Boolean))],
    updatedAt: Date.now(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/**
 * Sampiyonun evreninden operatorun kapattiklarini duser.
 *
 * Bos kume dondurebilir — bu bir hata degil, "hicbir sembolde islem acma" demektir ve
 * operator bunu bilincli olarak secebilir. Cagiran taraf bunu sessizce gecmemeli, ama
 * duzeltmemeli de.
 */
export function resolveLiveSymbols(championSymbols: readonly string[]): string[] {
  const off = new Set(readPortfolio().disabled);
  return championSymbols.filter((s) => !off.has(s));
}
