import { readFileSync, writeFileSync } from 'node:fs';
import { once, openDonDb } from '../../../packages/spine/src/index.ts';

const [dbPath, counterFile] = process.argv.slice(2);
if (!dbPath || !counterFile) {
  console.error('Usage: sigkill-worker.ts <dbPath> <counterFile>');
  process.exit(2);
}

const db = openDonDb(dbPath);

try {
  const step1 = await once(
    db,
    {
      memoKey: 'step-1-safe-side-effect',
      runId: 'chaos-sigkill-run',
      agentId: 'api-keeper',
      replay: 'safe',
    },
    async () => {
      const current = Number(readFileSync(counterFile, 'utf8').trim() || '0');
      const next = current + 1;
      writeFileSync(counterFile, String(next), 'utf8');
      return { executedCount: next };
    },
  );

  const step2 = await once(
    db,
    {
      memoKey: 'step-2-unsafe-external-call',
      runId: 'chaos-sigkill-run',
      agentId: 'api-keeper',
      replay: 'unsafe',
    },
    async () => {
      console.log('READY_FOR_KILL');
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return { completed: true };
    },
  );

  console.log(JSON.stringify({ step1, step2 }));
} finally {
  db.close();
}
