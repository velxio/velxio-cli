/**
 * Wire types of the CLI <-> API contract (PROTOCOL.md section 1). Field
 * names are the wire's; nothing here is renamed.
 */

export type WireFormat = 'hex' | 'bin' | 'esp-merged';

export type PlanStep =
  | { kind: 'delay'; us: number }
  | { kind: 'wait-serial'; text: string }
  | { kind: 'write-serial'; data_b64: string }
  | { kind: 'expect-pin'; part_id: string; pin: string; expected: 0 | 1 }
  | { kind: 'set-control'; part_id: string; control: string; value: number | string | boolean }
  | {
      kind: 'take-screenshot';
      part_id: string;
      name: string;
      compare_blob: string | null;
      tolerance_pct: number;
    };

export type ProjectBundle =
  | { kind: 'vlx'; payload: unknown }
  | { kind: 'wokwi'; diagram: unknown; files?: Record<string, string>; libraries_txt?: string };

export interface RunCreate {
  t: 'run.create';
  project: ProjectBundle;
  boards: Array<{ id: string; kind: string }>;
  primary_board_id: string;
  firmware: Array<{ board_id: string; blob: string; format: WireFormat }>;
  plan: PlanStep[];
  options: {
    timeout_ms: number;
    fail_text: string | null;
    interactive: boolean;
    project_name: string;
    source: 'cli' | 'action';
    allow_unsupported: boolean;
  };
}

export interface Hello {
  t: 'hello';
  proto: 1;
  cli_version: string;
  os: string;
  arch: string;
}

export interface BlobHeader {
  t: 'blob';
  name: string;
  size: number;
  sha256: string;
  chunks: number;
}

export type ClientMessage =
  | Hello
  | RunCreate
  | BlobHeader
  | { t: 'blobs.done' }
  | { t: 'serial.write'; board_id?: string; data_b64: string }
  | { t: 'run.cancel' }
  | { t: 'pong' };

export type RunStatus = 'passed' | 'failed' | 'timeout' | 'error' | 'cancelled' | 'lost';
export type RunState = 'queued' | 'loading' | 'running' | 'finishing';

export interface WarningMsg {
  t: 'warning';
  seq: number;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Welcome {
  t: 'welcome';
  seq: number;
  user: { id: string; email_masked: string };
  plan: string;
  minutes: { cap_ms: number; used_ms: number; remaining_ms: number; resets_at: string };
  limits: {
    max_firmware_bytes: number;
    max_blob_total_bytes: number;
    max_bundle_bytes: number;
    max_timeout_ms: number;
    concurrency: number;
    max_steps: number;
    max_screenshots: number;
  };
  min_cli_version: string;
  warnings: Array<{ code: string; message: string; detail?: unknown }>;
}

export interface RunRejected {
  t: 'run.rejected';
  seq: number;
  code: string;
  message: string;
  hints: string[];
  detail?: Record<string, unknown>;
}

export interface RunAccepted {
  t: 'run.accepted';
  seq: number;
  run_id: string;
  budget_ms: number;
  reserved_ms: number;
  queue_position: number;
  run_url: string;
}

export interface RunStateMsg {
  t: 'run.state';
  seq: number;
  state: RunState;
  sim_ms: number;
  wall_ms: number;
  queue_position?: number;
}

export interface SerialMsg {
  t: 'serial';
  seq: number;
  board_id: string;
  data_b64: string;
  sim_us: number;
}

export interface StepMsg {
  t: 'step';
  seq: number;
  index: number;
  kind: string;
  ok: boolean;
  sim_us: number;
  detail?: string;
}

export interface ScreenshotMsg {
  t: 'screenshot';
  seq: number;
  name: string;
  part_id: string;
  sim_us: number;
  size: number;
  kind: 'png' | 'diff';
}

export interface LogMsg {
  t: 'log';
  seq: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RunEnd {
  t: 'run.end';
  seq: number;
  status: RunStatus;
  reason: string;
  reason_detail?: string;
  exit_code: number;
  sim_ms: number;
  wall_ms: number;
  billed_ms: number;
  minutes_used_month_ms: number;
  minutes_cap_ms: number;
  run_url: string;
}

export interface ErrorMsg {
  t: 'error';
  seq: number;
  code: string;
  message: string;
}

export type ServerMessage =
  | Welcome
  | { t: 'ping'; seq: number }
  | RunRejected
  | RunAccepted
  | { t: 'blob.ack'; seq: number; name: string }
  | RunStateMsg
  | SerialMsg
  | StepMsg
  | ScreenshotMsg
  | WarningMsg
  | LogMsg
  | RunEnd
  | ErrorMsg;

export const SUBPROTOCOL = 'velxio-ci.v1';
export const WS_PATH = '/api/pro/ci/ws';
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;
export const BLOB_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
