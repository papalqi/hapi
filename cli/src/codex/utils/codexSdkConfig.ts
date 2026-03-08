import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import type { McpServersConfig } from './buildHapiMcpBridge';
import { codexSystemPrompt } from './systemPrompt';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function resolveCodexPathOverride(): string | undefined {
    const envOverride = typeof process.env.HAPI_CODEX_PATH === 'string'
        ? process.env.HAPI_CODEX_PATH.trim()
        : '';
    if (envOverride.length > 0) {
        return envOverride;
    }

    const pathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : '';
    if (pathEnv.length === 0) {
        // Keep prior behavior on Windows: the global shim is typically `codex.cmd`.
        return process.platform === 'win32' ? 'codex.cmd' : undefined;
    }

    const candidates = process.platform === 'win32'
        ? ['codex.cmd', 'codex.exe', 'codex.bat', 'codex']
        : ['codex'];

    for (const entry of pathEnv.split(delimiter)) {
        const dir = entry.trim();
        if (dir.length === 0) continue;

        for (const candidateName of candidates) {
            const candidatePath = join(dir, candidateName);
            if (existsSync(candidatePath)) {
                return candidatePath;
            }
        }
    }

    if (process.platform === 'win32') {
        return 'codex.cmd';
    }

    // Non-Windows: fall back to Codex SDK's vendor discovery (via @openai/codex optional deps).
    return undefined;
}

function resolveApprovalPolicy(mode: EnhancedMode): CodexApprovalPolicy {
    switch (mode.permissionMode) {
        // Codex SDK currently does not expose an approval callback API that HAPI can bridge.
        // Use on-failure to keep remote turns non-blocking in SDK transport.
        case 'default': return 'on-failure';
        case 'read-only': return 'never';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'on-failure';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveSandbox(mode: EnhancedMode): CodexSandboxMode {
    switch (mode.permissionMode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveReasoningEffort(mode: EnhancedMode): CodexReasoningEffort | undefined {
    switch (mode.reasoningEffort) {
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
            return mode.reasoningEffort;
        default:
            return undefined;
    }
}

export function buildCodexSdkThreadOptions(args: {
    mode: EnhancedMode;
    cwd: string;
    cliOverrides?: CodexCliOverrides;
}): {
    model?: string;
    sandboxMode: CodexSandboxMode;
    approvalPolicy: CodexApprovalPolicy;
    modelReasoningEffort?: CodexReasoningEffort;
    workingDirectory: string;
    skipGitRepoCheck: boolean;
} {
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;

    const approvalPolicy = cliOverrides?.approvalPolicy ?? resolveApprovalPolicy(args.mode);
    const sandboxMode = cliOverrides?.sandbox ?? resolveSandbox(args.mode);
    const modelReasoningEffort = resolveReasoningEffort(args.mode);

    return {
        approvalPolicy,
        sandboxMode,
        workingDirectory: args.cwd,
        skipGitRepoCheck: true,
        ...(args.mode.model ? { model: args.mode.model } : {}),
        ...(modelReasoningEffort ? { modelReasoningEffort } : {})
    };
}

export function buildCodexSdkOptions(args: {
    mcpServers: McpServersConfig;
    developerInstructions?: string;
    collaborationMode?: string;
}): {
    codexPathOverride?: string;
    config: Record<string, unknown>;
} {
    const developerInstructions = args.developerInstructions
        ? `${codexSystemPrompt}\n\n${args.developerInstructions}`
        : codexSystemPrompt;

    const config: Record<string, unknown> = {
        mcp_servers: args.mcpServers,
        developer_instructions: developerInstructions
    };

    const collaborationMode = typeof args.collaborationMode === 'string'
        ? args.collaborationMode.trim()
        : '';
    if (collaborationMode.length > 0) {
        config.collaboration_mode = collaborationMode;
    }

    const codexPathOverride = resolveCodexPathOverride();

    return {
        ...(codexPathOverride ? { codexPathOverride } : {}),
        config
    };
}
