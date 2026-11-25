import { describe, expect, test } from 'bun:test';
import {
  createCalibratedTrustEvaluatorFromJev,
  createFauxJevClient,
  JEV_MODEL_FEATURES,
  JEV_MODEL_THRESHOLD,
  jevScore,
  resolveJevConnection,
  scoreJevPredicateMap,
} from './jev-client.ts';

describe('packages/trust/src/jev-client', () => {
  test('evaluates the 45-feature calibrated GBDT ensemble and hard prohibitions', () => {
    expect(JEV_MODEL_FEATURES.length).toBe(45);
    expect(JEV_MODEL_THRESHOLD).toBeGreaterThan(0);

    const allowed = scoreJevPredicateMap({
      owner_grant: 0.98,
      direct_request: 0.95,
      needed_step: 0.9,
      read_effect: 0.85,
      forbidden: 0.01,
      ask_first: 0.02,
    });
    expect(allowed.prohibited).toBe(false);
    expect(allowed.score).toBeGreaterThanOrEqual(JEV_MODEL_THRESHOLD);
    expect(allowed.allowed).toBe(true);

    const prohibited = scoreJevPredicateMap({
      owner_grant: 0.99,
      forbidden: 0.95,
    });
    expect(prohibited.prohibited).toBe(true);
    expect(prohibited.allowed).toBe(false);
    expect(prohibited.reason).toBe('jev_hard_prohibition');

    const unitZero = Array<number>(JEV_MODEL_FEATURES.length).fill(0);
    const baselineProb = jevScore(unitZero);
    expect(baselineProb).toBeGreaterThanOrEqual(0);
    expect(baselineProb).toBeLessThanOrEqual(1);
    expect(() => jevScore([0, 1])).toThrow(/incomplete/i);
  });

  test('calibrated evaluator maps noul refusals/denials/allows cleanly and resolves env config', async () => {
    expect(resolveJevConnection({ faux: true })).toBeNull();
    const orConn = resolveJevConnection({
      provider: 'auto',
      env: { OPENROUTER_API_KEY: 'sk-or-test-key' } as unknown as NodeJS.ProcessEnv,
    });
    expect(orConn?.provider).toBe('openrouter');

    const refusedClient = createFauxJevClient(async () => ({
      read_effect: { refused: true },
      private_preparation: { noul: 0.1 },
      direct_request: { noul: 0.9 },
      owner_grant: { noul: 0.9 },
      forbidden: { noul: 0.01 },
      ask_first: { noul: 0.01 },
      method_conflict: { noul: 0.01 },
      recipient_conflict: { noul: 0.01 },
      resource_conflict: { noul: 0.01 },
      new_obligation: { noul: 0.01 },
    }));
    const evalRefused = createCalibratedTrustEvaluatorFromJev(refusedClient);
    const r1 = await evalRefused({ toolName: 'git_push', payload: {} });
    expect(r1.choice).toBe('ask');
    expect(r1.reason).toBe('jev_refused');

    const forbiddenClient = createFauxJevClient(async () => ({
      read_effect: { noul: 0.1 },
      private_preparation: { noul: 0.1 },
      direct_request: { noul: 0.5 },
      owner_grant: { noul: 0.2 },
      forbidden: { noul: 0.97 },
      ask_first: { noul: 0.1 },
      method_conflict: { noul: 0.1 },
      recipient_conflict: { noul: 0.1 },
      resource_conflict: { noul: 0.1 },
      new_obligation: { noul: 0.1 },
    }));
    const evalForbidden = createCalibratedTrustEvaluatorFromJev(forbiddenClient);
    const r2 = await evalForbidden({ toolName: 'rm_rf', payload: {} });
    expect(r2.choice).toBe('deny');
  });
});
