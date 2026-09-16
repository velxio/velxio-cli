#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from 'commander';
import { EXIT } from './errors.ts';
import { VERSION } from './version.ts';
import { realOutput } from './ui/types.ts';
import { runCommand } from './commands/run.ts';
import { lintCommand } from './commands/lint.ts';
import { initCommand } from './commands/init.ts';
import { loginCommand } from './commands/login.ts';
import { whoamiCommand } from './commands/whoami.ts';
import { boardsCommand } from './commands/boards.ts';
import type { Session } from './client/ws.ts';

function intArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('expected an integer');
  return n;
}

function numArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InvalidArgumentError('expected a number');
  return n;
}

function common(cmd: Command): Command {
  return cmd
    .option('--json', 'one JSON object per line on stdout, nothing else')
    .option('-q, --quiet', 'no status lines; serial and errors only')
    .option('--token <token>', 'API token (vlxci_...); env VELXIO_CLI_TOKEN / VELXIO_CI_TOKEN')
    .option('--server <url>', 'API server (default https://velxio.dev); env VELXIO_CLI_SERVER');
}

function circuitFlags(cmd: Command): Command {
  return cmd
    .option('--elf <file>', 'firmware ELF to convert (AVR, RP2040/RP2350, XIAO)')
    .option('--firmware <file>', 'firmware image (.hex, .bin, .uf2, merged ESP32 image, flasher_args.json)')
    .option('--diagram-file <file>', 'Wokwi-format circuit (default diagram.json)')
    .option('--project-file <file>', 'Velxio .vlx project (wins over the diagram)')
    .option('--scenario <file>', 'scenario YAML')
    .option('--expect-text <text>', 'pass when this text appears on serial (a final wait-serial)')
    .option('--fail-text <text>', 'fail as soon as this text appears on any serial')
    .option('--screenshot-part <id>', 'take a screenshot of this part')
    .option('--screenshot-time <ms>', 'simulated time of the screenshot (ms)', numArg)
    .option('--screenshot-file <file>', 'where to save it (default screenshot.png)')
    .option('--screenshot-tolerance <pct>', 'compare-with tolerance in percent', numArg, 0.5);
}

async function exitWith(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
  process.exit(code);
}

async function* stdinChunks(): AsyncIterable<Uint8Array> {
  for await (const chunk of process.stdin) yield chunk as Uint8Array;
}

const program = new Command();
program
  .name('velxio-cli')
  .description('Run Velxio simulations from a terminal or a CI job')
  .version(VERSION, '-V, --version', 'print the version')
  .configureOutput({ writeErr: (s) => process.stderr.write(s) })
  .exitOverride();

const run = program.command('run [dir]', { isDefault: true }).description('run the project in <dir> (default .), stream serial, exit pass/fail');
common(circuitFlags(run))
  .option('--timeout <ms>', 'simulated-time budget in ms', intArg, 30000)
  .option('--timeout-exit-code <n>', 'exit code when the budget is reached', intArg, EXIT.TIMEOUT_DEFAULT)
  .option('--interactive', 'forward stdin to the primary board serial')
  .option('--serial-log-file <file>', 'write the serial the server relays (up to 4 MiB per run) to this file')
  .addOption(new Option('--vcd-file <file>', 'VCD trace (not supported yet)').hideHelp())
  .option('--allow-unsupported', 'turn degradable feature_unsupported rejections into warnings')
  .action(async (dir: string | undefined, opts) => {
    let session: Session | null = null;
    const onSigint = () => {
      if (session) session.cancel();
      else void exitWith(EXIT.INTERRUPT);
    };
    process.on('SIGINT', onSigint);
    const code = await runCommand(dir ?? '.', opts, {
      out: realOutput,
      stdin: opts.interactive ? stdinChunks() : null,
      stdinIsTTY: !!process.stdin.isTTY,
      onSession: (s) => (session = s),
    });
    process.off('SIGINT', onSigint);
    if (opts.interactive) {
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {
        // already closed
      }
    }
    await exitWith(code);
  });

const lint = program.command('lint [dir]').description('validate config, circuit, scenario and firmware locally (no network, no token)');
common(circuitFlags(lint)).action(async (dir: string | undefined, opts) => {
  await exitWith(lintCommand(dir ?? '.', opts, realOutput));
});

common(program.command('init [dir]').description('write velxio.toml and a diagram.json with one board'))
  .option('--board <kind>', 'board kind (default arduino-uno)')
  .option('--force', 'overwrite existing files')
  .action(async (dir: string | undefined, opts) => {
    await exitWith(initCommand(dir ?? '.', opts, realOutput));
  });

common(program.command('login').description('store a token in $XDG_CONFIG_HOME/velxio/credentials (env and --token win)')).action(async (opts) => {
  const readLine = async (): Promise<string | null> => {
    for await (const chunk of process.stdin) {
      const text = Buffer.from(chunk as Uint8Array).toString('utf8');
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(0, nl) : text;
    }
    return null;
  };
  await exitWith(await loginCommand(opts, { out: realOutput, readLine }));
});

common(program.command('whoami').description('plan, minutes used and left, limits')).action(async (opts) => {
  await exitWith(await whoamiCommand(opts, realOutput));
});

common(program.command('boards').description('supported boards, Wokwi types, formats, status'))
  .option('--offline', 'print the built-in snapshot instead of asking the server')
  .action(async (opts) => {
    await exitWith(await boardsCommand(opts, realOutput));
  });

program
  .command('version')
  .description('print the version')
  .action(async () => {
    process.stdout.write(`velxio-cli ${VERSION}\n`);
    await exitWith(0);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const e = err as { code?: string; exitCode?: number; message?: string };
  if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') await exitWith(0);
  await exitWith(e.exitCode === 0 ? 0 : EXIT.CONFIG);
}
