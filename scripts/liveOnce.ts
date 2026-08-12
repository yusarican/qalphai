import { runLiveOnce } from '../src/engine/liveExecutor';
import { formatDecisionReport } from '../src/engine/liveReport';

/**
 * Sampiyonu bir kez canli (testnet) kosar: karar ver -> kapilardan gecir -> emir gonder.
 *
 *   npm run live:once                 # KURU KOSU — hicbir emir gitmez (varsayilan)
 *   npm run live:once -- --execute    # gercekten emir gonderir (testnet)
 *   npm run live:once -- --execute --allow-mainnet   # GERCEK PARA. Bilincli olmali.
 *
 * Varsayilanin kuru kosu olmasi kasitli: bu komutu ilk kez calistiran biri yanlislikla
 * emir gondermemeli. Emir gondermek icin fazladan bir kelime yazmak gerekir.
 *
 * ONCE PARITE: `npx tsx scripts/parity.ts` yesil yanmadan buradan tek emir bile
 * gonderilmemeli. Parite bozuksa canli motor backtest'in olctugu stratejiden BASKA bir
 * strateji kosuyordur — ve o zaman promosyon kapisindan gecen her sayi bir baska
 * strateji hakkindadir.
 */

const flag = (n: string) => process.argv.includes(`--${n}`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const execute = flag('execute');
  const dryRun = !execute;

  const balanceArg = arg('balance');
  const atArg = arg('at');

  /**
   * --at: gecmis bir karar barini yeniden oynat (yalniz kuru kosu).
   * "O gece motor ne yapardi?" sorusunun cevabi. Emirle birlestirilemez: gecmis bir
   * barin fiyatindan BUGUN pozisyon acmak, bilerek yanlis fiyattan islem yapmaktir.
   */
  if (atArg && execute) {
    throw new Error('--at yalnizca kuru kosuda kullanilir (gecmis bardan emir gonderilemez).');
  }

  const res = await runLiveOnce({
    dryRun,
    allowMainnet: flag('allow-mainnet'),
    force: flag('force'),
    at: atArg ? new Date(atArg).getTime() : undefined,
    fallbackBalance: balanceArg ? Number(balanceArg) : undefined,
  });

  const venue = res.testnet ? 'TESTNET' : 'MAINNET (GERCEK PARA)';
  const mode = dryRun ? 'KURU KOSU — emir gonderilmedi' : 'CANLI — emirler gonderildi';

  console.log(`\n  Ortam    : ${venue}`);
  console.log(`  Mod      : ${mode}`);

  // Kararin her asamasi (sembol -> tahsis/veto/bekle -> kapilar -> emir) tek raporda.
  // Scheduler ile AYNI bicimlendiriciyi kullanir: cron'da gordugun log ile elle kosuda
  // gordugun log ayrisirsa, birinde teshis edilen sorun otekinde gorunmez olur.
  console.log('');
  for (const line of formatDecisionReport(res)) console.log(`  ${line}`);
  console.log('');

  /**
   * Backtest'in aldigi bir pozisyonu borsa aldirmadiysa, bu kosu artik backtest'i
   * temsil etmiyor. Bir "skipped" satirinin arasinda kaybolmamali.
   */
  if (res.divergences.length > 0) {
    console.log('  ! BACKTEST ILE IRAKSAMA:');
    for (const d of res.divergences) {
      console.log(`    ${d.symbol} ${d.side} — ${d.reason}: backtest bu pozisyonu ALIRDI, borsa aldirmadi.`);
    }
    console.log(
      `\n    Margin butcesi: kullanilabilir $${res.availableMargin.toFixed(2)}.\n` +
        '    Simulator TOPLAM margin\'i hic kontrol etmez — siki ATR stop\'lari sabit dolar riskini\n' +
        '    buyuk bir notional\'a cevirir ve es zamanli pozisyonlar bakiyeyi asabilir.\n' +
        '    Bu kosunun sonuclari backtest ile KIYASLANAMAZ. Bakiye artir veya riskPerTradePct dusur.\n',
    );
  }

  if (dryRun && res.actions.some((a) => a.kind === 'OPENED')) {
    console.log('  Bunlari gercekten gondermek icin: npm run live:once -- --execute\n');
  }
}

main().catch((err) => {
  console.error(`\nHATA: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
