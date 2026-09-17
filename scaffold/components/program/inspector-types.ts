/**
 * inspector-types.ts - the serialisable data the inspector pane is given by the page.
 * No server imports: the pane is a client component.
 */
import type { SectionContent, TaskContent, SetupContent, OptionGroupContent, NoteContent } from '@/lib/program/shape';

export type InspectorNode =
  | { readonly kind: 'section'; readonly key: string; readonly title: string; readonly content: SectionContent }
  | { readonly kind: 'exercise'; readonly key: string; readonly title: string; readonly content: TaskContent }
  | { readonly kind: 'setup'; readonly key: string; readonly title: string; readonly content: SetupContent }
  | { readonly kind: 'options'; readonly key: string; readonly title: string; readonly content: OptionGroupContent }
  | { readonly kind: 'note'; readonly key: string; readonly title: string; readonly content: NoteContent }
  | { readonly kind: 'other'; readonly key: string; readonly title: string; readonly elementType: string };

/** One observable behaviour of the active framework, as the inspector shows it under its competency. */
export interface BehaviourRow { readonly competency: string; readonly code: string; readonly text: string }

export interface MalfunctionRow { readonly code: string; readonly title: string; readonly ata: string | null; readonly system: string | null; readonly options: readonly string[] }
export interface EventRow { readonly code: string; readonly title: string; readonly category: string | null; readonly trigger: string | null }

export interface InspectorData {
  readonly node: InspectorNode | null;
  /** Position among siblings, for the move buttons. */
  readonly index: number;
  readonly siblingCount: number;
  readonly descendants: number;
  readonly editable: boolean;
  readonly vocab: { readonly sectionKinds: readonly string[]; readonly phases: readonly (readonly [string, string])[]; readonly pfSeats: readonly string[] };
  readonly competencies: readonly { readonly code: string; readonly name: string }[];
  /**
   * The observable behaviours of the active framework, flat and ordered, so the pane can list the
   * ones that belong to a ticked competency. Loaded with the competencies and for the same reason:
   * a program says which competencies an exercise targets, and the room asks what those mean.
   */
  readonly behaviours: readonly BehaviourRow[];
  readonly fleets: readonly { readonly code: string; readonly label: string }[];
  readonly programFleet: string | null;
  /** The malfunction index for the fleet the group is set to; empty when there is none for that type. */
  readonly malfunctions: readonly MalfunctionRow[];
  readonly events: readonly EventRow[];
  readonly groups: readonly { readonly code: string; readonly name: string; readonly candidates: readonly { readonly code: string; readonly title: string; readonly options: readonly string[] }[] }[];
}

export const EVENT_CATEGORIES = ['TCAS', 'Windshear', 'Weather change', 'ATC', 'Cabin / ground', 'Traffic', 'Other'] as const;
