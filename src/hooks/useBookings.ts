// src/hooks/useBookings.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { Booking, generateSampleBookings } from '@/types/hotel';
import { differenceInCalendarDays, isBefore, parseISO, startOfDay } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from './useI18n';
import { supabase } from '@/integrations/supabase/client';

function isLegacySampleBooking(b: Booking): boolean { return /^b\d+$/.test(String(b.id)); }

function bookingHalfSpan(b: Booking): [number, number] {
  const base = startOfDay(parseISO('2000-01-01'));
  const inDay = differenceInCalendarDays(parseISO(b.checkIn), base);
  const outDay = differenceInCalendarDays(parseISO(b.checkOut), base);
  return [2 * inDay + 1 - (b.checkInHalfDay ? 1 : 0), 2 * outDay + 1 + (b.checkOutHalfDay ? 1 : 0)];
}

function bookingsConflict(a: Booking, b: Booking): boolean {
  if (a.id === b.id) return false;
  if (a.roomNumber !== b.roomNumber) return false;
  const roomWide = a.status === 'maintenance' || b.status === 'maintenance' || a.bedIndex === undefined || b.bedIndex === undefined;
  if (!roomWide) {
    const aBeds = new Set<number>([a.bedIndex as number, ...(a.additionalBeds ?? [])]);
    const bBeds = new Set<number>([b.bedIndex as number, ...(b.additionalBeds ?? [])]);
    let overlap = false;
    for (const bed of aBeds) if (bBeds.has(bed)) { overlap = true; break; }
    if (!overlap) return false;
  }
  const [as, ae] = bookingHalfSpan(a);
  const [bs, be] = bookingHalfSpan(b);
  return as < be && bs < ae;
}

function findConflict(list: Booking[], candidate: Booking): Booking | null {
  for (const b of list) if (bookingsConflict(b, candidate)) return b;
  return null;
}

function applyAutoCheckout(list: Booking[]): Booking[] {
  const today = startOfDay(new Date());
  let changed = false;
  const next = list.map((b) => {
    if (b.status !== 'in-house' && b.status !== 'confirmed' && b.status !== 'booked') return b;
    const out = startOfDay(parseISO(b.checkOut));
    if (isBefore(out, today)) { changed = true; return { ...b, status: 'checked-out' as const }; }
    return b;
  });
  return changed ? next : list;
}

export function useBookings() {
  const { t } = useI18n();
  const [map, setMap] = useState<Map<string, Booking>>(new Map());
  const [ready, setReady] = useState(false);
  const mapRef = useRef(map);
  mapRef.current = map;

  // Initial load + one-time sample seed if table is empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('bookings').select('data');
      if (cancelled) return;
      if (error) { console.error('[bookings] load', error); setReady(true); return; }
      const m = new Map<string, Booking>();
      for (const row of (data ?? []) as { data: Booking }[]) {
        const b = row.data;
        if (!b?.id || isLegacySampleBooking(b)) continue;
        m.set(b.id, b);
      }
      if (m.size === 0) {
        const seed = generateSampleBookings().filter((b) => !isLegacySampleBooking(b));
        if (seed.length) {
          const rows = seed.map((b) => ({ id: b.id, data: b }));
          const { error: insErr } = await supabase.from('bookings').insert(rows);
          if (!insErr) for (const b of seed) m.set(b.id, b);
          else console.error('[bookings] seed', insErr);
        }
      }
      setMap(new Map(m));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Realtime per-row sync.
  useEffect(() => {
    const channel = supabase
      .channel('bookings-rows')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' }, (payload) => {
        const row = payload.new as { id: string; data: Booking };
        if (!row?.data?.id) return;
        setMap((prev) => { const n = new Map(prev); n.set(row.id, row.data); return n; });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bookings' }, (payload) => {
        const row = payload.new as { id: string; data: Booking };
        if (!row?.data?.id) return;
        setMap((prev) => { const n = new Map(prev); n.set(row.id, row.data); return n; });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'bookings' }, (payload) => {
        const row = payload.old as { id: string };
        if (!row?.id) return;
        setMap((prev) => { if (!prev.has(row.id)) return prev; const n = new Map(prev); n.delete(row.id); return n; });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Daily auto-checkout: compute locally, then persist only rows that actually changed.
  useEffect(() => {
    if (!ready) return;
    const tick = async () => {
      const current = Array.from(mapRef.current.values());
      const updated = applyAutoCheckout(current);
      if (updated === current) return;
      const changes: Booking[] = [];
      for (let i = 0; i < updated.length; i++) {
        if (updated[i] !== current[i]) changes.push(updated[i]);
      }
      if (!changes.length) return;
      setMap((prev) => { const n = new Map(prev); for (const b of changes) n.set(b.id, b); return n; });
      for (const b of changes) {
        const { error } = await supabase.from('bookings').update({ data: b, updated_at: new Date().toISOString() }).eq('id', b.id);
        if (error) console.error('[bookings] auto-checkout', error);
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 60_000);
    return () => window.clearInterval(id);
  }, [ready]);

  const bookings = Array.from(map.values());

  const addBooking = useCallback((booking: Booking) => {
    if (!booking?.id || isLegacySampleBooking(booking)) return false;
    if (findConflict(Array.from(mapRef.current.values()), booking)) { toast.error(t('overlapError')); return false; }
    // Optimistic local insert
    setMap((prev) => { const n = new Map(prev); n.set(booking.id, booking); return n; });
    void (async () => {
      const { error } = await supabase.from('bookings').insert({ id: booking.id, data: booking });
      if (error) {
        console.error('[bookings] insert', error);
        setMap((prev) => { const n = new Map(prev); n.delete(booking.id); return n; });
        toast.error(t('overlapError'));
      }
    })();
    return true;
  }, [t]);

  const removeBooking = useCallback((id: string) => {
    const prev = mapRef.current.get(id);
    setMap((p) => { const n = new Map(p); n.delete(id); return n; });
    void (async () => {
      const { error } = await supabase.from('bookings').delete().eq('id', id);
      if (error) {
        console.error('[bookings] delete', error);
        if (prev) setMap((p) => { const n = new Map(p); n.set(id, prev); return n; });
      }
    })();
  }, []);

  const updateBooking = useCallback((id: string, updates: Partial<Booking>) => {
    const target = mapRef.current.get(id);
    if (!target) return false;
    const candidate: Booking = { ...target, ...updates };
    if (findConflict(Array.from(mapRef.current.values()), candidate)) { toast.error(t('overlapError')); return false; }
    setMap((prev) => { const n = new Map(prev); n.set(id, candidate); return n; });
    void (async () => {
      const { error } = await supabase
        .from('bookings')
        .update({ data: candidate, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        console.error('[bookings] update', error);
        setMap((prev) => { const n = new Map(prev); n.set(id, target); return n; });
        toast.error(t('overlapError'));
      }
    })();
    return true;
  }, [t]);

  return { bookings, addBooking, removeBooking, updateBooking };
}
