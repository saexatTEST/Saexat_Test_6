import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { ROOM_CATEGORIES, ROOMS_PER_CATEGORY, type Room, type RoomCategory } from '@/types/hotel';
import { useSharedState } from '@/lib/hotel-sync';

export interface CategoryDef {
  id: string;
  label: Record<string, string>;
  short: string;
  maxGuests: number;
  custom?: boolean;
}

export interface CategoryRate {
  resident: number[];
  nonResident: number[];
}

export type Residency = 'resident' | 'nonResident';

export function normalizeRate(raw: unknown, maxGuests = 1): CategoryRate {
  const slots = Math.max(1, Math.floor(maxGuests || 1));
  const toArr = (v: unknown): number[] => {
    if (Array.isArray(v)) {
      const arr = v.map((x) => Math.max(0, Number(x) || 0));
      if (arr.length >= slots) return arr.slice(0, slots);
      const fill = arr[arr.length - 1] ?? 0;
      return [...arr, ...Array.from({ length: slots - arr.length }, () => fill)];
    }
    const n = Math.max(0, Number(v) || 0);
    return Array.from({ length: slots }, () => n);
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { resident?: unknown; nonResident?: unknown };
    return { resident: toArr(r.resident), nonResident: toArr(r.nonResident) };
  }
  const arr = toArr(raw);
  return { resident: arr, nonResident: [...arr] };
}

export function perNightFor(arr: number[] | undefined, guestCount: number): number {
  if (!arr || arr.length === 0) return 0;
  const n = Math.max(0, Math.floor(guestCount || 0));
  if (n === 0) return 0;
  const maxG = arr.length;
  const within = Math.min(n, maxG);
  const base = Number(arr[within - 1]) || 0;
  const extras = Math.max(0, n - maxG);
  const extraRate = Number(arr[0]) || 0;
  return base + extras * extraRate;
}

export function sumRate(rates: Record<string, CategoryRate>, categoryId: string | undefined, residency: Residency, guestCount: number): number {
  if (!categoryId) return 0;
  const r = rates[categoryId];
  if (!r) return 0;
  return perNightFor(r[residency] ?? [], guestCount);
}

export function pickRate(rates: Record<string, CategoryRate>, categoryId: string | undefined, residency: Residency = 'resident', guestIndex = 0): number {
  if (!categoryId) return 0;
  const r = rates[categoryId];
  if (!r) return 0;
  const arr = r[residency] ?? [];
  return Number(arr[guestIndex]) || 0;
}

interface GridState {
  extraCategories: CategoryDef[];
  removedCategoryIds: string[];
  removedRoomNumbers: number[];
  extraRooms: Room[];
  categoryRates: Record<string, CategoryRate>;
}

const INITIAL: GridState = {
  extraCategories: [],
  removedCategoryIds: [],
  removedRoomNumbers: [],
  extraRooms: [],
  categoryRates: {},
};

interface Ctx {
  categories: CategoryDef[];
  rooms: Room[];
  categoryRates: Record<string, CategoryRate>;
  addCategory: (input: { name: string; short: string; maxGuests: number }) => void;
  removeCategory: (id: string) => void;
  addRoom: (categoryId: string, roomNumber: number) => { ok: boolean; reason?: 'exists' | 'invalid' };
  removeRoom: (roomNumber: number) => void;
  setCategoryRate: (categoryId: string, rate: CategoryRate) => void;
}

const HotelGridContext = createContext<Ctx | null>(null);

export function HotelGridProvider({ children }: { children: React.ReactNode }) {
  const baseCategories = useMemo<CategoryDef[]>(
    () => ROOM_CATEGORIES.map((c) => ({ id: c.id, label: c.label, short: c.short, maxGuests: c.maxGuests })),
    [],
  );

  const baseRooms = useMemo<Room[]>(() => {
    const rooms: Room[] = [];
    let floor = 1;
    ROOM_CATEGORIES.forEach((cat) => {
      for (let i = 1; i <= ROOMS_PER_CATEGORY; i++) rooms.push({ number: floor * 100 + i, category: cat.id });
      floor++;
    });
    return rooms;
  }, []);

  const { data, setData } = useSharedState<GridState>('grid', INITIAL);

  const removedCategoryIds = useMemo(() => new Set(data.removedCategoryIds ?? []), [data.removedCategoryIds]);
  const removedRoomNumbers = useMemo(() => new Set(data.removedRoomNumbers ?? []), [data.removedRoomNumbers]);

  const categories = useMemo(
    () => [...baseCategories, ...(data.extraCategories ?? [])].filter((c) => !removedCategoryIds.has(c.id)),
    [baseCategories, data.extraCategories, removedCategoryIds],
  );

  const rooms = useMemo<Room[]>(() => {
    const visibleBase = baseRooms.filter((r) => !removedRoomNumbers.has(r.number) && !removedCategoryIds.has(r.category));
    const merged = [...visibleBase, ...(data.extraRooms ?? []).filter((r) => !removedCategoryIds.has(r.category))];
    return merged.sort((a, b) => a.number - b.number);
  }, [baseRooms, removedRoomNumbers, data.extraRooms, removedCategoryIds]);

  const categoryRates = useMemo(() => {
    const knownMax = new Map<string, number>();
    baseCategories.forEach((c) => knownMax.set(c.id, c.maxGuests));
    (data.extraCategories ?? []).forEach((c) => knownMax.set(c.id, c.maxGuests));
    const out: Record<string, CategoryRate> = {};
    for (const [k, v] of Object.entries(data.categoryRates ?? {})) out[k] = normalizeRate(v, knownMax.get(k) ?? 1);
    return out;
  }, [baseCategories, data.extraCategories, data.categoryRates]);

  const addCategory = useCallback(({ name, short, maxGuests }: { name: string; short: string; maxGuests: number }) => {
    const id = `custom-${Date.now()}`;
    setData((prev) => ({
      ...prev,
      extraCategories: [
        ...(prev.extraCategories ?? []),
        {
          id,
          custom: true,
          short: short.trim() || name.slice(0, 6).toUpperCase(),
          maxGuests: Math.max(1, Math.floor(maxGuests || 1)),
          label: { ru: name, uz: name, en: name },
        },
      ],
    }));
  }, [setData]);

  const removeCategory = useCallback((id: string) => {
    setData((prev) => ({
      ...prev,
      removedCategoryIds: Array.from(new Set([...(prev.removedCategoryIds ?? []), id])),
      extraCategories: (prev.extraCategories ?? []).filter((c) => c.id !== id),
      extraRooms: (prev.extraRooms ?? []).filter((r) => r.category !== id),
    }));
  }, [setData]);

  const addRoom = useCallback((categoryId: string, roomNumber: number) => {
    if (!Number.isFinite(roomNumber) || roomNumber <= 0) return { ok: false, reason: 'invalid' as const };
    const allNumbers = new Set([...baseRooms.map((r) => r.number), ...(data.extraRooms ?? []).map((r) => r.number)]);
    if (allNumbers.has(roomNumber) && !removedRoomNumbers.has(roomNumber)) return { ok: false, reason: 'exists' as const };
    setData((prev) => ({
      ...prev,
      extraRooms: [...(prev.extraRooms ?? []), { number: roomNumber, category: categoryId as RoomCategory }],
      removedRoomNumbers: (prev.removedRoomNumbers ?? []).filter((n) => n !== roomNumber),
    }));
    return { ok: true };
  }, [baseRooms, data.extraRooms, removedRoomNumbers, setData]);

  const removeRoom = useCallback((roomNumber: number) => {
    setData((prev) => ({
      ...prev,
      extraRooms: (prev.extraRooms ?? []).filter((r) => r.number !== roomNumber),
      removedRoomNumbers: Array.from(new Set([...(prev.removedRoomNumbers ?? []), roomNumber])),
    }));
  }, [setData]);

  const setCategoryRate = useCallback((categoryId: string, rate: CategoryRate) => {
    const maxG = baseCategories.find((c) => c.id === categoryId)?.maxGuests
      ?? (data.extraCategories ?? []).find((c) => c.id === categoryId)?.maxGuests
      ?? Math.max(rate.resident?.length ?? 0, rate.nonResident?.length ?? 0, 1);
    setData((prev) => ({
      ...prev,
      categoryRates: { ...(prev.categoryRates ?? {}), [categoryId]: normalizeRate(rate, maxG) },
    }));
  }, [baseCategories, data.extraCategories, setData]);

  const value: Ctx = { categories, rooms, categoryRates, addCategory, removeCategory, addRoom, removeRoom, setCategoryRate };
  return <HotelGridContext.Provider value={value}>{children}</HotelGridContext.Provider>;
}

export function useHotelGrid() {
  const ctx = useContext(HotelGridContext);
  if (!ctx) throw new Error('useHotelGrid must be used inside HotelGridProvider');
  return ctx;
}
