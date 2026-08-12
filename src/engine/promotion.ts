import type { BacktestResults, WalkForwardVerdict } from '../lib/types';
import { MAX_DRAWDOWN_PCT, requiredPositiveWindows } from './riskLimits';
import { deriveVerdict } from './walkForward';

/**
 * PROMOSYON KAPISI.
 *
 * Bu sistemin varolussal riski bug degil, COKLU TEST (multiple testing). 365 gece x
 * ~1700 grid hucresi ~= 620.000 deneme, TEK bir fiyat gecmisine karsi. Bu olcekte,
 * tamamen rastgele bir strateji ureteci bile er ya da gec "muhtesem" gorunen bir hucre
 * bulur. Sorun Codex'in kotu strateji yazmasi degil — sorun, yeterince cok denersen
 * SANSIN bilgi gibi gorunmesi.
 *
 * Kapinin isi iyi stratejileri bulmak degil; SANSI ELEMEK.
 *
 * ---------------------------------------------------------------------------
 * TASARIM (bu dosya bir kez bastan yazildi — eski surumun uc yapisal hatasi vardi)
 * ---------------------------------------------------------------------------
 *
 * 1. GECILEMEZ SART. Eski kapi "kazanan hucrenin en fazla 6 diskalifiye komsusu olsun"
 *    diyordu. 6 eksenli bir gridde komsuluk 63-485 hucredir; grid'in %95'i elenirken
 *    ≤6 sarti ARITMETIK OLARAK saglanamaz. Bu, sabit bir "her zaman reddet" idi ve
 *    reddin gercek sebebini de gizliyordu. Cozum: mutlak sayi degil, ORAN — kazanan
 *    hucrenin komsulugu, GRID GENELINDEN belirgin olcude temiz olmali. Bu olcu grid'in
 *    sekline ve eksen sayisina bagli degildir.
 *
 * 2. OLU SARTLAR. Ayni olcu iki farkli esikle iki kez soruluyordu (pencere istikrari
 *    %75 ve %60; drawdown %40 ve %25). Bir cift esikte daima siki olan baglar; gevsek
 *    olan hicbir zaman tek basina tetiklenemez, yani test edilemez ve guven verir
 *    gorunup hicbir sey yapmaz. Simdi her olcu TEK yerde, tek esikle sorulur
 *    (bkz. riskLimits.ts).
 *
 * 3. ASIMETRI. Sampiyon kendi kapisindan hic gecmiyordu. Aday dokuz sarti saglamak
 *    zorundayken, mevcut sampiyon hicbirini saglamak zorunda degildi — sinavini hic
 *    vermemis bir strateji, gecilemez bir sart sayesinde olumsuz hale geliyordu.
 *    Simdi ayni "tek basina gecerlilik" seti IKISINE de uygulanir: sampiyon bugun
 *    kendi kapisindan gecemiyorsa bu `incumbentQualified: false` olarak raporlanir.
 *    Kapi yine de otomatik olarak sampiyonu indirmez — bu operatorun karari — ama
 *    artik sessiz kalmaz.
 *
 * En kritik sart hala KASA: secim yolundaki hicbir kodun gormedigi pencere. O olmadan
 * bu kapi, ustune birkac adim eklenmis bir rastgele sayi uretecidir.
 */

export interface EvaluatedRun {
  verdict: WalkForwardVerdict;
  /** Kazanan hucre skorlama filtrelerini gecti mi (fallback'e dusulmedi mi)? */
  qualified: boolean;
  test: BacktestResults;
  windowsPositive: number;
  windowCount: number;
  /** Kazanan hucrenin Chebyshev kupundeki nitelikli / diskalifiye komsu sayilari. */
  qualifiedNeighbors: number;
  dqNeighbors: number;
  /** Grid GENELINDE skorlama filtrelerini gecen hucre sayisi ve toplam hucre sayisi.
   *  Plato sarti mutlak sayi degil, bu ikisine gore ORAN olarak olculur. */
  gridQualified: number;
  gridTotal: number;
  /** Kazanan hucrenin, uzunlugu >= 3 olan eksenlerde grid sinirinda oldugu eksen sayisi
   *  ve bu tur eksenlerin toplami. Optimum aranan araligin KENARINDAYSA gercek optimum
   *  muhtemelen gridin disindadir — bu red sebebi degil, uyari sebebidir. */
  boundaryAxes: number;
  freeAxes: number;
  codeSha256: string;
  /** Giris sinyallerinin imzasi: `${timestamp}:${symbol}:${side}` kumesi. */
  entrySignature: ReadonlySet<string>;
}

export interface PromotionInput {
  /** Bu gece AYNI veri ve AYNI maliyetle yeniden kosulmus sampiyon. */
  champion: EvaluatedRun | null;
  /** Sampiyonun maliyet stresi ve kasasi — sampiyonu kendi kapisindan gecirmek icin.
   *  Yoksa sampiyon yeniden nitelendirilemez ve `incumbentQualified` null kalir. */
  championStress: BacktestResults | null;
  championHoldout: BacktestResults | null;
  challenger: EvaluatedRun;
  /** Aday, fee x1.5 / slippage x2 ile. */
  challengerStress: BacktestResults;
  /** Aday, SECIMDE HIC KULLANILMAYAN holdout penceresinde. */
  holdout: BacktestResults;
}

export interface PromotionVerdict {
  promote: boolean;
  /** Gecilen sartlar — raporda gorunur. */
  reasons: string[];
  /** Gecilemeyen sartlar. Bos degilse promote = false. */
  blockers: string[];
  /** Reddi tetiklemeyen ama operatorun gormesi gereken bulgular. */
  warnings: string[];
  /** Sampiyon BUGUN kendi kapisindan gecer miydi? Sampiyon yoksa (veya stres/kasa
   *  kosulari saglanmadiysa) null. false ise: sistem, sinavini veremeyen bir
   *  stratejiyi canli tutuyor demektir. */
  incumbentQualified: boolean | null;
}

/** Aday, sampiyonun MAR'ini bu kadar gecmeli. Gurultu hendegi. */
export const MAR_MARGIN = 1.1;
/** Test diliminde en az bu kadar islem. */
export const MIN_TEST_TRADES = 30;
/** Kasada en az bu kadar islem. Uc islemde +%100 kasa kaniti degil, gurultudur. */
export const MIN_HOLDOUT_TRADES = 20;
/** Plato sarti: oranin yani sira mutlak taban — 3 komsulu bir kose plato sayilmaz. */
export const MIN_QUALIFIED_NEIGHBORS = 3;
/** Kazanan hucrenin komsulugu, grid genelinden en az bu kat daha temiz olmali. */
export const PLATEAU_LIFT = 1.5;
/** Grid'in cogu zaten nitelikliyse orani tavanlar: %90 ustu istemek anlamsiz olurdu. */
export const PLATEAU_RATE_CAP = 0.9;
/** Sinyal ortusme tavani: bunun ustu "ayni strateji, farkli sapka". */
export const MAX_SIGNAL_OVERLAP = 0.9;

interface Check {
  ok: boolean;
  /** Sart saglandiginda raporda gorunecek cumle. */
  pass: string;
  /** Saglanmadiginda gorunecek cumle. */
  fail: string;
}

/**
 * TEK BASINA GECERLILIK — "bu kosu, kendi basina, kanit sayilir mi?"
 *
 * Sampiyona da adaya da AYNEN uygulanir. Karsilastirmali hicbir sart icermez; buradaki
 * her sart, digerinden habersiz tek bir kosuya bakarak cevaplanabilir. Simetrinin sarti
 * budur: kapinin iki tarafinda iki farkli "yeterince iyi" tanimi olamaz.
 */
function standaloneChecks(
  run: EvaluatedRun,
  stress: BacktestResults,
  holdout: BacktestResults,
): Check[] {
  const checks: Check[] = [];

  // --- 1. Skorlama filtrelerini gecen bir hucre VAR MI?
  // Fallback'e dusulduyse "kazanan", filtreleri gecemedigi halde en yuksek PnL'i olan
  // hucredir — yani tam olarak elemek istedigimiz sey.
  checks.push({
    ok: run.qualified,
    pass: `${run.gridQualified}/${run.gridTotal} grid cells passed the scoring filters`,
    fail: 'no grid cell passed the scoring filters — the "winner" is just the highest-PnL cell',
  });

  // --- 2. Walk-forward hukmu ROBUST.
  //
  // Bu TEK sart, uc olcuyu birden kapsar (bkz. walkForward.deriveVerdict):
  // test PnL > 0, test drawdown <= tavan, pozitif pencere orani >= esik. Kapi bunlari
  // AYRICA sormaz — sorsaydi, ayni olcunun iki esigi olurdu ve gevsek olan olu kalirdi.
  //
  // Hukum, run.verdict alanindan OKUNMAZ; ayni fonksiyonla YENIDEN hesaplanir. Etikete
  // guvenmek, kapinin kendi karar olcutunu disaridan gelen bir stringe devretmesi olurdu:
  // o alan yanlis doldurulursa (veya bir gun baska bir tanimla hesaplanirsa) kapi sessizce
  // gevser. Tek tanim + yerinde hesap = etiketin bozulmasi kapiyi etkilemez.
  const needWindows = requiredPositiveWindows(run.windowCount);
  const verdict = deriveVerdict({
    test: run.test,
    windowsPositive: run.windowsPositive,
    windowCount: run.windowCount,
    fallbackUsed: !run.qualified,
  });
  checks.push({
    ok: verdict === 'ROBUST',
    pass:
      `walk-forward ROBUST — test +${run.test.totalPnlPercent.toFixed(1)}%, ` +
      `drawdown ${run.test.maxDrawdownPercent.toFixed(1)}% (ceiling ${MAX_DRAWDOWN_PCT}%), ` +
      `${run.windowsPositive}/${run.windowCount} windows positive`,
    fail:
      `walk-forward ${verdict}, must be ROBUST — ` +
      `test ${run.test.totalPnlPercent >= 0 ? '+' : ''}${run.test.totalPnlPercent.toFixed(1)}%, ` +
      `drawdown ${run.test.maxDrawdownPercent.toFixed(1)}% (ceiling ${MAX_DRAWDOWN_PCT}%), ` +
      `${run.windowsPositive}/${run.windowCount} windows positive (${needWindows} required)`,
  });

  // --- 3. Test dilimi istatistiki olarak anlamli mi?
  checks.push({
    ok: run.test.totalTrades >= MIN_TEST_TRADES,
    pass: `${run.test.totalTrades} test trades`,
    fail: `only ${run.test.totalTrades} test trades, ${MIN_TEST_TRADES} required — too few to be statistically meaningful`,
  });

  // --- 4. MALIYET STRESI: edge mi, yoksa maliyet varsayimimiza yapilmis bahis mi?
  // Gercekci maliyette karli ama biraz daha yuksek maliyette zararli bir strateji,
  // piyasa hakkinda degil BIZIM TABLOMUZ hakkinda bir iddiadir.
  checks.push({
    ok: stress.totalPnlPercent > 0,
    pass: `still +${stress.totalPnlPercent.toFixed(1)}% under cost stress (fees x1.5, slippage x2)`,
    fail:
      `${stress.totalPnlPercent.toFixed(1)}% under cost stress — ` +
      'the edge is a bet on our cost assumption, not on the market',
  });

  // --- 5. KASA.
  //
  // Bu pencereyi hicbir backtest, hicbir sweep, hicbir skorlama gormedi. Ona dokunan TEK
  // kod burasi ve yalnizca son bir evet/hayir olarak. Yukaridaki tum sartlar "secim
  // yaptigimiz veriye" bakiyor; bu, secimden SONRA sorulan tek durust soru.
  //
  // Islem sayisi sarti bilerek burada: kasada 3 islemle +%100, kanit degil gurultudur —
  // ve eski kapida bu delik acikti.
  const vaultOk =
    holdout.totalPnlPercent > 0 &&
    holdout.maxDrawdownPercent <= MAX_DRAWDOWN_PCT &&
    holdout.totalTrades >= MIN_HOLDOUT_TRADES;
  checks.push({
    ok: vaultOk,
    pass:
      `HOLDOUT (never used in selection): +${holdout.totalPnlPercent.toFixed(1)}%, ` +
      `drawdown ${holdout.maxDrawdownPercent.toFixed(1)}%, ${holdout.totalTrades} trades`,
    fail:
      `failed on the HOLDOUT: ${holdout.totalPnlPercent >= 0 ? '+' : ''}${holdout.totalPnlPercent.toFixed(1)}% P&L, ` +
      `drawdown ${holdout.maxDrawdownPercent.toFixed(1)}% (ceiling ${MAX_DRAWDOWN_PCT}%), ` +
      `${holdout.totalTrades} trades (${MIN_HOLDOUT_TRADES} required) — ` +
      'most likely overfitted to the selection window',
  });

  // --- 6. PLATO, diken degil — GRID GENELINE GORE.
  //
  // Mayin tarlasindaki yalniz bir ada sansli bir hucredir; etrafindaki parametrelerle de
  // calisan bir bolge gercek bir rejimdir. Ama "kac diskalifiye komsu cok?" sorusunun
  // mutlak bir cevabi YOKTUR: komsuluk buyuklugu eksen sayisiyla ustel buyur (6 eksende
  // 485'e kadar) ve grid'in ne kadarinin elendigi geceden geceye degisir.
  //
  // Dogru soru sudur: kazanan hucrenin cevresi, grid'in GENELINDEN daha mi temiz?
  // Bu olcu birimsizdir — grid sekli, eksen sayisi ve eleme sertligi degisse de anlamini
  // korur.
  const p = plateau(run);
  const enoughQualified = run.qualifiedNeighbors >= MIN_QUALIFIED_NEIGHBORS;
  const cleanEnough = p.localRate >= p.requiredRate;

  // Mesaj, BAGLAYICI sarti one alir. Iki sarti birden yazip hangisinin dustugunu
  // okuyucuya biraktigimizda tam da eski kapinin hatasini tekrarlardik: orada
  // "25 qualifying neighbours (3 required)" cumlesi GECMIS bir sarti anlatiyor,
  // reddi yapan sayi ise cumlenin sonunda kayboluyordu.
  const why = !enoughQualified
    ? `only ${run.qualifiedNeighbors} qualifying neighbours, ${MIN_QUALIFIED_NEIGHBORS} required`
    : `only ${(p.localRate * 100).toFixed(1)}% of its ${p.hood} neighbours qualify vs ` +
      `${(p.gridRate * 100).toFixed(1)}% grid-wide — needs ${(p.requiredRate * 100).toFixed(1)}% ` +
      `(${PLATEAU_LIFT}x the grid rate)`;

  checks.push({
    ok: enoughQualified && cleanEnough,
    pass:
      `plateau: ${(p.localRate * 100).toFixed(1)}% of the winning cell's ${p.hood} neighbours qualify ` +
      `vs ${(p.gridRate * 100).toFixed(1)}% grid-wide (${p.lift.toFixed(1)}x, ${PLATEAU_LIFT}x required)`,
    fail:
      `the winning cell is a SPIKE: ${why} ` +
      `(${run.qualifiedNeighbors} qualified / ${run.dqNeighbors} disqualified neighbours) — ` +
      'the parameter choice rests on luck',
  });

  return checks;
}

interface Plateau {
  hood: number;
  localRate: number;
  gridRate: number;
  requiredRate: number;
  lift: number;
}

/** Kazanan hucrenin komsulugunun grid geneline gore temizligi. */
export function plateau(run: EvaluatedRun): Plateau {
  const hood = run.qualifiedNeighbors + run.dqNeighbors;
  const localRate = hood > 0 ? run.qualifiedNeighbors / hood : 0;
  const gridRate = run.gridTotal > 0 ? run.gridQualified / run.gridTotal : 0;

  // Grid'in cogu zaten nitelikliyse oran carpani anlamsizlasir (1.5 x %80 = %120,
  // saglanamaz). O durumda mutlak bir tavana duseriz: komsulugun %90'i nitelikli olsun.
  const requiredRate = Math.min(gridRate * PLATEAU_LIFT, PLATEAU_RATE_CAP);
  const lift = gridRate > 0 ? localRate / gridRate : 0;

  return { hood, localRate, gridRate, requiredRate, lift };
}

export function evaluatePromotion(input: PromotionInput): PromotionVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const c = input.challenger;
  const ch = input.champion;

  // --- A. Adayin tek basina gecerliligi.
  for (const check of standaloneChecks(c, input.challengerStress, input.holdout)) {
    if (check.ok) reasons.push(check.pass);
    else blockers.push(check.fail);
  }

  // Raporlanan etiket ile ayni tanimin yerinde hesabi ayrisiyorsa bu bir BUG'dir; kapi
  // dogru sayiyi kullanmaya devam eder ama sessiz kalmaz.
  const recomputed = deriveVerdict({
    test: c.test,
    windowsPositive: c.windowsPositive,
    windowCount: c.windowCount,
    fallbackUsed: !c.qualified,
  });
  if (recomputed !== c.verdict) {
    warnings.push(
      `internal inconsistency: the run reports verdict ${c.verdict} but the same definition ` +
        `recomputes to ${recomputed} from its own numbers — the gate used ${recomputed}`,
    );
  }

  // --- B. Sampiyonu GERCEKTEN gecmeli (elmayla elma: sampiyon bu gece yeniden kosuldu).
  if (ch) {
    // MAR zaten risk-getiri takasini iceriyor (getiri / drawdown). Bunun USTUNE bir de
    // "drawdown sampiyonunkinden cok yuksek olmasin" sarti koymak riski IKI KEZ saymak
    // ve kalici olarak mevcut sampiyondan yana egilmek olurdu: dusuk getirili/dusuk
    // drawdown'lu bir sampiyon, cok daha yuksek MAR'li ama daha oynak bir adayi sonsuza
    // dek bloklardi. Mutlak risk siniri zaten MAX_DRAWDOWN_PCT (sart 2 ve 5).
    const need = ch.test.mar * MAR_MARGIN;
    const marginPct = Math.round((MAR_MARGIN - 1) * 100);
    if (c.test.mar >= need) {
      reasons.push(
        `MAR ${c.test.mar.toFixed(2)} beats champion ${ch.test.mar.toFixed(2)} by the required ${marginPct}%`,
      );
    } else {
      blockers.push(
        `MAR ${c.test.mar.toFixed(2)} did not clear the champion's ${ch.test.mar.toFixed(2)} by ${marginPct}% ` +
          `(needs >= ${need.toFixed(2)})`,
      );
    }

    // --- Klon degil.
    if (c.codeSha256 === ch.codeSha256) {
      blockers.push('the code is byte-identical to the champion');
    } else {
      const overlap = signalOverlap(c.entrySignature, ch.entrySignature);
      if (overlap < MAX_SIGNAL_OVERLAP) {
        reasons.push(`${(overlap * 100).toFixed(0)}% signal overlap with the champion`);
      } else {
        blockers.push(
          `${(overlap * 100).toFixed(0)}% signal overlap with the champion ` +
            `(must be under ${MAX_SIGNAL_OVERLAP * 100}%) — the same strategy wearing a different hat`,
        );
      }
    }
  } else {
    reasons.push('no incumbent — this candidate would be the first champion');
  }

  // --- C. Sampiyon bugun kendi kapisindan gecer miydi?
  //
  // Reddi tetiklemez: "adayi reddet" ile "sampiyonu indir" ayri kararlardir ve ikincisi
  // canli pozisyonlara dokunur, yani operatorundur. Ama sessiz de kalmaz — cunku bir
  // adayin reddedilmesi, yerinde kalanin dogrulanmasi ANLAMINA GELMEZ.
  let incumbentQualified: boolean | null = null;
  if (ch && input.championStress && input.championHoldout) {
    const champChecks = standaloneChecks(ch, input.championStress, input.championHoldout);
    const champFails = champChecks.filter((x) => !x.ok);
    incumbentQualified = champFails.length === 0;

    if (!incumbentQualified) {
      warnings.push(
        `THE INCUMBENT WOULD NOT PASS ITS OWN GATE TODAY (${champFails.length} of ` +
          `${champChecks.length} standalone conditions fail): ${champFails.map((x) => x.fail).join('; ')}`,
      );
      warnings.push(
        'Rejecting the candidate is NOT a validation of the champion. If no candidate ' +
          'qualifies while the incumbent also fails, the conservative action is to go flat, ' +
          'not to keep trading the incumbent.',
      );
    }
  }

  // --- D. Optimum grid'in kenarinda mi?
  //
  // Red sebebi degil: hucre gercekten iyi olabilir. Ama aranan araligin kenarinda oturan
  // bir optimum, olctugumuz seyin "en iyi parametre" degil "bakmayi biraktigimiz yer"
  // olabilecegini dusundurur.
  //
  // Bu uyari once "gridi genislet" diyordu; OLCTUK ve tavsiye yanlis cikti. 2026-08-12
  // adayinda eksenler ucuna kadar acildiginda kazanan yine YENI uclara kosti (sinirdaki
  // eksen 3/5 -> 4/5), in-sample rakamlar sisti (test +%93 -> +%368) ama pozitif pencere
  // sayisi DUSTU (7/11 -> 6/11); ayni genislemede sampiyonun kasasi +%1.1'den -%23.2'ye
  // gitti. Yani genisletmek sinirI TASIR, cozmez — ve daha cok hucre taramak daha cok
  // coklu-test demektir. Uyari artik gozlemi bildirir, eylem recete etmez.
  if (c.freeAxes > 0 && c.boundaryAxes * 2 >= c.freeAxes) {
    warnings.push(
      `the winning cell sits at the grid boundary on ${c.boundaryAxes} of ${c.freeAxes} sweepable axes — ` +
        'what was measured may be the edge of the search rather than an optimum. Widening the axes ' +
        'does not necessarily settle it: if performance is monotonic in these parameters the winner ' +
        'just moves to the new edge, while the extra cells searched buy more multiple testing',
    );
  }

  return { promote: blockers.length === 0, reasons, blockers, warnings, incumbentQualified };
}

/** Iki strateji ayni anlarda ayni yonde mi giriyor? Jaccard benzerligi. */
export function signalOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}
