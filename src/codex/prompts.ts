import { directiveBlock } from '../orchestrator/directives';
import type { ArxivPaper } from '../research/arxiv';
import type { ChampionRecord } from '../orchestrator/champion';
import type { BacktestResults } from '../lib/types';

/**
 * Codex'e verilen BRIEF.
 *
 * Iki ilke:
 *
 * 1. VALIDATOR KURALLARI BIREBIR LISTELENIR. Bir modele "temiz kod yaz" deyip sonra
 *    bilmedigi bir kurala takilmasini izlemek, hem turu bosa harcar hem de onarim
 *    dongusunu uzatir. Hatalar SURPRIZ degil, kendi kendine yapilmis olmali.
 *
 * 2. DEGERLENDIRME KRITERLERI ACIKCA SOYLENIR. Codex'in gecmesi gereken kapinin ne
 *    oldugunu bilmesi, kapiyi KANDIRMASINI saglamaz (kapinin koduna erisimi yok, ve
 *    kasa penceresini goremez) — sadece dogru seyi hedeflemesini saglar. Ornegin
 *    "maliyet stresi" sartini bilen bir model, cok sik islem yapan bir strateji yazmaz.
 *
 * 3. YONLENDIRME KURALLARDAN ONCE GELIR (orchestrator/directives.ts). Ust akil gecenin
 *    onceligini enjekte edebilir, ama blok HARD_RULES'tan ONCE yerlestirilir ve kendisi
 *    "bu bir oncelik, izin degil" der. Sonra gelen kurallar son sozu soyler — ve o
 *    kurallar zaten prompt'a degil validator/gauntlet/kapiya bagli.
 *    Aktif yonlendirme yokken directiveBlock BOS STRING doner: brief karakter karakter
 *    bugunku halinde kalir.
 *
 *    DIKKAT: bu yuzden enjeksiyon noktasi KENDI satir sonunu yutar
 *    (`${directiveBlock(...)}${HARD_RULES}`, arada satir sonu YOK). Araya bir satir sonu
 *    koymak, yonlendirme yokken bile brief'e fazladan bir bos satir ekler — tek karakter,
 *    ama "acilmadikca hicbir sey degismez" sozu tam olarak boyle asinir. Blok bos
 *    olmadiginda kendi bosluklarini kendisi tasir (directives.ts:directiveBlock).
 */

const HARD_RULES = `
## KATI KURALLAR — ihlal edilirse aday OTOMATIK REDDEDILIR

Kodun once bir AST dogrulayicisindan, sonra bir tip kontrolunden, sonra izole bir vm
realm'inden gecer. Asagidakiler MAKINE tarafindan zorlanir:

**Import**
- \`./strategy-api\` DISINDA hicbir import yok. O da \`import type\` olmali.
- \`require()\`, dinamik \`import()\`, re-export yok.

**Senkronluk**
- \`evaluate()\` SENKRON. \`async\`, \`await\`, \`Promise\`, generator yok.
  (Donus tipi zaten \`Promise\` degil — async yazarsan derlenmez.)

**Yasakli kimlikler**
- \`process\`, \`require\`, \`module\`, \`global\`, \`globalThis\`, \`Buffer\`
- \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`
- \`eval\`, \`Function\`, \`Reflect\`, \`Proxy\`, \`WebAssembly\`
- \`setTimeout\`, \`setInterval\`, \`queueMicrotask\`
- \`Date\`, \`performance\`, \`crypto\`, \`Intl\`, \`console\`
- \`Math.random()\`
- \`.constructor\`, \`__proto__\`

**Durumsuzluk (en sik yapilan hata)**
- Modul seviyesinde \`let\`/\`var\` YOK.
- Modul seviyesinde mutasyona ugrayan koleksiyon YOK (\`const cache = new Map()\` + \`.set()\`).
- Mumlar arasi hafiza tutamazsin. Her cagri bagimsizdir; ayni \`ctx\` her zaman ayni
  karari vermelidir. (Sistem stratejini her mumda TAZE bir instance ile cagirir ve
  determinizmi iki ayri surecte hash'leyerek dogrular.)
- \`ctx\` dondurulmustur; yazmaya calisma.

**Kapsam**
- Pozisyon boyutu, kaldirac, take-profit, stop-loss BELIRLEYEMEZSIN. Donus tipinde o
  alanlar YOKTUR. Senin isin sadece: **girilsin mi, girilecekse LONG mu SHORT mu.**
  Sizing/TP/SL/kaldirac harness'in isidir ve grid tarafindan ayrica optimize edilir.

**Bicim**
- <= 800 satir. Tek bir \`StrategyFactory\` default export.
- Kullandigin her parametreyi \`meta.params\` icinde tanimla. Taranmasini istediklerine
  \`sweep\` ver (param basina <= 6 deger; carpim <= \`maxSweepCells\`, default 24).
- Girmedigin durumlarda ANLAMLI bir \`veto\` kurali dondur (\`{ veto: true, rule: 'LOW_VOL' }\`).
  Bu bos bir log degil: sistem her veto kurali icin "bu filtre olmasaydi ne olurdu"
  karsi-olgusunu kosar ve filtrenin sana kar mi kaybettirdigini R cinsinden raporlar.
`;

const EVALUATION = `
## NASIL DEGERLENDIRILECEKSIN

Stratejin su hattan gecer ve HERHANGI birinde duserse sampiyon degismez:

1. **Gauntlet**: determinizm (iki ayri surecte ayni cikti), look-ahead (karar barindan
   sonraki mumlar copa cevrilir — hicbir sinyalin degismemeli), performans, saglik
   (mumlarin >%95'inde pozisyon aciyorsan "dejenere" sayilirsin).

2. **Grid backtest**: parametrelerin x risk parametreleri (RR, SL, callback, islem basina
   risk) taranir. Walk-forward: kayan pencereler, ayrik test dilimleri.

3. **Promosyon kapisi** — hepsi saglanmali:
   - walk-forward hukmu ROBUST
   - test dilimi karli, >= 30 islem
   - pencerelerin >= %60'i pozitif (kar tek sansli pencereye yigilmamis)
   - mevcut sampiyonun MAR'ini en az %10 marjla gecmeli
   - **maliyet stresi**: fee x1.5, slippage x2 ile hala karli olmali
   - **plato**: kazanan hucrenin komsulari da calismali (yalniz bir "diken" reddedilir)
   - **KASA**: secimde HIC kullanilmayan 90 gunluk bir pencerede de karli olmali

Bunlarin pratik anlami:
- **Cok sik islem yapma.** Her giris/cikis taker komisyonu + slippage oder. Maliyet
  stresi, edge'i maliyet varsayimina bagimli olan stratejileri oldurur.
- **Parametrelere asiri duyarli olma.** Sadece tek bir esik degerinde calisan bir
  strateji plato sartindan duser.
- **Donemin tamamina uydurma.** Kasa penceresini goremezsin ve orada da calismak zorundasin.
`;

/**
 * `pick` yalnizca makaleyi degil, SECICININ OKUMASINI da tasir (hipotez + uygulama acisi).
 *
 * Bunu brief'e koymak Codex'in isini kolaylastirmak icin degil, turunu korumak icin:
 * abstract'i cozup "bu bizde nasil yazilir" sorusunu cevaplamak, Codex'in reasoning
 * butcesinin ciddi bir kismini yiyordu ve o is zaten secim asamasinda bir kez yapildi.
 *
 * Ama BAGLAYICI degil: secici abstract'a bakar, Codex sozlesmeyi ve ornekleri gorur.
 * Ikisi celisirse Codex'in okumasi gecerlidir — asagida bunu acikca soyluyoruz. Aksi
 * halde seciciden gelen zayif bir aci, gecenin tavanini belirlerdi.
 */
export function buildNewStrategyBrief(pick: {
  paper: ArxivPaper;
  hypothesis?: string;
  angle?: string;
  reason?: string;
}): string {
  const { paper } = pick;
  const priorRead =
    pick.hypothesis || pick.angle
      ? `
## On okuma (makaleyi secen model)

${pick.reason ? `**Neden bu makale:** ${pick.reason}\n` : ''}${pick.hypothesis ? `**Hipotez:** ${pick.hypothesis}\n` : ''}${pick.angle ? `**Onerilen uygulama acisi:** ${pick.angle}\n` : ''}
Bu bir BASLANGIC NOKTASI, emir degil. Yalnizca abstract okunarak yazildi; sen sozlesmeyi
ve ornekleri de goruyorsun. Katilmiyorsan kendi okumani uygula ve ozetinde NEDEN
ayrildigini yaz.
`
      : '';

  return `# Gorev: bilimsel makaleden yeni bir trading stratejisi

## Makale

**${paper.title}**
arXiv:${paper.id}  |  ${paper.categories.join(', ')}  |  ${new Date(paper.published).toISOString().slice(0, 10)}

${paper.summary}
${priorRead}
## Ne yapacaksin

1. Makalenin ONERDIGI edge'i tek cumleyle formule et: *piyasada ne oluyor da bu strateji
   para kazanmali?* Sadece "makale boyle diyor" yetmez — mekanizmayi anla.

2. O edge'i, \`strategy-api.d.ts\` sozlesmesiyle IFADE EDILEBILIR bir giris kuralina cevir.
   Elinde OHLCV mumlari ve turetilmis indikatorler var (RSI, MACD, Bollinger, EMA/SMA,
   ATR, ADX/DI, Stochastic, Fibonacci, mum formasyonlari, 5-katmanli kompozit skor),
   ayrica funding orani, makro risk istahi ve BTC rejimi.

   **Makale uygulanamaz bir girdi istiyorsa** (limit order book, tick verisi, order-flow,
   opsiyon yuzeyi, alternatif veri) — bunu ACIKCA soyle ve \`candidate/strategy.ts\`
   dosyasina DOKUNMA. Uydurma bir yaklasim yazmak, gecenin tamamini bosa harcar.

3. Uygulanabiliyorsa \`candidate/strategy.ts\` dosyasini yaz.

${directiveBlock('codex-new')}${HARD_RULES}
${EVALUATION}

## Sozlesme

\`strategy-api.d.ts\` dosyasini oku — ctx'te tam olarak neyin oldugunu orada gorursun.
\`examples/\` altinda iki calisan ornek var.

Isin bitince kisa bir ozet ver: hipotez ne, giris kurali ne, hangi parametreleri actin.
`;
}

export function buildRefineBrief(args: {
  champion: ChampionRecord;
  championSource: string;
  results: BacktestResults;
  weakness: string;
}): string {
  return `# Gorev: mevcut sampiyonu ZAYIFLIGINA karsi gelistir

Bu gece uygulanabilir yeni bir makale cikmadi. Bunun yerine mevcut sampiyonu, TESHIS
EDILMIS zayifligina karsi mutasyona ugratacaksin.

## Mevcut sampiyon

**${args.champion.name}** v${args.champion.version}

\`\`\`typescript
${args.championSource}
\`\`\`

## Bu gece olctugumuz performansi

- Test dilimi: %${args.results.totalPnlPercent.toFixed(1)} PnL, MAR ${args.results.mar.toFixed(2)}
- Max drawdown: %${args.results.maxDrawdownPercent.toFixed(1)}
- Islem: ${args.results.totalTrades}, kazanma orani %${args.results.winRate.toFixed(0)}
- Beklenti: ${args.results.expectancyR.toFixed(3)}R
- Maliyetin brut kara orani: %${(args.results.feeShareOfGross * 100).toFixed(1)}

## TESHIS EDILEN ZAYIFLIK

${args.weakness}

## Ne yapacaksin

Bu zayifliga DOGRUDAN saldiran bir varyant yaz (\`candidate/strategy.ts\`).
Sampiyonu kopyalayip tek bir sabiti degistirmek YETMEZ: sistem, sampiyonla sinyal
ortusmesi %90'in uzerinde olan adaylari "ayni strateji, farkli sapka" diye reddeder.
Giris mantiginda gercek bir degisiklik yap.
${directiveBlock('codex-refine')}
${HARD_RULES}
${EVALUATION}
`;
}

/** Onarim turu: validator/gauntlet geri bildirimini AYNI thread'de besle. */
export function buildRepairPrompt(stage: string, feedback: string): string {
  return `Adayin **${stage}** asamasinda REDDEDILDI.

\`\`\`
${feedback}
\`\`\`

\`candidate/strategy.ts\` dosyasini duzelt. Yukaridaki her maddeyi gider.
Kurallari BRIEF.md'de tekrar okuyabilirsin.`;
}
