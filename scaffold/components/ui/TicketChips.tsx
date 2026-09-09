import Chip from './Chip';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '@/lib/tickets';

/** Status and priority as chips, with their word - colour never carries the meaning alone. */
export function StatusChip({ status }: { readonly status: string }) {
  const s = TICKET_STATUSES.find((x) => x.value === status);
  return <Chip tone={s?.tone ?? 'neutral'}>{s?.label ?? status}</Chip>;
}
export function PriorityChip({ priority }: { readonly priority: string }) {
  const p = TICKET_PRIORITIES.find((x) => x.value === priority);
  return <Chip tone={p?.tone ?? 'neutral'}>{p?.label ?? priority}</Chip>;
}
