// backend/booking/types/booking.types.ts
import type { ContactDetails } from '@wix/bookings';

export interface Addon {
  id: string;
  name: string;
  price: number;
  quantity?: number;
}

export interface BookingMeta {
  pairToken: string;
  uiPairToken: string;
  addons: Addon[];
  addonsTotal: number;
  resourceId: string | null;
  resourceFilterId: string | null;
  resourceFilterName: string;
  primaryServiceId: string;
  secondaryServiceId: string | null;
  traceId: string;
  esCombinado: boolean;
  dateYmd: string;
  serviceName: string;
  paymentStatus: 'UNPAID' | 'PENDING_PAYMENT' | 'CONFIRMED_UNPAID' | 'PAID';
  paymentMethod: 'ONLINE' | 'PRESENCIAL';
  auditedPrice: number;
  checkoutId?: string;
  bookingIdF2?: string | null;
}

export interface PersistBookingParams {
  bookingId: string;
  revision: number;
  serviceId: string;
  scheduleId: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
  contactDetails: ContactDetails;
  tipo: 'simple' | 'dual_fase1' | 'dual_fase2';
  meta: BookingMeta;
}

export interface PersistBookingResult {
  created: boolean;
  item: any;
}

export interface SlotResource {
  id: string;
  name?: string;
}

export interface CertifiedSlot {
  serviceId: string;
  scheduleId: string;
  resource: SlotResource;
  localStartDate: string;
  localEndDate: string;
  availableSpots?: number;
  bookedSpots?: number;
}

export interface DualSlotPair {
  slot1: CertifiedSlot;
  slot2: CertifiedSlot;
  pairToken: string;
  totalPrice: number;
}

export interface ResourceLoad {
  resourceId: string;
  loadScore: number;
  slotCount: number;
}

export interface BookingTrace {
  traceId: string;
  timestamp: string;
  action: string;
  details?: Record<string, any>;
}
