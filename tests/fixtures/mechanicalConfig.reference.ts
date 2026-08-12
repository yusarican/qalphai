// samplebackend/lib/firestore.ts'ten cikarilan MechanicalConfig tipi (referans).
export interface MechanicalConfig {
  entryThreshold?: number;
  cooldownCandles?: number;
  btcRegimeFilter?: boolean;
  confirmationCandles?: number;
  minVolumeRatio?: number;
  requireDirectionalDi?: boolean;
}
