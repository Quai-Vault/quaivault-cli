import { loadConfig } from '../context/config.js';
import { span } from '../format/tone.js';
import type { Io } from './io.js';

/**
 * Bare `qv`. State-aware, and always ends with something the user can paste.
 *
 * A forty-command help wall is the worst possible first impression, and the
 * property worth leading with is that reading needs no key at all.
 */
export function renderWelcome(io: Io, version: string): void {
  let hasIdentity = false;
  try {
    const config = loadConfig();
    const profile = config.profiles[config.defaultProfile];
    hasIdentity = Boolean(profile?.address);
  } catch {
    hasIdentity = false;
  }

  io.out(`QuaiVault ${version} — multisig vaults on Quai Network.`);
  io.out('');

  if (!hasIdentity) {
    io.out('Reading needs no key, no wallet, no account. Try it now:');
    io.out('');
    io.out(`  ${io.paint(span('qv vault show 0x005f2629A632962f4944d23686efDa5c160d535b', 'accent'))}`);
    io.out('');
    io.out('Then, to make it yours:');
    io.out('  qv use --as 0x<your-address>   see vaults you own — still no key');
    io.out('  qv key import                  add a key when you are ready to sign');
  } else {
    io.out('  qv inbox      what is waiting on you, across every vault');
    io.out('  qv status     network and indexer health');
  }
  io.out('');
  io.out('  qv --help     all commands        qv doctor    check your setup');
}
