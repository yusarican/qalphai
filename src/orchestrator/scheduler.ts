import cron from 'node-cron';
import { runNightly } from './nightly';
import { runLiveOnce } from '../engine/liveExecutor';
import { currentDecisionBar } from '../engine/liveDecider';
import { formatDecisionReport } from '../engine/liveReport';
import { INTERVAL_MS } from '../lib/klineStore';
import { readLastDecisionBar } from '../lib/liveState';
import { env, type CandleInterval } from '../config/env';

/**
 * Gece dongusunun zamanlayicisi.
 *
 * UTC'ye sabitlenmis: mumlar Binance'te UTC sinirlarinda kapanir. Yerel saat kullanmak,
 * yaz saati gecislerinde gecenin bir mum kaymasiyla kosmasi demektir — ve bu, aylar sonra
 * "neden o hafta sonuclar tuhaf?" diye aranan turden bir hatadir.
 *
 * Varsayilan 02:30 UTC: gunluk mum kapandi, funding settle oldu, veri oturdu.
 */

let running = false;

export function startScheduler(): void {
  cron.schedule(
    env.nightly.cron,
    () => {
      // Yeniden giris kilidi: bir gece 24 saatten uzun surerse (buyuk grid, yavas Codex)
      // ikinci bir kosu baslamasin — ayni sampiyon dosyasina iki surec yazamaz.
      if (running) {
        console.warn('[gece] onceki kosu hala devam ediyor, bu tetikleme atlandi');
        return;
      }
      running = true;
      void runNightly()
        .catch((err) => {
          console.error('[gece] HATA:', err instanceof Error ? err.message : err);
          console.error('[gece] Sampiyona dokunulmadi.');
        })
        .finally(() => {
          running = false;
        });
    },
    { timezone: 'Etc/UTC' },
  );

  console.log(`[gece] zamanlandi: ${env.nightly.cron} (UTC)`);
}

/**
 * Mum kapanislarindan 1 dk sonra. Binance'in kapanan mumu servis etmesi icin pay birakir;
 * karar barinin kendisi (`at`) yine tam mum siniridir, yani bu gecikme stratejinin
 * gordugu veriyi DEGISTIRMEZ — yalnizca hazir olmasini bekler.
 */
const LIVE_CRON: Record<CandleInterval, string> = {
  '1h': '1 * * * *',
  '4h': '1 */4 * * *',
  '1d': '1 0 * * *',
};

let liveRunning = false;

/** Acilis yakalamasinin en erken bekleyecegi sure — surec daha yeni ayaga kalkti. */
const BOOT_CATCHUP_DELAY_MS = 5_000;

/** Cron ile ayni pay: Binance kapanan mumu servis edene kadar bekle. */
const BAR_SETTLE_MS = 60_000;

/**
 * CANLI EXECUTION ZAMANLAYICISI — her mum kapanisinda.
 *
 * LIVE_TRADING=false (varsayilan) iken de kosar, ama KURU: ne yapacagini loglar, emir
 * gondermez. Boylece motor gunlerce izlenebilir ve "acacagi pozisyonlar makul mu"
 * sorusu, tek kurus riske edilmeden cevaplanir.
 */
export function startLiveScheduler(): void {
  const interval = env.nightly.interval;
  const expr = LIVE_CRON[interval];

  cron.schedule(expr, () => runLiveTick('mum kapanisi'), { timezone: 'Etc/UTC' });

  const mode = env.live.enabled ? 'EMIR GONDERIR' : 'KURU KOSU (LIVE_TRADING=false)';
  console.log(`[canli] zamanlandi: ${expr} (UTC, ${interval} mum kapanisi) — ${mode}`);

  catchUpOnBoot(interval);
}

/**
 * ACILIS YAKALAMASI — cron tek basina YETMEZ.
 *
 * cron yalnizca surec AYAKTAYKEN gelen mum kapanislarini gorur. Surec 4h'lik bir mumun
 * ortasinda ayaga kalkarsa (deploy, restart, cokme, laptop uykusu) motor bir sonraki
 * tetiklemeye kadar — 4 saate kadar — GORME OZURLUDUR: o pencerede kapanan bar hic
 * degerlendirilmez ve `lastDecisionBar` defterde durdugu halde kimse ona bakmaz.
 *
 * Bu, "model hic tradeye girmiyor"un sessiz sebebidir: panelde yalnizca en son kosu
 * gorunur, o barda sinyal yoktur ve strateji bozuk sanilir.
 *
 * Yakalama YALNIZCA GUNCEL bari kosar, gecmis barlari YENIDEN OYNATMAZ. Kacirilan bir
 * barin girisini bugunku fiyattan almak, backtest'in olctugu stratejiyi kosmak degildir
 * (scripts/liveOnce.ts `--at` ile `--execute`i ayni sebeple yasaklar). Kacirilan barlar
 * geri getirilemez; yapilabilecek tek durust sey onlari SAYIP raporlamaktir.
 */
function catchUpOnBoot(interval: CandleInterval): void {
  const bar = currentDecisionBar(interval);
  const last = readLastDecisionBar();

  if (last >= bar) {
    console.log('[canli] acilis: guncel bar zaten islenmis, yakalama gerekmiyor');
    return;
  }

  if (last > 0) {
    const missed = Math.max(0, Math.round((bar - last) / INTERVAL_MS[interval]) - 1);
    if (missed > 0) {
      console.warn(
        `[canli] acilis: ${missed} karar bari motor kapaliyken kapandi ` +
          `(son islenen ${new Date(last).toISOString()}). O barlarin sinyalleri KACIRILDI.`,
      );
    }
  }

  // Bar yeni kapandiysa cron ile ayni payi bekle: Binance kapanan mumu birkac saniye
  // gecikmeyle servis eder ve eksik mumla karar vermek sessizce yanlis karar vermektir.
  const delay = Math.max(BOOT_CATCHUP_DELAY_MS, bar + BAR_SETTLE_MS - Date.now());
  console.log(
    `[canli] acilis: ${new Date(bar).toISOString()} bari icin yakalama kosusu ` +
      `${Math.round(delay / 1000)} sn sonra`,
  );

  setTimeout(() => runLiveTick('acilis yakalamasi'), delay);
}

/**
 * Tek bir canli kosu — cron da acilis yakalamasi da BURADAN gecer.
 *
 * Tek giris noktasi olmasi `liveRunning` kilidini anlamli kilar: iki farkli tetikleyici
 * kendi kilidini tutsaydi, acilis yakalamasi ile mum kapanisi cakisip AYNI karar barinda
 * iki kez emir gonderebilirdi.
 */
function runLiveTick(trigger: string): void {
  // Yeniden giris kilidi: bir kosu bir sonraki mumu asarsa ikinci bir surec AYNI
  // karar barinda ikinci kez emir gondermeye kalkmasin.
  if (liveRunning) {
    console.warn(`[canli] onceki kosu hala devam ediyor, ${trigger} tetiklemesi atlandi`);
    return;
  }
  liveRunning = true;

  void runLiveOnce({ dryRun: !env.live.enabled })
    .then((res) => {
      // Kararin TAMAMI loglanir — tahsis, veto, bekleyen sembol, atlanan kapi. "0
      // pozisyon" tek basina bir tesbit degildir: sebebi yazilmazsa saglikli bir
      // "sinyal yok" ile bozuk bir yapilandirma ayni gorunur.
      console.log(`[canli] tetikleyici: ${trigger}`);
      for (const line of formatDecisionReport(res)) console.log(`[canli] ${line}`);

      // Backtest'in aldigi ama borsanin aldirmadigi pozisyon: bu kosu artik
      // backtest'i temsil etmiyor. Rapor satirlarinin arasinda kaybolmamali.
      for (const d of res.divergences) {
        console.warn(`[canli] IRAKSAMA: ${d.symbol} ${d.side} — ${d.reason} (backtest bunu ALIRDI)`);
      }
    })
    .catch((err) => {
      // Canli kosu duserse SAMPIYONA VE DEFTERE DOKUNULMAZ. Bir sonraki mumda
      // mutabakat zaten borsayi tekrar okuyup defteri duzeltecek.
      console.error('[canli] HATA:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      liveRunning = false;
    });
}
