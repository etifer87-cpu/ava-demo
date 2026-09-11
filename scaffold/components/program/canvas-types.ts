/**
 * canvas-types.ts - the plain, serialisable shape the builder canvas is given.
 *
 * The server page maps the program tree (lib/program/model.ts) into this and hands it to the
 * client canvas as props. Nothing here imports a server module, so the canvas - a client
 * component - stays on the right side of the access gate.
 */
export type CanvasKind = 'section' | 'exercise' | 'setup' | 'malfunction' | 'event' | 'note' | 'other';

export interface CanvasNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly kind: CanvasKind;
  readonly title: string;
  readonly phase: string | null;
  readonly phaseLabel: string | null;
  readonly phaseColour: string | null;
  readonly minutes: string | null;
  readonly trainingOnly: boolean;
  /** Short facts shown after the title: "PF CM2", "FPM · SAW", "graded", "3 failures · choose one". */
  readonly badges: readonly string[];
  readonly children: readonly CanvasNode[];
}

/** What the palette offers: the write path's PALETTE keys (lib/program/write.ts). */
export type PaletteKind = 'section' | 'exercise' | 'setup' | 'comms' | 'malfunction' | 'event' | 'note';

export interface PaletteItem {
  readonly kind: PaletteKind;
  readonly label: string;
  readonly hint: string;
}

export interface PresetItem {
  readonly code: string;
  readonly title: string;
  /** What the preset is: a block with children, or a saved exercise. */
  readonly kind: 'block' | 'exercise';
  readonly phase: string | null;
  readonly summary: string | null;
}

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  { kind: 'section',     label: 'Section',     hint: 'A phase of the day: EVAL 1, SBT 2, REINF. Top level only.' },
  { kind: 'exercise',    label: 'Exercise',    hint: 'What gets flown and graded: LOFT, V1 cut, crosswind landing.' },
  { kind: 'setup',       label: 'Set-up',      hint: 'Position, weather, mass, comms, reset, ATC script - rows you add.' },
  { kind: 'malfunction', label: 'Malfunction', hint: 'A failure of an aircraft component, searched by ATA, system or name.' },
  { kind: 'event',       label: 'Event',       hint: 'Everything else that happens to the crew: TCAS, windshear, an ATC call.' },
  { kind: 'note',        label: 'Note',        hint: 'Free text for the instructor. Inside a section or on its own.' },
  { kind: 'comms',       label: 'Comms',       hint: 'A set-up block that starts with one comms row.' },
];
