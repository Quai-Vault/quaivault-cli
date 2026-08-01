import { afterEach, describe, expect, it } from 'vitest';
import { ENV_VARS } from '@quaivault/sdk';
import { CHANNEL_BUDGET, describeChannels, planChannels } from '../../src/store/channels.js';
import { doctorCommand } from '../../src/commands/doctor.js';
import { ADDR, createFakeClient, createFakeContext } from '../fake-client.js';

const abort = new AbortController().signal;

describe('channel budget', () => {
  it('subscribes to everything when under the cap', () => {
    const plan = planChannels(['0xa', '0xb']);
    expect(plan.subscribed).toEqual(['0xa', '0xb']);
    expect(plan.polled).toEqual([]);
    expect(plan.degraded).toBe(false);
  });

  it('polls the tail once the cap is exceeded', () => {
    const vaults = Array.from({ length: CHANNEL_BUDGET + 5 }, (_, i) => `0x${i}`);
    const plan = planChannels(vaults);
    expect(plan.subscribed).toHaveLength(CHANNEL_BUDGET);
    expect(plan.polled).toHaveLength(5);
    expect(plan.degraded).toBe(true);
  });

  it('keeps the caller’s relevance order, so the watched vaults are the active ones', () => {
    const plan = planChannels(['0xmostRecent', '0xolder'], 1);
    expect(plan.subscribed).toEqual(['0xmostrecent']);
  });

  it('folds duplicates rather than spending two channels on one vault', () => {
    // forOwner and forGuardian both return a vault where you are both.
    const plan = planChannels(['0xAAA', '0xaaa', '0xBBB']);
    expect(plan.subscribed).toEqual(['0xaaa', '0xbbb']);
  });

  it('says plainly what is watched and what is not', () => {
    expect(describeChannels(planChannels(['0xa']))).toMatch(/1 of 10 realtime channels/);
    const over = describeChannels(planChannels(Array.from({ length: 12 }, (_, i) => `0x${i}`)));
    expect(over).toMatch(/2 vaults polled instead of watched/);
  });
});

describe('qv doctor', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.values(ENV_VARS)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  const ctx = () =>
    createFakeContext({
      client: createFakeClient({ forOwner: [ADDR.vault] }),
      identity: ADDR.alice,
    });

  it('reports which QuaiVault variables are set, by name only', async () => {
    // R9 wants this pasteable into an issue, and one of the variables it
    // enumerates is QUAIVAULT_PRIVATE_KEY. Printing a value would turn a bug
    // report into a key disclosure.
    process.env[ENV_VARS.privateKey] = '0x' + 'ab'.repeat(32);
    process.env[ENV_VARS.network] = 'SENTINEL-NETWORK-VALUE';
    const result = await doctorCommand.run!(ctx(), {}, abort);
    const env = result.data.checks.find((c) => c.name === 'env');
    expect(env?.detail).toContain(ENV_VARS.privateKey);
    expect(env?.detail).toContain(ENV_VARS.network);
    expect(JSON.stringify(result)).not.toContain('ab'.repeat(32));
    // The variable's *name* appears; its value never does.
    expect(JSON.stringify(result)).not.toContain('SENTINEL-NETWORK-VALUE');
  });

  it('warns that a key in the environment is the least-preferred way to hold one', async () => {
    process.env[ENV_VARS.privateKey] = '0x' + 'cd'.repeat(32);
    const result = await doctorCommand.run!(ctx(), {}, abort);
    const env = result.data.checks.find((c) => c.name === 'env');
    expect(env?.advice).toMatch(/QUAIVAULT_PRIVATE_KEY_FILE|keystore/);
  });

  it('says "none set" rather than an empty line when nothing is exported', async () => {
    for (const name of Object.values(ENV_VARS)) delete process.env[name];
    const result = await doctorCommand.run!(ctx(), {}, abort);
    expect(result.data.checks.find((c) => c.name === 'env')?.detail).toBe('none set');
  });

  it('states the channel budget so degradation is visible rather than mysterious', async () => {
    const result = await doctorCommand.run!(ctx(), {}, abort);
    const channels = result.data.checks.find((c) => c.name === 'channels');
    expect(channels?.detail).toMatch(/realtime channels in use/);
  });

  it('never emits a secret anywhere in its output', async () => {
    const secret = 'deadbeef'.repeat(8);
    process.env[ENV_VARS.privateKey] = `0x${secret}`;
    process.env[ENV_VARS.indexerAnonKey] = secret;
    const result = await doctorCommand.run!(ctx(), {}, abort);
    const rendered = JSON.stringify(doctorCommand.toJson(result, ctx()));
    expect(rendered).not.toContain(secret);
  });
});
