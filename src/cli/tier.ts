// Hardware-tier suggestion. Pure function on total RAM bytes + logical CPU
// count, separated from init.ts so it's trivially testable.
//
// Bands (see docs/hardware-and-performance.md):
//   small    — 4–8 GB    (Pi 4/5)
//   standard — 16 GB     (mini PC)
//   heavy    — 32 GB +   (5800H / desktop)
//
// CPU is a sanity check: in WSL2, Docker, and VMs `os.totalmem()` reports the
// container's memory cap, not host RAM, so a 32 GB / 5800H box can falsely
// look "small" if the cap is 8 GB. A real Pi has 4 cores; anything with 8+
// logical cores is not a Pi, so we bump the suggestion up to avoid handing
// such machines the 0.5b model defaults.

export type Tier = 'small' | 'standard' | 'heavy';

export function detectTier(totalRamBytes: number, cpuCount: number): Tier {
  const gb = totalRamBytes / 1024 / 1024 / 1024;
  let tier: Tier;
  if (gb < 12) tier = 'small';
  else if (gb < 24) tier = 'standard';
  else tier = 'heavy';

  if (cpuCount >= 12 && tier !== 'heavy') tier = 'heavy';
  else if (cpuCount >= 8 && tier === 'small') tier = 'standard';

  return tier;
}
