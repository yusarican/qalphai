import vm from 'node:vm';
import { compileStrategy } from './validator';
import { buildApiDts, toSandboxSource } from '../codex/workspace';
import type { Strategy, StrategyMeta } from './types';

/**
 * Bir aday kaynagindan yalnizca META'yi okur (id, params, warmupBars, provenance).
 *
 * evaluate() BURADA CAGRILMAZ — o her zaman sandbox worker'inda kosar. Ama modul
 * yuklenirken bile kodun ana surece dokunmamasi gerekir: bir "aday", modul govdesinde
 * yan etki denemis olabilir. Bu yuzden derlenmis JS izole bir vm realm'inde yuklenir
 * ve donen meta JSON ile "yikanir" (sandbox prototipli obje ana surece sizmasin).
 */
export async function loadMeta(source: string): Promise<Strategy> {
  const c = compileStrategy(toSandboxSource(source), buildApiDts());
  if (!c.ok) {
    throw new Error(
      'aday derlenmedi:\n' +
        c.diagnostics.map((d) => `  [${d.code}] satir ${d.line}: ${d.message}`).join('\n'),
    );
  }

  const realm = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(
    'globalThis.Math = Math; globalThis.JSON = JSON; globalThis.Object = Object; globalThis.Array = Array;',
    realm,
  );

  const loader = vm.compileFunction(`${c.js}\nreturn exports.default;`, ['exports'], {
    parsingContext: realm,
  });
  const factory = loader(vm.runInContext('({})', realm)) as () => { meta: StrategyMeta };

  const meta = JSON.parse(JSON.stringify(factory().meta)) as StrategyMeta;

  return {
    meta,
    // Gercek evaluate sandbox'ta kosar; buradaki yalnizca tip uyumu icin.
    evaluate: () => null,
  };
}
