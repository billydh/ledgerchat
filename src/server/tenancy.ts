/**
 * The request state the handlers share: the single database plus the
 * per-process flags they used to keep in closures, namely the conversations
 * currently generating and whether a categorise run is under way.
 */
import type { Db } from '../db/client.js';
import { recoverPendingChats } from '../db/repo.js';

export interface TenantState {
  /** Conversation ids with an answer being generated right now. */
  reservations: Set<string>;
  /** One categorise run at a time: two would fight over the description cache. */
  categorising: boolean;
}

export interface Tenant {
  db: Db;
  state: TenantState;
}

export function newTenantState(): TenantState {
  return { reservations: new Set(), categorising: false };
}

/**
 * Wraps an already open database as the only tenant, recovering chats that
 * were pending when the previous process stopped.
 */
export function singleTenant(db: Db): Tenant {
  recoverPendingChats(db);
  return { db, state: newTenantState() };
}

/** A resolver that answers every request with the same tenant. */
export function constantTenant(db: Db): () => Tenant {
  const tenant = singleTenant(db);
  return () => tenant;
}
