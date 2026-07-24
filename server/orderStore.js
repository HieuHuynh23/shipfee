'use strict';

/**
 * Order store helpers — local JSON cache + Supabase read-through.
 * Local remains the hot path; Supabase recovers orders missing after redeploy.
 */

const orderPersist = require('./orderPersist');

async function fetchOrderFromSupabase(supabase, id) {
  if (!supabase || !id) return null;
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn(`[OrderStore] fetch ${id}:`, error.message);
    return null;
  }
  return orderPersist.mapSupabaseOrderRow(data);
}

/**
 * Find order: local first, then Supabase. Optionally write-through into local cache.
 * @param {object} deps
 * @param {object|null} deps.supabase
 * @param {() => object[]} deps.readOrdersDatabase
 * @param {(fn: Function) => Promise<void>} [deps.updateOrdersDatabase]
 * @param {boolean} [deps.writeThrough=true]
 */
async function findOrderById(deps, id) {
  if (!id) return null;
  const { supabase, readOrdersDatabase, updateOrdersDatabase, writeThrough = true } = deps;
  const localList = readOrdersDatabase() || [];
  const local = localList.find((o) => o && o.id === id);
  if (local) return local;

  const remote = await fetchOrderFromSupabase(supabase, id);
  if (!remote) return null;

  if (writeThrough && typeof updateOrdersDatabase === 'function') {
    try {
      await updateOrdersDatabase((list) => {
        if (list.some((o) => o && o.id === id)) return false;
        list.push(remote);
      });
    } catch (e) {
      console.warn(`[OrderStore] cache write ${id}:`, e.message);
    }
  }
  return remote;
}

/** Ensure order exists in local file before mutation (accept/status/…). */
async function ensureOrderInLocalCache(deps, id) {
  const found = await findOrderById({ ...deps, writeThrough: true }, id);
  return !!found;
}

module.exports = {
  fetchOrderFromSupabase,
  findOrderById,
  ensureOrderInLocalCache
};
