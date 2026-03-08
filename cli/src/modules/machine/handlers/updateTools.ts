import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { logger } from '@/ui/logger'
import { getErrorMessage, rpcError } from '@/modules/common/rpcResponses'

type UpdateToolTarget = 'hapi' | 'codex' | 'claude'

type UpdateToolRequest = {
    tool: UpdateToolTarget
}

type UpdateToolResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

const updateToolRequestSchema = z.object({
    tool: z.enum(['hapi', 'codex', 'claude'])
})

const OUTPUT_LIMIT_CHARS = 200_000
const DEFAULT_TIMEOUT_MS = 15 * 60_000

function appendLimited(current: string, nextChunk: string): string {
    const combined = current + nextChunk
    if (combined.length <= OUTPUT_LIMIT_CHARS) {
        return combined
    }
    return combined.slice(combined.length - OUTPUT_LIMIT_CHARS)
}

async function runShellCommand(command: string, timeoutMs: number): Promise<UpdateToolResponse> {
    return await new Promise((resolve) => {
        logger.debug('[UPDATE] Running command', { command })

        const child = spawn(command, {
            shell: true,
            windowsHide: true,
            env: process.env
        })

        let stdout = ''
        let stderr = ''
        let finished = false
        let timedOut = false

        const timeout = setTimeout(() => {
            if (finished) return
            timedOut = true
            try {
                child.kill('SIGTERM')
            } catch {
                // ignore
            }
            setTimeout(() => {
                if (finished) return
                try {
                    child.kill('SIGKILL')
                } catch {
                    // ignore
                }
            }, 5_000)
        }, timeoutMs)

        child.stdout?.on('data', (chunk) => {
            stdout = appendLimited(stdout, chunk.toString())
        })

        child.stderr?.on('data', (chunk) => {
            stderr = appendLimited(stderr, chunk.toString())
        })

        child.on('error', (error) => {
            if (finished) return
            finished = true
            clearTimeout(timeout)
            resolve(rpcError(getErrorMessage(error, 'Failed to spawn update command'), {
                stdout,
                stderr,
                exitCode: 1
            }))
        })

        child.on('close', (code) => {
            if (finished) return
            finished = true
            clearTimeout(timeout)

            if (timedOut) {
                resolve(rpcError('Update command timed out', {
                    stdout,
                    stderr,
                    exitCode: -1
                }))
                return
            }

            const exitCode = typeof code === 'number' ? code : 0
            if (exitCode === 0) {
                resolve({ success: true, stdout, stderr, exitCode })
            } else {
                resolve(rpcError(`Update command failed (exit code ${exitCode})`, {
                    stdout,
                    stderr,
                    exitCode
                }))
            }
        })
    })
}

function resolveUpdateCommand(tool: UpdateToolTarget): string {
    const envOverride = tool === 'hapi'
        ? process.env.HAPI_UPDATE_HAPI_CMD
        : tool === 'codex'
            ? process.env.HAPI_UPDATE_CODEX_CMD
            : process.env.HAPI_UPDATE_CLAUDE_CMD

    if (envOverride && envOverride.trim().length > 0) {
        return envOverride.trim()
    }

    if (tool === 'hapi') {
        return 'npm install -g @papalqi/hapi@latest'
    }

    if (tool === 'codex') {
        return 'npm install -g @openai/codex@latest'
    }

    return 'npm install -g @anthropic-ai/claude-code@latest'
}

export function registerUpdateToolHandlers(rpcHandlerManager: RpcHandlerManager): void {
    let updateInFlight = false

    rpcHandlerManager.registerHandler<UpdateToolRequest, UpdateToolResponse>('update-tool', async (params) => {
        const parsed = updateToolRequestSchema.safeParse(params)
        if (!parsed.success) {
            return rpcError('Invalid update-tool request')
        }

        if (updateInFlight) {
            return rpcError('Another update is already running')
        }

        updateInFlight = true
        try {
            const command = resolveUpdateCommand(parsed.data.tool)
            return await runShellCommand(command, DEFAULT_TIMEOUT_MS)
        } finally {
            updateInFlight = false
        }
    })
}
