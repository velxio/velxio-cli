import { resolveServer } from '../credentials.ts';
import { snapshot, type BoardCapability } from '../capabilities/index.ts';
import { VERSION } from '../version.ts';
import type { Output } from '../ui/types.ts';
import { apiGet, makeRenderer, reportError, type CommonOptions } from './common.ts';

export interface BoardsOptions extends CommonOptions {
  offline?: boolean;
}

interface Capabilities {
  boards?: Array<Partial<BoardCapability> & { kind: string }>;
  generated_at?: string;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** GET /api/pro/ci/capabilities (public); `--offline` prints the built-in snapshot. */
export async function boardsCommand(opts: BoardsOptions, out: Output, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = makeRenderer(opts, out);
  try {
    let caps: Capabilities;
    let source: string;
    if (opts.offline) {
      caps = snapshot as unknown as Capabilities;
      source = `built-in snapshot (${snapshot.generated_at.slice(0, 10)})`;
    } else {
      const server = resolveServer(opts.server, env);
      caps = (await apiGet(server, '/api/pro/ci/capabilities', null, VERSION)) as Capabilities;
      source = server;
    }
    const boards = caps.boards ?? [];
    if (r.json) {
      r.info('', { t: 'boards', source, boards });
      return 0;
    }
    const rows: string[][] = [['KIND', 'LABEL', 'WOKWI TYPES', 'FORMATS', 'STATUS']];
    for (const b of boards) {
      const status = b.status === 'ready' || !b.supported_in ? b.status ?? '' : `${b.status} (${b.supported_in})`;
      rows.push([b.kind, b.label ?? '', (b.wokwi_types ?? []).join(', '), (b.formats ?? []).join(', '), status]);
    }
    r.info(table(rows));
    const ready = boards.filter((b) => b.status === 'ready').length;
    r.info(`\n${ready} of ${boards.length} boards ready from ${source}; any Velxio board also works as board-velxio-<kind> in diagram.json`);
    return 0;
  } catch (err) {
    return reportError(err, r);
  }
}
