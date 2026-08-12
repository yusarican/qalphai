import fs from 'node:fs';
import path from 'node:path';
import { CodexDriver } from '../src/codex/driver';
import { createWorkspace, destroyWorkspace, extractCandidate } from '../src/codex/workspace';
import { compileStrategy, validateStrategySource } from '../src/strategy/validator';
import { buildApiDts } from '../src/codex/workspace';
import { env } from '../src/config/env';

/**
 * Codex entegrasyonunun uctan uca duman testi:
 *   izole workspace kur -> Codex'e basit bir strateji yazdir -> diskten oku ->
 *   validator + derleyiciden gecir.
 *
 *   npx tsx scripts/codexSmoke.ts
 */

const BRIEF = `# Gorev

\`candidate/strategy.ts\` dosyasina, \`strategy-api.d.ts\` sozlesmesini uygulayan
BASIT bir kripto trading stratejisi yaz.

Strateji: RSI(14) 30'un altindaysa LONG, 70'in ustundeyse SHORT, arada ise veto.
Esikleri \`params\` uzerinden ayarlanabilir yap (rsiLow, rsiHigh) ve ikisini de sweep'e ac.

## KATI KURALLAR (ihlal edersen aday reddedilir)

- \`./strategy-api\` DISINDA hicbir import yok. O da \`import type\` olmali.
- \`evaluate()\` SENKRON. async/await/Promise yok.
- Yasak: process, require, fetch, eval, Function, Date, Math.random, setTimeout, globalThis, Buffer.
- \`.constructor\` veya \`__proto__\` erisimi yok.
- Modul seviyesinde \`let\`/\`var\` yok; modul seviyesinde mutasyona ugrayan koleksiyon yok.
  (Strateji DURUMSUZ olmali: ayni ctx her zaman ayni karari vermeli.)
- \`ctx\` dondurulmustur, yazmaya calisma.
- Boyut, kaldirac, TP, SL BELIRLEYEMEZSIN — donus tipinde o alanlar yoktur. Senin isin
  sadece: girilsin mi, girilecekse LONG mu SHORT mu.
- Dosya bir \`StrategyFactory\` default export etmeli.

Isin bitince sadece dosyayi yaz; uzun aciklama yapma.
`;

async function main(): Promise<void> {
  console.log(`Model: ${env.codex.model} | effort: ${env.codex.reasoningEffort}\n`);

  const ws = createWorkspace({ runId: 'smoke', brief: BRIEF, examples: {} });
  console.log(`Workspace: ${ws.dir}`);
  console.log(`  icerik: ${fs.readdirSync(ws.dir).join(', ')}\n`);

  const driver = await CodexDriver.connect();
  console.log('Codex baglandi (ChatGPT hesabi dogrulandi).\n');

  try {
    const threadId = await driver.startThread(ws.dir);
    console.log(`Thread: ${threadId}\nCodex calisiyor...\n`);

    const t0 = Date.now();
    const res = await driver.turn(threadId, 'BRIEF.md dosyasini oku ve gorevi yap.');
    console.log(`Tur bitti (${((Date.now() - t0) / 1000).toFixed(0)}sn).\n`);

    const source = extractCandidate(ws, res.text);
    if (!source) {
      console.error('BASARISIZ: Codex candidate/strategy.ts yazmadi.');
      console.error('Son mesaj:', res.text.slice(0, 500));
      process.exit(1);
    }

    console.log(`--- Uretilen strateji (${source.split('\n').length} satir) ---`);
    console.log(source.slice(0, 900));
    console.log('---\n');

    const v = validateStrategySource(source);
    console.log(`Validator : ${v.ok ? 'GECTI' : 'REDDEDILDI'}`);
    if (!v.ok) for (const i of v.issues) console.log(`   [${i.code}] satir ${i.line}: ${i.message}`);

    const c = compileStrategy(source, buildApiDts());
    console.log(`Derleyici : ${c.ok ? 'GECTI' : 'REDDEDILDI'}`);
    if (!c.ok) for (const d of c.diagnostics) console.log(`   [${d.code}] satir ${d.line}: ${d.message}`);

    // Adayi incelemek icin sakla.
    const out = path.join('strategies', 'candidates', 'smoke');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'strategy.ts'), source);
    console.log(`\nAday kaydedildi: ${out}/strategy.ts`);
  } finally {
    driver.close();
    destroyWorkspace(ws);
  }
}

main().catch((err) => {
  console.error('\nHATA:', err instanceof Error ? err.message : err);
  process.exit(1);
});
