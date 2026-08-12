/**
 * SISTEM GENELI RISK LIMITLERI — tek tanim, tek sayi.
 *
 * Bu dosya bir "sabitler cop kutusu" degil. Buradaki iki sayinin ortak ozelligi su:
 * ucu de sistemin BIRDEN COK yerinde ayni soruyu soruyor.
 *
 *   - drawdown tavani: grid elemesi (gridScoring), walk-forward hukmu (walkForward)
 *     ve promosyon kapisi (promotion) — ucu de "bu kayip kabul edilebilir mi?" diyor.
 *   - pencere istikrari: walk-forward hukmu ve promosyon kapisi — ikisi de "kar tek
 *     sansli pencerede mi toplanmis?" diyor.
 *
 * Daha once bu sayilar uc-dort yere kopyalanmisti ve KOPYALAR AYRISMISTI: grid %40'a
 * kadar drawdown'i nitelikli sayarken kapi %25 istiyordu. Yani arama uzayi ile kabul
 * uzayi celisiyordu — grid, kapinin yapisal olarak asla kabul edemeyecegi bir kazanan
 * seciyordu. Ayni sekilde hukum %75 pozitif pencere isterken kapi ayrica %60 istiyordu;
 * %60 sarti hicbir zaman tek basina tetiklenemedigi icin OLU koddu.
 *
 * Kural: bu sayilardan biri degisecekse BURADA degisir. Cagiran taraf kendi esigini
 * tanimlamaz — tanimlarsa, iki tanim sessizce ayrisir ve kimse fark etmez.
 */

/**
 * Kabul edilebilir maksimum drawdown (%).
 *
 * Hem secim diliminde hem kasada ayni tavan gecerlidir: kasada daha gevsek bir tavan,
 * "secimde reddettigimiz riski kasada kabul ediyoruz" demek olurdu.
 */
export const MAX_DRAWDOWN_PCT = 40;

/**
 * Walk-forward pencerelerinin en az bu orani pozitif olmali.
 *
 * Bu sistemin EN SIKI sarti ve promote oranini en cok belirleyen sayi budur: 11 pencerede
 * %75, 9 pencerenin pozitif olmasi demektir. Gercek bir stratejinin bile ~45 gunluk
 * dilimlerin %82'sinde kar etmesi zordur.
 *
 * Gevsetmek istenirse tek yer burasi. 0.60 -> 11 pencerede 7, 0.55 -> 7 (ceil).
 */
export const MIN_WINDOW_WIN_RATE = 0.75;

/** `windowCount` pencerede pozitif olmasi gereken pencere sayisi. */
export function requiredPositiveWindows(windowCount: number): number {
  return Math.ceil(MIN_WINDOW_WIN_RATE * windowCount);
}
