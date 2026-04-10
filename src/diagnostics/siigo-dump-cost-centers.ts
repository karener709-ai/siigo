import { getEnvSiigoOnly } from '../config/env.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { getCostCenterMap } from '../siigo/cost-centers.js';
import { ConfigError, SyncError } from '../Core/errors.js';

async function main(): Promise<void> {
  const env = getEnvSiigoOnly();
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };
  const token = await getSiigoAccessToken(env, opts);
  const map = await getCostCenterMap(env, token, opts);
  console.log(JSON.stringify(Object.fromEntries(map), null, 2));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error('Config:', err.message);
    process.exit(2);
  }
  if (err instanceof SyncError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
