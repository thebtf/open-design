import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import type {
  AgentHealthCheckId,
  AgentHealthCheckResult,
  AgentHealthStatus,
} from '../types';
import { AgentDiagnosticRow } from './AgentDiagnosticRow';
import type { AgentFixHandlers } from './AgentDiagnosticRow';
import { Icon } from './Icon';
import styles from './AgentHealthCheckPanel.module.css';

interface Props {
  result: AgentHealthCheckResult;
  /** Wired per fix intent and forwarded to each diagnostic row's fix buttons. */
  handlers?: AgentFixHandlers;
  /** True while a (re-)run is in flight; disables the re-run button. */
  running?: boolean;
  onRerun?: () => void;
}

const OVERALL_KEY: Record<Exclude<AgentHealthStatus, 'skip'>, keyof Dict> = {
  pass: 'settings.healthcheck.overall.pass',
  warn: 'settings.healthcheck.overall.warn',
  fail: 'settings.healthcheck.overall.fail',
};

const CHECK_KEY: Record<AgentHealthCheckId, keyof Dict> = {
  detected: 'settings.healthcheck.check.detected',
  invocable: 'settings.healthcheck.check.invocable',
  authenticated: 'settings.healthcheck.check.authenticated',
  smoke: 'settings.healthcheck.check.smoke',
};

export function AgentHealthCheckPanel({ result, handlers = {}, running, onRerun }: Props) {
  const t = useT();
  return (
    <div className={styles.root} role="group" data-overall={result.overall}>
      <div className={styles.header}>
        <span className={styles.overall} data-status={result.overall}>
          <span className={styles.dot} data-status={result.overall} aria-hidden="true" />
          {t(OVERALL_KEY[result.overall])}
        </span>
        {onRerun ? (
          <button
            type="button"
            className={'ghost icon-btn ' + styles.rerun + (running ? ' loading' : '')}
            onClick={onRerun}
            disabled={running}
            title={t('settings.healthcheck.rerun')}
            aria-label={t('settings.healthcheck.rerun')}
          >
            <Icon
              name={running ? 'spinner' : 'reload'}
              size={13}
              className={running ? 'icon-spin' : undefined}
            />
          </button>
        ) : null}
      </div>
      <ul className={styles.checks}>
        {result.checks.map((check) => (
          <li key={check.id} className={styles.item} data-status={check.status}>
            <span className={styles.dot} data-status={check.status} aria-hidden="true" />
            <div className={styles.body}>
              <span className={styles.name}>{t(CHECK_KEY[check.id])}</span>
              {check.diagnostic ? (
                // Reuse the detection row so a failing step shows the same
                // Install / Docs / Rescan / Sign-in affordances as the
                // unavailable-agent grid — one source of truth for fixes.
                <AgentDiagnosticRow diagnostic={check.diagnostic} handlers={handlers} />
              ) : (
                // Daemon-authored specifics (path / version / latency) stay as a
                // muted technical detail; the localized name + status dot above
                // carry the meaning.
                <span className={styles.detail}>{check.label}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
