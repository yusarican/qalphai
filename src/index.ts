import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { startLiveScheduler, startOrchestratorScheduler, startScheduler } from './orchestrator/scheduler';
import { runNightly } from './orchestrator/nightly';
import { readChampion } from './orchestrator/champion';
import { api } from './api/routes';
import { env } from './config/env';

const app = express();
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, testnet: env.binance.testnet });
});

/** Su an canliya cikan strateji. */
app.get('/api/champion', (_req, res) => {
  const c = readChampion();
  res.json(c ?? { strategyId: 'mechanical-v0', version: 0, name: 'Mekanik Tier-Composite v0 (builtin)' });
});

/** Panel API'si: canli durum, portfoy, backtest, raporlar. */
app.use('/api', api);

/**
 * Geceyi elle tetikle. Fire-and-forget: gece saatler surebilir, HTTP istegini bekletmeyiz.
 */
let manualRunning = false;
app.post('/api/nightly/run', (_req, res) => {
  if (manualRunning) return res.status(409).json({ error: 'bir gece kosusu zaten devam ediyor' });
  manualRunning = true;
  void runNightly().finally(() => {
    manualRunning = false;
  });
  return res.status(202).json({ status: 'basladi' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(env.port, () => {
  console.log(`TradeCraft AI :${env.port}  (Binance ${env.binance.testnet ? 'TESTNET' : 'MAINNET'})`);
  startScheduler();
  startLiveScheduler();
  startOrchestratorScheduler();
});
