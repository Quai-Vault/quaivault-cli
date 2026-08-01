import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { CommandSpec } from '../cli/spec.js';
import { span } from '../format/tone.js';
import { configPath } from '../context/config.js';
import { policyPath } from '../context/policy.js';
import { formatDuration, SECONDS_PER_BLOCK } from '../format/index.js';
import { SKEW_WARN_THRESHOLD_SECONDS } from '../context/client.js';
import { canPrompt } from '../cli/tty.js';
import { detectSkew } from '../context/skew.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  advice?: string;
}

interface DoctorData {
  checks: Check[];
  healthy: boolean;
}

/**
 * `qv doctor` is designed to be pasted into an issue — it is the only feedback
 * channel this tool has, since it collects no telemetry (plan §5.4).
 *
 * So it must never print a secret, and it redacts RPC/indexer URLs to
 * scheme+host: many providers embed an API key in the path.
 */
function redactUrl(url: string | undefined): string {
  if (!url) return '(default)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(unparseable)';
  }
}

export const doctorCommand: CommandSpec<Record<string, never>, DoctorData> = {
  path: ['doctor'],
  describe: 'Check node version, connectivity, clock, config and key setup',

  async run(ctx) {
    const checks: Check[] = [];

    const major = Number(process.versions.node.split('.')[0]);
    checks.push({
      name: 'node',
      ok: major >= 22,
      detail: process.versions.node,
      advice: major >= 22 ? undefined : 'QuaiVault CLI requires Node 22 or later.',
    });

    // The quais copy must be one, and within the SDK's declared peer range —
    // `--legacy-peer-deps` silently bypasses the allowlist (plan §5.4).
    const require = createRequire(import.meta.url);
    let quaisDetail = 'not resolvable';
    let quaisOk = false;
    try {
      // `quais` does not export ./package.json, so walk up from its entry point
      // rather than requiring the manifest by specifier.
      const entry = require.resolve('quais');
      const marker = `${sep}quais${sep}`;
      const rootIdx = entry.lastIndexOf(marker);
      const quaisPkg = JSON.parse(
        readFileSync(join(entry.slice(0, rootIdx + marker.length), 'package.json'), 'utf8'),
      ) as { version: string };
      const sdkPkg = require('@quaivault/sdk/package.json') as {
        peerDependencies?: Record<string, string>;
      };
      const range = sdkPkg.peerDependencies?.quais ?? '';
      const allowed = range.split('||').map((s) => s.trim()).filter(Boolean);
      quaisOk = allowed.length === 0 || allowed.includes(quaisPkg.version);
      quaisDetail = `${quaisPkg.version}${range ? ` — SDK allows ${range}` : ''}`;
    } catch {
      /* leave as not resolvable */
    }
    checks.push({
      name: 'quais',
      ok: quaisOk,
      detail: quaisDetail,
      advice: quaisOk
        ? undefined
        : 'The resolved quais is outside the range the SDK was tested against. Reinstall without --legacy-peer-deps.',
    });

    checks.push({ name: 'network', ok: true, detail: ctx.profile.network });
    checks.push({ name: 'rpc', ok: true, detail: redactUrl(ctx.profile.rpcUrl) });

    let indexerOk = false;
    let indexerDetail = 'unreachable';
    let chainHead: number | undefined;
    try {
      const health = await ctx.qv.indexerHealth();
      indexerOk = health.available;
      chainHead = health.chainHead;
      const behind = health.blocksBehind ?? 0;
      indexerDetail = health.available
        ? `live, ${behind} block${behind === 1 ? '' : 's'} behind (~${formatDuration(behind * SECONDS_PER_BLOCK)})`
        : 'unavailable';
    } catch (err) {
      indexerDetail = err instanceof Error ? err.message.slice(0, 80) : 'error';
    }
    checks.push({
      name: 'indexer',
      ok: indexerOk,
      detail: indexerDetail,
      advice: indexerOk ? undefined : 'Reads will fall back to the chain and may be incomplete.',
    });

    await detectSkew(ctx.qv, ctx.skew, ctx.identity());
    const skewOk = Math.abs(ctx.skew.offsetSeconds) < SKEW_WARN_THRESHOLD_SECONDS;
    checks.push({
      name: 'clock',
      ok: skewOk,
      detail: ctx.skew.detected
        ? `${ctx.skew.offsetSeconds >= 0 ? '+' : ''}${ctx.skew.offsetSeconds}s vs chain`
        : 'not measured',
      advice: skewOk
        ? undefined
        : 'Your clock is off. Timelock and expiry displays compensate, but elapsed-time behaviour (timeouts, polling) does not — fix the clock.',
    });

    checks.push({ name: 'config', ok: true, detail: configPath() });
    checks.push({
      name: 'policy',
      ok: true,
      detail: ctx.policy ? policyPath() : 'none (attended signing only)',
      advice: ctx.policy ? undefined : 'Non-interactive signing requires one: qv policy init',
    });
    checks.push({
      name: 'identity',
      ok: Boolean(ctx.identity()),
      detail: ctx.identity() ?? 'not set',
      advice: ctx.identity() ? undefined : 'qv use --as 0x…  (no key required)',
    });
    checks.push({ name: 'tty', ok: true, detail: canPrompt() ? 'available' : 'none (non-interactive)' });

    void chainHead;
    return { data: { checks, healthy: checks.every((c) => c.ok) }, changed: false };
  },

  render(result, io) {
    for (const c of result.data.checks) {
      const mark = c.ok ? io.paint(span('ok  ', 'ok')) : io.paint(span('warn', 'warn'));
      io.out(`  ${mark}  ${c.name.padEnd(10)} ${c.detail}`);
      if (c.advice) io.out(`        ${io.paint(span(c.advice, 'muted'))}`);
    }
  },
  toJson: (r) => ({
    healthy: r.data.healthy,
    checks: r.data.checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      detail: c.detail,
      advice: c.advice ?? null,
    })),
  }),
  outputSchema: {
    type: 'object',
    properties: { healthy: { type: 'boolean' }, checks: { type: 'array' } },
  },
};
