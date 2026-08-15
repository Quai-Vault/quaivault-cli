import { describe, expect, it } from 'vitest';
import type { QuaiVaultClient } from '@quaivault/sdk';
import { recoveryStatusCommand } from '../../src/commands/recovery.js';
import { ADDR, createFakeClient, createFakeContext } from '../fake-client.js';

const abort = new AbortController().signal;

describe('recovery status', () => {
  it('identifies the trusted module and gives the exact enable proposal', async () => {
    const ctx = createFakeContext();
    const result = await recoveryStatusCommand.run!(ctx, { vault: ADDR.vault }, abort);
    recoveryStatusCommand.render(result, ctx.io, ctx);
    const stdout = ctx.io.stdout.join('\n');

    expect(stdout).toContain(ctx.qv.config.contracts.socialRecovery);
    expect(stdout).toContain('disabled');
    expect(stdout).toContain(`qv propose enable-recovery ${ADDR.vault}`);
    expect(result.next).toEqual([`qv propose enable-recovery ${ADDR.vault}`]);
    expect(recoveryStatusCommand.toJson(result, ctx)).toMatchObject({
      vault: ADDR.vault,
      moduleAddress: ctx.qv.config.contracts.socialRecovery,
      enabled: false,
      configured: false,
    });
  });

  it('shows guardian threshold and period without requiring a pending recovery', async () => {
    const client = createFakeClient({
      vaults: {
        [ADDR.vault]: {
          recoveryEnabled: true,
          recoveryConfig: {
            guardians: [ADDR.alice, ADDR.bob],
            threshold: 2,
            recoveryPeriod: 604_800,
            configured: true,
          },
        },
      },
    });
    const ctx = createFakeContext({ client });
    const result = await recoveryStatusCommand.run!(ctx, { vault: ADDR.vault }, abort);
    recoveryStatusCommand.render(result, ctx.io, ctx);
    const stdout = ctx.io.stdout.join('\n');

    expect(stdout).toContain('enabled');
    expect(stdout).toContain('2 of 2');
    expect(stdout).toContain(ADDR.alice);
    expect(stdout).toContain('7d');
    expect(stdout).toContain('No pending recovery');
  });

  it('distinguishes a missing network deployment from a disabled module', async () => {
    const base = createFakeClient();
    const contracts = { ...base.config.contracts };
    delete contracts.socialRecovery;
    const client = {
      ...base,
      config: { ...base.config, contracts },
    } as QuaiVaultClient;
    const ctx = createFakeContext({ client });
    const result = await recoveryStatusCommand.run!(ctx, { vault: ADDR.vault }, abort);
    recoveryStatusCommand.render(result, ctx.io, ctx);

    expect(ctx.io.stdout.join('\n')).toContain('No SocialRecoveryModule deployment');
    expect(recoveryStatusCommand.toJson(result, ctx)).toMatchObject({
      moduleAddress: null,
      enabled: false,
      configured: false,
    });
  });
});
