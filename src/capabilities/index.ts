import snapshotJson from './snapshot.json';
import type { WireFormat } from '../protocol/messages.ts';

/** Firmware family: decides the conversion and the wire format. */
export type Family = 'avr' | 'rp2040' | 'rp2350' | 'xiao-arm' | 'esp32' | 'stm32';

export type EspTarget = 'esp32' | 'esp32s2' | 'esp32c3' | 'esp32s3' | 'esp32c6' | 'esp32h2' | 'esp32p4' | 'esp32c5';

/** One row of GET /api/pro/ci/capabilities `boards[]`, as the server writes it. */
export interface BoardCapability {
  kind: string;
  label: string;
  family: Family;
  engine: string;
  wokwi_types: string[];
  formats: WireFormat[];
  /** `ready` runs in CI; anything else (`planned`) is refused with `supported_in`. */
  status: string;
  clock: 'sim' | 'none';
  supported_in: string | null;
  warnings: string[];
  /** ESP32 chip target; derived from the engine when the server omits it. */
  target?: EspTarget;
}

/**
 * src/capabilities/snapshot.json: the server's capabilities document copied
 * verbatim by scripts/update-snapshot.ts, plus the CLI-only keys
 * `generated_at`, `source` and `parts` (catalogue part ids).
 */
export interface Snapshot {
  generated_at: string;
  source: string;
  version: number;
  boards: BoardCapability[];
  /** Wokwi board type -> the closest Velxio kind to suggest, or "". */
  unsupported_wokwi_types: Record<string, string>;
  steps: string[];
  limits: Record<string, number>;
  min_cli_version: string;
  parts: string[];
}

export const snapshot = snapshotJson as unknown as Snapshot;

/**
 * Server limits (PROTOCOL.md 4.2) from the snapshot, over the CLI's own lint
 * caps for files the server never sees as such (diagram, scenario, PNG).
 */
export const LIMITS = {
  max_firmware_bytes: 16 * 1024 * 1024,
  max_blob_total_bytes: 20 * 1024 * 1024,
  max_bundle_bytes: 2 * 1024 * 1024,
  max_steps: 200,
  max_screenshots: 20,
  max_text_bytes: 512,
  max_parts: 300,
  max_wires: 2000,
  max_diagram_bytes: 2 * 1024 * 1024,
  max_scenario_bytes: 256 * 1024,
  max_png_bytes: 2 * 1024 * 1024,
  ...snapshot.limits,
};

export const FAMILY_FORMAT: Partial<Record<Family, WireFormat>> = {
  avr: 'hex',
  rp2040: 'bin',
  rp2350: 'bin',
  'xiao-arm': 'hex',
  esp32: 'esp-merged',
};

/** The in-browser ESP32 engines and the chip each one emulates. */
const ENGINE_TARGET: Record<string, EspTarget> = {
  esp32js: 'esp32',
  esp32s3js: 'esp32s3',
  esp32c3js: 'esp32c3',
  esp32c6js: 'esp32c6',
  esp32p4js: 'esp32p4',
};

/** Wokwi's own prefix for a Velxio board the OSS exporter wrote. */
export const VELXIO_BOARD_TYPE_PREFIX = 'board-velxio-';

const BY_KIND = new Map(snapshot.boards.map((b) => [b.kind, b]));
const BY_WOKWI_TYPE = new Map<string, BoardCapability>();
for (const b of snapshot.boards) for (const t of b.wokwi_types) BY_WOKWI_TYPE.set(t, b);
const PART_IDS = new Set(snapshot.parts);

export function boardByKind(kind: string): BoardCapability | undefined {
  return BY_KIND.get(kind);
}

export function isReady(board: BoardCapability): boolean {
  return board.status === 'ready';
}

export function readyBoards(): BoardCapability[] {
  return snapshot.boards.filter(isReady);
}

export function espTargetOf(board: BoardCapability): EspTarget | undefined {
  return board.target ?? ENGINE_TARGET[board.engine];
}

export type WokwiBoardResolution =
  | { kind: 'board'; boardKind: string; capability: BoardCapability | undefined }
  | { kind: 'unsupported'; type: string; suggest: string }
  | { kind: 'part' };

/**
 * What a Wokwi part type is to us: a board we know (possibly only through
 * the `board-velxio-` rule, in which case `capability` is undefined and the
 * server decides), a board we know we cannot run, or an ordinary part.
 */
export function resolveWokwiType(type: string): WokwiBoardResolution {
  const cap = BY_WOKWI_TYPE.get(type);
  if (cap) return { kind: 'board', boardKind: cap.kind, capability: cap };
  if (Object.hasOwn(snapshot.unsupported_wokwi_types, type)) {
    return { kind: 'unsupported', type, suggest: snapshot.unsupported_wokwi_types[type] ?? '' };
  }
  if (type.startsWith(VELXIO_BOARD_TYPE_PREFIX)) {
    const boardKind = type.slice(VELXIO_BOARD_TYPE_PREFIX.length);
    return { kind: 'board', boardKind, capability: BY_KIND.get(boardKind) };
  }
  return { kind: 'part' };
}

/**
 * Hints for a board CI cannot run. A suggested kind is only offered as
 * something to switch to when it is ready; a planned one is named with its
 * phase, and a kind this snapshot does not list is not suggested at all.
 */
export function notRunnableHints(board: BoardCapability | null, suggest = ''): string[] {
  const hints: string[] = [];
  if (board) hints.push(`${board.kind} (${board.label}) is planned for ${board.supported_in ?? 'a later phase'}`);
  if (suggest) {
    const s = BY_KIND.get(suggest);
    if (s && isReady(s)) hints.push(`the closest Velxio board that runs today is ${s.kind}: use ${s.wokwi_types[0] ?? VELXIO_BOARD_TYPE_PREFIX + s.kind}`);
    else if (s) hints.push(`the closest Velxio board, ${s.kind}, is planned for ${s.supported_in ?? 'a later phase'}`);
  }
  hints.push('`velxio-cli boards` lists the boards CI runs today');
  return hints;
}

/** The metadata id the OSS importer derives from a Wokwi part type. */
export function wokwiTypeToMetadataId(type: string): string {
  if (type === 'wokwi-breadboard-half') return 'breadboard';
  if (type.startsWith('wokwi-')) return type.slice(6);
  if (type.startsWith('board-')) return type.slice(6);
  return type;
}

export function isKnownPartType(type: string): boolean {
  if (type.startsWith('chip-')) return true;
  return PART_IDS.has(wokwiTypeToMetadataId(type));
}

/** Days since the snapshot was generated; unknown kinds are only a warning past 30. */
export function snapshotAgeDays(now = Date.now()): number {
  const t = Date.parse(snapshot.generated_at);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / 86_400_000;
}

export const SNAPSHOT_STALE_DAYS = 30;

export function isSnapshotStale(now = Date.now()): boolean {
  return snapshotAgeDays(now) > SNAPSHOT_STALE_DAYS;
}

export function wireFormatFor(family: Family): WireFormat | undefined {
  return FAMILY_FORMAT[family];
}
