import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import type { McpServersConfig } from './buildHapiMcpBridge';
import { codexSystemPrompt } from './systemPrompt';

type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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
}): {
    codexPathOverride?: string;
    config: Record<string, unknown>;
} {
    const developerInstructions = args.developerInstructions
        ? `${codexSystemPrompt}\n\n${args.developerInstructions}`
        : codexSystemPrompt;

    return {
        // On Windows, Codex SDK's default binary discovery relies on @openai/codex optional deps
        // that may be unavailable in compiled single-file distributions.
        // Point explicitly to the globally installed CLI shim instead.
        ...(process.platform === 'win32' ? { codexPathOverride: 'codex.cmd' } : {}),
        config: {
            mcp_servers: args.mcpServers,
            developer_instructions: developerInstructions
        }
    };
}
