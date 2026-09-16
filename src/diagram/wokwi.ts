import { configError, type Warning } from '../errors.ts';
import { isKnownPartType, isReady, isSnapshotStale, LIMITS, notRunnableHints, resolveWokwiType, type BoardCapability } from '../capabilities/index.ts';

/**
 * Wokwi's diagram.json, read as-is. The shape follows
 * velxio/vscode-extension/schemas/diagram.schema.json (ours). The runner
 * page converts it with the OSS importer, so we only validate here.
 */
export interface WokwiPart {
  id: string;
  type: string;
  left?: number;
  top?: number;
  rotate?: number;
  hide?: boolean;
  attrs?: Record<string, string>;
}

export type WokwiConnection = [string, string, string?, string[]?];

export interface WokwiDiagram {
  version: number;
  author?: string;
  editor?: string;
  parts: WokwiPart[];
  connections: WokwiConnection[];
  serialMonitor?: { display?: string; newline?: string };
}

export interface DiagramBoard {
  id: string;
  kind: string;
  type: string;
  capability: BoardCapability | undefined;
}

export interface DiagramAnalysis {
  boards: DiagramBoard[];
  partIds: string[];
  warnings: Warning[];
}

/** Wokwi's pseudo parts (`$serialMonitor:RX`) are not in `parts[]`. */
function isPseudoPart(id: string): boolean {
  return id.startsWith('$');
}

export function parseDiagram(text: string, file = 'diagram.json'): WokwiDiagram {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw configError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw configError(`${file}: expected a JSON object`);
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) throw configError(`${file}: version must be 1 (got ${JSON.stringify(d.version ?? null)})`);
  if (!Array.isArray(d.parts)) throw configError(`${file}: parts must be an array`);
  if (!Array.isArray(d.connections)) throw configError(`${file}: connections must be an array`);

  const ids = new Set<string>();
  d.parts.forEach((p, i) => {
    if (!p || typeof p !== 'object') throw configError(`${file}: parts[${i}] is not an object`);
    const part = p as Record<string, unknown>;
    if (typeof part.id !== 'string' || !part.id) throw configError(`${file}: parts[${i}] has no id`);
    if (typeof part.type !== 'string' || !part.type) throw configError(`${file}: part "${part.id}" has no type`);
    if (ids.has(part.id)) throw configError(`${file}: duplicate part id "${part.id}"`);
    ids.add(part.id);
    if (part.attrs !== undefined && (typeof part.attrs !== 'object' || part.attrs === null || Array.isArray(part.attrs))) {
      throw configError(`${file}: part "${part.id}" attrs must be an object`);
    }
  });
  d.connections.forEach((c, i) => {
    if (!Array.isArray(c) || c.length < 2 || c.length > 4) {
      throw configError(`${file}: connections[${i}] must be [from, to, color, path]`);
    }
    for (const end of [c[0], c[1]]) {
      if (typeof end !== 'string' || !end) throw configError(`${file}: connections[${i}] endpoints must be "part:pin" strings`);
      const colon = end.indexOf(':');
      const partId = colon >= 0 ? end.slice(0, colon) : end;
      if (!ids.has(partId) && !isPseudoPart(partId)) {
        throw configError(`${file}: connections[${i}] refers to unknown part "${partId}"`);
      }
    }
  });
  if (d.parts.length > LIMITS.max_parts) throw configError(`${file}: ${d.parts.length} parts exceeds the limit of ${LIMITS.max_parts}`, [], 'too_many_parts');
  if (d.connections.length > LIMITS.max_wires) throw configError(`${file}: ${d.connections.length} connections exceeds the limit of ${LIMITS.max_wires}`, [], 'too_many_parts');
  return d as unknown as WokwiDiagram;
}

/**
 * Which parts are boards, which are ordinary parts, and what we cannot run.
 * Unknown-to-this-build boards are an error while the snapshot is fresh and
 * a "the server decides" warning once it is older than 30 days.
 */
export function analyseDiagram(diagram: WokwiDiagram, file = 'diagram.json'): DiagramAnalysis {
  const boards: DiagramBoard[] = [];
  const partIds: string[] = [];
  const warnings: Warning[] = [];
  const unknownTypes: string[] = [];
  const stale = isSnapshotStale();
  for (const p of diagram.parts) {
    partIds.push(p.id);
    const res = resolveWokwiType(p.type);
    if (res.kind === 'board') {
      if (!res.capability) {
        const msg = `${file}: board "${p.id}" (${p.type}) is not in this CLI's board list`;
        if (stale) warnings.push({ code: 'unknown_board_type', message: `${msg}; the server decides` });
        else throw configError(msg, ['run `velxio-cli boards` for the supported kinds', 'or upgrade the CLI'], 'unknown_board_type');
      } else if (!isReady(res.capability)) {
        throw configError(
          `${file}: board "${p.id}" of type ${p.type} is not available in Velxio CI yet (supported in ${res.capability.supported_in ?? 'a later phase'})`,
          notRunnableHints(res.capability),
          'board_not_supported_in_ci',
        );
      }
      boards.push({ id: p.id, kind: res.boardKind, type: p.type, capability: res.capability });
      for (const code of res.capability?.warnings ?? []) {
        warnings.push({ code, message: `${file}: board "${p.id}" (${res.boardKind}): ${describeBoardWarning(code)}` });
      }
    } else if (res.kind === 'unsupported') {
      throw configError(`${file}: board "${p.id}" of type ${p.type} has no Velxio simulation`, notRunnableHints(null, res.suggest), 'board_not_supported_in_ci');
    } else if (!isKnownPartType(p.type)) {
      unknownTypes.push(p.type);
      warnings.push({ code: 'part_unknown', message: `${file}: part "${p.id}" of type ${p.type} is unknown to this CLI; the server decides`, detail: { ids: [p.id] } });
    }
  }
  if (boards.length === 0) {
    const unknown = unknownTypes.length ? ` (types this CLI does not know: ${[...new Set(unknownTypes)].join(', ')})` : '';
    throw configError(`${file}: no board part found${unknown}`, [
      unknownTypes.length ? 'if one of those is your board, `velxio-cli boards` lists the supported types; or upgrade the CLI' : 'add a board part such as wokwi-arduino-uno or board-esp32-s3-devkitc-1',
    ]);
  }
  return { boards, partIds, warnings };
}

function describeBoardWarning(code: string): string {
  switch (code) {
    case 'no_network':
      return 'WiFi has no gateway in CI; network calls will fail';
    case 'feature_ignored':
      return 'a peripheral of this board is not simulated';
    default:
      return code;
  }
}
