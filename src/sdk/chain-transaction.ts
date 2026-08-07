import {
  NotFoundError,
  decodeCall,
  deriveStatus,
  executableAfterOf,
  type ApprovalRecord,
  type VaultTransaction,
} from '@quaivault/sdk';
import { getAddress } from 'quais';
import type { AppContext } from '../context/context.js';

interface RawTransaction {
  to?: unknown;
  value?: unknown;
  data?: unknown;
  proposer?: unknown;
  timestamp?: unknown;
  expiration?: unknown;
  executionDelay?: unknown;
  approvedAt?: unknown;
  executed?: unknown;
  cancelled?: unknown;
}

interface ChainVaultContract {
  transactions(hash: string): Promise<RawTransaction>;
  getOwners(): Promise<unknown[]>;
  threshold(): Promise<unknown>;
  expiredTxs(hash: string): Promise<boolean>;
  hasApproved(hash: string, owner: string): Promise<boolean>;
}

/**
 * Read a proposal exclusively from the vault contract.
 *
 * The SDK's public `transaction()` intentionally prefers the indexer. That is
 * ideal for browsing but cannot authorize a signature. This adapter uses only
 * the SDK's public connection and ABI-backed contract, and mirrors the SDK's
 * canonical decoding/status helpers so disclosure stays consistent.
 */
export async function transactionFromChain(
  ctx: AppContext,
  address: string,
  hash: string,
): Promise<VaultTransaction> {
  const contract = ctx.qv.connection.vault(address) as unknown as ChainVaultContract;
  const [raw, owners, thresholdRaw, isExpired] = await Promise.all([
    contract.transactions(hash),
    contract.getOwners(),
    contract.threshold(),
    contract.expiredTxs(hash),
  ]);

  const toRaw = primitiveString(raw.to, '');
  if (!toRaw || /^0x0{40}$/i.test(toRaw)) {
    throw new NotFoundError(`No transaction ${hash} on vault ${address}.`);
  }

  const ownerList = owners.map((owner) => getAddress(String(owner)));
  const active = await Promise.all(ownerList.map((owner) => contract.hasApproved(hash, owner)));
  const approvals: ApprovalRecord[] = ownerList
    .map((owner, index) => ({ owner, active: active[index] === true }))
    .filter((approval) => approval.active);

  const to = getAddress(toRaw);
  const value = BigInt(primitiveString(raw.value, '0'));
  const data = primitiveString(raw.data, '0x');
  const expiration = Number(raw.expiration ?? 0);
  const executionDelay = Number(raw.executionDelay ?? 0);
  const approvedAt = Number(raw.approvedAt ?? 0);
  const threshold = Number(thresholdRaw);
  const decoded = decodeCall({
    vault: address,
    to,
    value,
    data,
    ...(ctx.qv.config.contracts.socialRecovery
      ? { socialRecovery: ctx.qv.config.contracts.socialRecovery }
      : {}),
    ...(ctx.qv.config.contracts.multiSendCallOnly
      ? { multiSendCallOnly: ctx.qv.config.contracts.multiSendCallOnly }
      : {}),
    ...(ctx.qv.abis ? { abis: ctx.qv.abis } : {}),
  });

  return {
    hash,
    vault: getAddress(address),
    to,
    value,
    data,
    proposer: getAddress(String(raw.proposer)),
    proposedAt: Number(raw.timestamp ?? 0),
    kind: decoded.kind,
    ...(decoded.decoded ? { decoded: decoded.decoded } : {}),
    summary: decoded.summary,
    abiSource: decoded.abiSource,
    status: deriveStatus(
      {
        executed: Boolean(raw.executed),
        cancelled: Boolean(raw.cancelled),
        isExpired,
        expiration,
        executionDelay,
        approvedAt,
        approvalCount: approvals.length,
        threshold,
      },
      ctx.now(),
    ),
    approvals,
    approvalCount: approvals.length,
    threshold,
    expiration,
    executionDelay,
    approvedAt,
    executableAfter: executableAfterOf(approvedAt, executionDelay),
    source: 'chain',
  };
}

/** Immutable identity of the operation a reviewer authorized. */
export function transactionFingerprint(tx: VaultTransaction): string {
  return [tx.hash, tx.vault, tx.to, tx.value.toString(10), tx.data].map((x) => x.toLowerCase()).join(':');
}

function primitiveString(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? value.toString()
    : fallback;
}
