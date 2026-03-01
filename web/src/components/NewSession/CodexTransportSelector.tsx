import type { AgentType, CodexTransportType } from './types'
import { useTranslation } from '@/lib/use-translation'

const CODEX_TRANSPORT_OPTIONS: Array<{ value: CodexTransportType; labelKey: string }> = [
    { value: 'auto', labelKey: 'newSession.codexTransport.auto' },
    { value: 'app-server', labelKey: 'newSession.codexTransport.appServer' },
    { value: 'sdk', labelKey: 'newSession.codexTransport.sdk' },
    { value: 'mcp', labelKey: 'newSession.codexTransport.mcp' },
]

export function CodexTransportSelector(props: {
    agent: AgentType
    value: CodexTransportType
    isDisabled: boolean
    onChange: (value: CodexTransportType) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.codexTransport')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as CodexTransportType)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {CODEX_TRANSPORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                    </option>
                ))}
            </select>
        </div>
    )
}
