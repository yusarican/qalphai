import { EXCHANGE_ONLY_SKIPS, type SkipReason } from './livePlan';
import type { LiveAction, LiveRunResult } from './liveExecutor';

/**
 * KARAR RAPORU — "neden islem acilmadi?" sorusunun TEK cevabi.
 *
 * Bu dosya yalnizca bicimlendirir; hicbir sey hesaplamaz. Var olma sebebi su: canli kosu
 * "0 tahsis, 0 pozisyon" diye loglandiginda BIRBIRINDEN TAMAMEN FARKLI dort durum ayni
 * satira duser ve teshis imkansiz hale gelir:
 *
 *   1. Hicbir sembol degerlendirilmedi (operator hepsini kapatmis — portfolio.json).
 *   2. Strateji cagrildi, her sembolde "bekle" dedi (sinyal yok — normal, saglikli).
 *   3. Strateji sinyal uretti ama kendi VETO kurallari kesti (rejections).
 *   4. Tahsis olustu ama YURUTME kapilari atladi (RISK_CAP / COOLDOWN / MIN_NOTIONAL...).
 *
 * (1) bir yapilandirma hatasi, (2) beklenen davranis, (3) strateji mantigi, (4) risk ya da
 * borsa kisiti. Dordu de "islem acmadi" gorunur ve dordu de BASKA bir mudahale ister.
 * O yuzden her asama ayri ayri sayilir ve sebebiyle birlikte yazilir.
 *
 * Boru hattinin sirasi loglarda da AYNI okunur:
 *   semboller -> strateji karari (tahsis | veto | bekle) -> yurutme kapilari -> emirler
 */

/** Yurutme kapilarinin insan diline cevrilmis hali. Kod sabiti degil, OPERATOR ICIN. */
const SKIP_NOTE: Record<SkipReason, string> = {
  MIN_CONF: 'confidence esigin altinda',
  COOLDOWN: 'cooldown suruyor (yakin zamanda ayni yonde cikis oldu)',
  RISK_CAP: 'portfoy risk tavani dolu',
  MIN_MARGIN: 'gereken margin minimumun altinda',
  NO_ATR_SIZING: 'ATR/fiyat yok — pozisyon buyuklugu hesaplanamaz',
  ALREADY_OPEN: 'ayni yonde pozisyon zaten acik (piramit yok)',
  MIN_NOTIONAL: 'borsanin minimum emir buyuklugu altinda',
  UNMANAGED_POSITION: 'bu sembolde defterde olmayan pozisyon var — dokunulmadi',
  INSUFFICIENT_MARGIN: 'kullanilabilir margin yetmedi',
};

const note = (reason: string | undefined): string =>
  (reason && SKIP_NOTE[reason as SkipReason]) ?? reason ?? '';

/**
 * Bir canli kosuyu satirlara cevirir. Cagiran taraf istedigi gibi yazar (console, dosya,
 * panel) — bu yuzden string[] doner, kendisi log ATMAZ.
 */
export function formatDecisionReport(res: LiveRunResult): string[] {
  const out: string[] = [];
  const dry = res.dryRun ? ' (KURU KOSU — emir gonderilmedi)' : '';

  out.push(
    `${new Date(res.decisionBar).toISOString()} — ${res.champion}${dry}`,
    `  bakiye $${res.balance.toFixed(2)} | kullanilabilir margin $${res.availableMargin.toFixed(2)}`,
  );

  /**
   * BOSLUK, "hic islem acmiyor" sikayetinin en sinsi sebebidir: motor kapaliyken kapanan
   * mumlarin karar noktalari HIC degerlendirilmez. Ekranda yalnizca en son bar gorunur,
   * o barda sinyal yoktur ve strateji bozuk sanilir — oysa sinyal kacirilan barda vardi.
   * Bu yuzden en uste, tahsislerin bile ustune yazilir.
   */
  if (res.skippedBars > 0) {
    out.push(
      `  [!] BOSLUK: ${res.skippedBars} karar bari hic degerlendirilmedi (motor o sirada kapaliydi).`,
      '      O barlardaki sinyaller GECMISTE KALDI — girisleri sonradan almak yanlis fiyattan',
      '      islem acmak olur. Bu kosu backtest ile kiyaslanabilirligini o barlar kadar kaybetti.',
    );
  }

  // --- 1) EVREN. Bos ise digerlerini okumanin anlami yok: karar hic sorulmadi.
  if (res.symbols.length === 0) {
    out.push(
      '  SEMBOL YOK — hicbir sembol degerlendirilmedi.',
      `    Sampiyonun evreni ${res.disabled.length} sembolden olusuyor ve HEPSI panelden kapatilmis`,
      '    (data/portfolio.json: disabled). Islem acilmasi icin en az biri acilmali.',
    );
    return out;
  }

  const dis = res.disabled.length > 0 ? `, kapali ${res.disabled.length} (${res.disabled.join(', ')})` : '';
  out.push(`  sembol: ${res.symbols.length} degerlendirildi${dis}`);

  // --- 2) STRATEJI KARARI.
  out.push(
    `  KARAR: ${res.allocations.length} tahsis, ${res.rejections.length} red, ` +
      `${res.noSignal.length} sinyal yok`,
  );

  for (const a of res.allocations) {
    out.push(
      `    tahsis  ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} conf ${a.confidence.toFixed(2)}  ` +
        `${a.leverage}x  %${a.allocationPercent}` + (a.reason ? `  — ${a.reason}` : ''),
    );
  }

  // Red = stratejinin kendi veto kurali VEYA harness redleri. Kural adi kritik: strateji
  // hep ayni kuralda kesiyorsa sorun stratejinin esiklerindedir, motorda degil.
  for (const r of res.rejections) {
    out.push(
      `    red     ${r.symbol.padEnd(10)} ${(r.side ?? '-').padEnd(5)} ${r.rule}` +
        (r.confidence !== undefined ? ` (conf ${r.confidence.toFixed(2)})` : '') +
        (r.note ? ` — ${r.note}` : ''),
    );
  }

  if (res.noSignal.length > 0) {
    out.push(`    bekle   ${res.noSignal.join(', ')}`);
  }

  // --- 3) YURUTME. Tahsis yoksa plan asamasi zaten bostur; sahte bir satir yazma.
  if (res.allocations.length === 0) {
    out.push('  SONUC: tahsis yok -> pozisyon acilmadi.');
    return out;
  }

  const byKind = (k: LiveAction['kind']) => res.actions.filter((a) => a.kind === k);
  const opened = byKind('OPENED');
  const skipped = byKind('SKIPPED');
  const failed = byKind('FAILED');
  const closed = byKind('CLOSED');
  const be = byKind('BREAKEVEN');

  out.push(
    `  YURUTME: ${opened.length} acildi, ${skipped.length} atlandi, ${failed.length} hata, ` +
      `${closed.length} kapandi, ${be.length} breakeven`,
  );

  for (const a of opened) {
    out.push(
      `    ACILDI  ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} qty ${a.qtyBase} ` +
        `margin $${a.margin?.toFixed(2)} ${a.leverage}x giris $${a.entryFill?.toFixed(4)} ` +
        `stop $${a.stopPrice?.toFixed(4)} risk $${a.riskUSD?.toFixed(2)}`,
    );
  }

  /**
   * ATLANDI, "0 pozisyon"un en sik ve en yaniltici sebebidir: strateji sinyali URETTI,
   * tahsis OLUSTU, ama bir kapi kesti. Kapinin adi yazilmazsa operator stratejide hata
   * arar — oysa sorun risk butcesi ya da bakiye olabilir.
   */
  for (const a of skipped) {
    const diverged = EXCHANGE_ONLY_SKIPS.includes(a.reason as SkipReason);
    out.push(
      `    ATLANDI ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} ${a.reason} — ${note(a.reason)}` +
        (diverged ? '  [!] backtest bu pozisyonu ALIRDI' : ''),
    );
  }

  for (const a of failed) {
    out.push(`    HATA    ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} ${a.reason ?? ''}`);
  }
  for (const a of closed) {
    out.push(`    KAPANDI ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} ${a.reason ?? ''}`);
  }
  for (const a of be) {
    out.push(`    BE      ${a.symbol.padEnd(10)} ${a.side.padEnd(5)} ${a.reason ?? ''}`);
  }

  for (const s of res.unmanaged) {
    out.push(`    YONETILMEYEN POZISYON: ${s} — dokunulmadi, elle kontrol et`);
  }

  out.push(`  SONUC: ${opened.length} pozisyon${res.dryRun ? ' (KURU KOSU)' : ''}`);
  return out;
}
