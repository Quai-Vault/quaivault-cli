import type { BatchAnalysis } from '../abi/batch.js';
import type { Tone } from '../format/tone.js';

/**
 * Everything the TUI components are allowed to know.
 *
 * Deliberately **not** `AppContext`. `AppContext` carries `qv`, a live
 * `QuaiVaultClient`, and handing that to a React tree would mean the rule
 * "the TUI can do nothing the one-shot surface cannot" (§4.4) rested on
 * nobody ever typing `ctx.qv` inside a component. The lint boundary cannot
 * catch that — it bans *imports*, not property access on a value it was
 * handed.
 *
 * With this interface the guarantee is structural instead: the components
 * have no client, so they cannot read the chain, and no signer, so they
 * cannot sign. Every write leaves through `spawn`, which is argv going to a
 * fresh one-shot process.
 */
export interface TuiEnv {
  /** The address we are acting as. Display only. */
  identity: string;
  /** Reverse-resolve an address to a configured contact name. */
  contactName(address: string): string | undefined;
  /** Skew-adjusted seconds, for absolute comparisons against chain time. */
  now(): number;
  /** Terminal width, so panes can size themselves. */
  width: number;
}

/** Batch analysis is computed outside `tui/` and handed in as data. */
export type RowBatch = BatchAnalysis | null;

/**
 * Tone → Ink colour. The one place the mapping exists for this surface, the
 * mirror of `render/io.ts`'s picocolors mapping for the one-shot surface.
 */
export function toneColor(tone: Tone): string | undefined {
  switch (tone) {
    case 'ok':
      return 'green';
    case 'warn':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'accent':
      return 'cyan';
    case 'muted':
      return 'gray';
    case 'untrusted':
    case 'plain':
      return undefined;
    default: {
      const never: never = tone;
      throw new Error(`unhandled tone: ${String(never)}`);
    }
  }
}
