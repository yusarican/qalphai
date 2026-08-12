import cron from 'node-cron';
import { runNightly } from './nightly';
import { runLiveOnce } from '../engine/liveExecutor';
import { formatDecisionReport } from '../engine/liveReport';
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

  cron.schedule(
    expr,
    () => {
      // Yeniden giris kilidi: bir kosu bir sonraki mumu asarsa ikinci bir surec AYNI
      // karar barinda ikinci kez emir gondermeye kalkmasin.
      if (liveRunning) {
        console.warn('[canli] onceki kosu hala devam ediyor, bu tetikleme atlandi');
        return;
      }
      liveRunning = true;

      void runLiveOnce({ dryRun: !env.live.enabled })
        .then((res) => {
          // Kararin TAMAMI loglanir — tahsis, veto, bekleyen sembol, atlanan kapi. "0
          // pozisyon" tek basina bir tesbit degildir: sebebi yazilmazsa saglikli bir
          // "sinyal yok" ile bozuk bir yapilandirma ayni gorunur.
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
    },
    { timezone: 'Etc/UTC' },
  );

  const mode = env.live.enabled ? 'EMIR GONDERIR' : 'KURU KOSU (LIVE_TRADING=false)';
  console.log(`[canli] zamanlandi: ${expr} (UTC, ${interval} mum kapanisi) — ${mode}`);
}
