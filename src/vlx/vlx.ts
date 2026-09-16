import { configError, type Warning } from '../errors.ts';
import { boardByKind, isReady, isSnapshotStale, notRunnableHints, type BoardCapability } from '../capabilities/index.ts';

/**
 * VlxPayload envelope as velxio/frontend/src/utils/vlxFile.ts writes it
 * (`format: "velxio-project"`, `version: 1`). Only the envelope is
 * validated; the runner page loads the rest verbatim.
 */
export interface VlxPayload {
  format: 'velxio-project';
  version: number;
  exportedAt?: string;
  name?: string;
  boards: Array<{ id: string; name?: string; boardKind: string; x: number; y: number; activeFileGroupId: string; [k: string]: unknown }>;
  fileGroups: Record<string, Array<{ name: string; content: string }>>;
  folderGroups?: Record<string, string[]>;
  components: Array<{ id: string; metadataId: string; [k: string]: unknown }>;
  wires: unknown[];
  activeBoardId: string | null;
}

export interface VlxBoard {
  id: string;
  kind: string;
  capability: BoardCapability | undefined;
}

export interface VlxAnalysis {
  boards: VlxBoard[];
  primaryBoardId: string;
  partIds: string[];
  warnings: Warning[];
}

export function parseVlx(text: string, file = 'project.vlx'): VlxPayload {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw configError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw configError(`${file}: expected a JSON object`);
  const d = doc as Record<string, unknown>;
  if (d.format !== 'velxio-project') throw configError(`${file}: format must be "velxio-project"`);
  if (d.version !== 1) throw configError(`${file}: version must be 1 (got ${JSON.stringify(d.version ?? null)})`);
  if (!Array.isArray(d.boards) || d.boards.length === 0) throw configError(`${file}: boards[] must list at least one board`);
  if (!d.fileGroups || typeof d.fileGroups !== 'object' || Array.isArray(d.fileGroups)) throw configError(`${file}: fileGroups must be an object`);
  if (!Array.isArray(d.components)) throw configError(`${file}: components must be an array`);
  if (!Array.isArray(d.wires)) throw configError(`${file}: wires must be an array`);
  if (d.activeBoardId !== null && d.activeBoardId !== undefined && typeof d.activeBoardId !== 'string') {
    throw configError(`${file}: activeBoardId must be a string or null`);
  }
  const ids = new Set<string>();
  d.boards.forEach((b, i) => {
    const row = (b ?? {}) as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) throw configError(`${file}: boards[${i}] has no id`);
    if (typeof row.boardKind !== 'string' || !row.boardKind) throw configError(`${file}: board "${row.id}" has no boardKind`);
    if (ids.has(row.id)) throw configError(`${file}: duplicate board id "${row.id}"`);
    ids.add(row.id);
  });
  d.components.forEach((c, i) => {
    const row = (c ?? {}) as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) throw configError(`${file}: components[${i}] has no id`);
    if (ids.has(row.id)) throw configError(`${file}: duplicate id "${row.id}"`);
    ids.add(row.id);
  });
  return d as unknown as VlxPayload;
}

export function analyseVlx(payload: VlxPayload, file = 'project.vlx'): VlxAnalysis {
  const warnings: Warning[] = [];
  const stale = isSnapshotStale();
  const boards: VlxBoard[] = payload.boards.map((b) => {
    const capability = boardByKind(b.boardKind);
    if (!capability) {
      const msg = `${file}: board "${b.id}" kind ${b.boardKind} is not in this CLI's board list`;
      if (stale) warnings.push({ code: 'unknown_board_type', message: `${msg}; the server decides` });
      else throw configError(msg, ['run `velxio-cli boards` for the supported kinds', 'or upgrade the CLI'], 'unknown_board_type');
    } else if (!isReady(capability)) {
      throw configError(
        `${file}: board "${b.id}" (${b.boardKind}) is not available in Velxio CI yet (supported in ${capability.supported_in ?? 'a later phase'})`,
        notRunnableHints(capability),
        'board_not_supported_in_ci',
      );
    }
    for (const code of capability?.warnings ?? []) {
      warnings.push({ code, message: `${file}: board "${b.id}" (${b.boardKind}): ${code}` });
    }
    return { id: b.id, kind: b.boardKind, capability };
  });
  const primary = payload.activeBoardId && boards.some((b) => b.id === payload.activeBoardId) ? payload.activeBoardId : boards[0]!.id;
  return {
    boards,
    primaryBoardId: primary,
    partIds: [...boards.map((b) => b.id), ...payload.components.map((c) => c.id)],
    warnings,
  };
}
