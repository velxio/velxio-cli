import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway project directory populated from a {path: content} map. */
export function tmpProject(files: Record<string, string | Uint8Array>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velxio-cli-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export function rmTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export const UNO_DIAGRAM = JSON.stringify({
  version: 1,
  parts: [
    { type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0, attrs: {} },
    { type: 'wokwi-led', id: 'led1', top: 0, left: 100, attrs: { color: 'red' } },
  ],
  connections: [['uno:13', 'led1:A', 'green', []]],
});
