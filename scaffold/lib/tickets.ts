/**
 * lib/tickets.ts - the tech-log vocabulary. Mirrors the CHECK constraints in migration 0143; a
 * value added here without a migration is rejected by the database, which is the intended order.
 */
export const TICKET_STATUSES = [
  { value: 'open', label: 'Open', tone: 'bad' },
  { value: 'in_progress', label: 'In progress', tone: 'warn' },
  { value: 'resolved', label: 'Resolved', tone: 'good' },
  { value: 'wont_fix', label: "Won't fix", tone: 'neutral' },
] as const;

export const TICKET_PRIORITIES = [
  { value: 'critical', label: 'Critical', tone: 'bad' },
  { value: 'high', label: 'High', tone: 'warn' },
  { value: 'medium', label: 'Medium', tone: 'info' },
  { value: 'low', label: 'Low', tone: 'neutral' },
] as const;

export const TICKET_CATEGORIES = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'data', label: 'Data looks wrong' },
  { value: 'access', label: 'Access or permissions' },
  { value: 'request', label: 'Request a change' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number]['value'];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]['value'];
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]['value'];

export const isStatus = (v: string): v is TicketStatus => TICKET_STATUSES.some((s) => s.value === v);
export const isPriority = (v: string): v is TicketPriority => TICKET_PRIORITIES.some((s) => s.value === v);
export const isCategory = (v: string): v is TicketCategory => TICKET_CATEGORIES.some((s) => s.value === v);

/** T-000123 */
export function ticketRef(n: number | string): string {
  return `T-${String(n).padStart(6, '0')}`;
}
