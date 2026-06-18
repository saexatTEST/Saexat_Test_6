// src/hooks/useGuestStore.ts
// Shared store for anketa forms + passport data, keyed by booking id.
// Backed by hotel_app_state via useSharedState (Realtime cross-browser sync).
import { useCallback, useEffect } from 'react';
import { useSharedState } from '@/lib/hotel-sync';

type AnyRecord = Record<string, unknown>;
type Store<T extends AnyRecord> = Record<string, T>;

/** Anketa forms keyed by booking.id */
export function useAnketaStore<T extends AnyRecord>() {
  const { data, setData, ready } = useSharedState<Store<T>>('guest-anketa' as any, {});

  const get = useCallback((bookingId: string): T | undefined => data?.[bookingId], [data]);
  const set = useCallback((bookingId: string, value: T) => {
    setData((prev) => ({ ...(prev ?? {}), [bookingId]: value }));
  }, [setData]);
  const remove = useCallback((bookingId: string) => {
    setData((prev) => {
      const next = { ...(prev ?? {}) };
      delete next[bookingId];
      return next;
    });
  }, [setData]);

  return { all: data ?? {}, get, set, remove, ready };
}

/** Passport data keyed by any string (booking id or legacy room key) */
export function usePassportStore<T extends AnyRecord>() {
  const { data, setData, ready } = useSharedState<Store<T>>('guest-passport' as any, {});

  const get = useCallback((key: string): T | undefined => data?.[key], [data]);
  const set = useCallback((key: string, value: T) => {
    setData((prev) => ({ ...(prev ?? {}), [key]: value }));
  }, [setData]);

  // Notify same-tab listeners (Anketa modal listens for this)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('sayohat-passport-changed'));
    }
  }, [data]);

  return { all: data ?? {}, get, set, ready };
}
