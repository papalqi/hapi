/**
 * Cross-platform HAPI CLI spawning utility
 *
 * ## Background
 *
 * HAPI CLI runs in two modes:
 * 1. **Compiled binary**: A single executable built with `bun build --compile`
 * 2. **Development mode**: Running TypeScript directly via `bun`
 *
 * ## Execution Modes
 *
 * **Compiled Binary (Production):**
 * - The executable is self-contained and runs directly
 * - `process.execPath` points to the compiled binary itself
 * - No additional entrypoint needed - just pass args to `process.execPath`
 *
 * **Development Mode:**
 * - Running via `bun src/index.ts`
 * - Spawn child processes using the same runtime with `src/index.ts` entrypoint
 *
 * ## Cross-Platform Support
 *
 * This utility handles spawning HAPI CLI subprocesses (for runner processes)
 * in a cross-platform way, detecting the current runtime mode and using
 * the appropriate command and arguments.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join, resolve } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';

/**
 * Resolve the TypeScript entrypoint for development mode.
 */
function resolveEntrypoint(projectRoot: string): string {
  const srcEntrypoint = join(projectRoot, 'src', 'index.ts');
  if (existsSync(srcEntrypoint)) {
    return srcEntrypoint;
  }

  throw new Error('No CLI entrypoint found (expected src/index.ts)');
}

export interface HappyCliCommand {
  command: string;
  args: string[];
}

export function getHappyCliCommand(args: string[]): HappyCliCommand {
  // Compiled binary mode: just use the executable directly
  if (isBunCompiled()) {
    return {
      command: process.execPath,
      args
    };
  }

  // Development mode: spawn with TypeScript entrypoint
  const projectRoot = projectPath();
  const entrypoint = resolveEntrypoint(projectRoot);
  const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

  if (isBunRuntime) {
    // Bun can run TypeScript directly
    return {
      command: process.execPath,
      args: [entrypoint, ...args]
    };
  }

  // Node.js fallback: preserve execArgv (for compatibility)
  return {
    command: process.execPath,
    args: [...process.execArgv, entrypoint, ...args]
  };
}

export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }

  let desiredCwdForHapiProcess: string | undefined;
  if (typeof directory === 'string') {
    desiredCwdForHapiProcess = directory;
  }
  // Note: We're executing the current runtime with the calculated entrypoint path below,
  // bypassing the 'hapi' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'hapi' here because other engineers are typically looking
  // for when "hapi" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `hapi ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPI CLI] Spawning: ${fullCommand} in ${directory}`);
  
  const { command: spawnCommand, args: spawnArgs } = getHappyCliCommand(args);

  // Sanity check that the entrypoint path exists
  if (!isBunCompiled()) {
    const entrypoint = spawnArgs.find((arg) => arg.endsWith('index.ts'));
    if (entrypoint && !existsSync(entrypoint)) {
      const errorMessage = `Entrypoint ${entrypoint} does not exist`;
      logger.debug(`[SPAWN HAPI CLI] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  let finalOptions = options;

  if (!isBunCompiled()) {
    const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

    // Bun resolves tsconfig path aliases relative to the process cwd (defaults to $cwd/tsconfig.json).
    // When the runner spawns a session, it sets `cwd` to the target directory; that breaks `@/*` imports.
    // Workaround: spawn Bun from the CLI project root (so tsconfig.json is found) and pass the desired
    // session cwd via env (HAPI_SPAWN_CWD). Session launchers use it instead of process.cwd().
    if (isBunRuntime && desiredCwdForHapiProcess) {
      const projectRoot = projectPath();
      const normalizedDesired = resolve(desiredCwdForHapiProcess);
      const normalizedProjectRoot = resolve(projectRoot);
      const sameCwd = process.platform === 'win32'
        ? normalizedDesired.toLowerCase() === normalizedProjectRoot.toLowerCase()
        : normalizedDesired === normalizedProjectRoot;

      if (!sameCwd) {
        logger.debug(`[SPAWN HAPI CLI] Bun dev-mode cwd override: bunCwd=${normalizedProjectRoot}, hapiCwd=${normalizedDesired}`);
        finalOptions = {
          ...options,
          cwd: normalizedProjectRoot,
          env: {
            ...process.env,
            ...(options.env ?? {}),
            HAPI_SPAWN_CWD: normalizedDesired
          }
        };
      }
    }
  }
  
  return spawn(spawnCommand, spawnArgs, finalOptions);
}
