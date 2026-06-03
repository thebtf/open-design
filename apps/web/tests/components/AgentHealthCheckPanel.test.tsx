// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHealthCheckPanel } from '../../src/components/AgentHealthCheckPanel';
import type { AgentHealthCheckResult } from '../../src/types';
import { en } from '../../src/i18n/locales/en';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const healthy: AgentHealthCheckResult = {
  agentId: 'cursor-agent',
  agentName: 'Cursor Agent',
  available: true,
  version: '2026.05.07',
  overall: 'pass',
  checks: [
    { id: 'detected', status: 'pass', label: 'Cursor Agent found at /usr/local/bin/cursor-agent' },
    { id: 'invocable', status: 'pass', label: 'Runs OK (v2026.05.07)' },
    { id: 'authenticated', status: 'pass', label: 'Authenticated.' },
    { id: 'smoke', status: 'pass', label: 'Live reply OK (12ms).' },
  ],
  ranAt: new Date().toISOString(),
};

const broken: AgentHealthCheckResult = {
  agentId: 'gemini',
  agentName: 'Gemini',
  available: false,
  overall: 'fail',
  checks: [
    {
      id: 'detected',
      status: 'fail',
      label: 'Gemini (`gemini`) was not found on your PATH.',
      diagnostic: {
        reason: 'not-on-path',
        severity: 'error',
        message: 'Gemini (`gemini`) was not found on your PATH.',
        fixActions: [{ kind: 'rescan' }],
      },
    },
    { id: 'invocable', status: 'skip', label: 'Skipped — binary not found.' },
    { id: 'authenticated', status: 'skip', label: 'Skipped — agent not runnable.' },
    { id: 'smoke', status: 'skip', label: 'Skipped — agent not runnable.' },
  ],
  ranAt: new Date().toISOString(),
};

describe('AgentHealthCheckPanel', () => {
  it('tags the overall verdict and renders each check label', () => {
    render(<AgentHealthCheckPanel result={healthy} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('data-overall')).toBe('pass');
    expect(screen.getByText('Runs OK (v2026.05.07)')).toBeTruthy();
    expect(screen.getByText('Live reply OK (12ms).')).toBeTruthy();
  });

  it('renders a diagnostic row with its fix button for a failed step', () => {
    const onRescan = vi.fn();
    render(
      <AgentHealthCheckPanel result={broken} handlers={{ onRescan }} />,
    );
    // The failed `detected` step delegates to AgentDiagnosticRow, which exposes
    // the rescan affordance as an icon button named by its aria-label.
    const rescan = screen.getByRole('button', { name: en['settings.rescan'] });
    fireEvent.click(rescan);
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it('invokes onRerun from the re-run button', () => {
    const onRerun = vi.fn();
    render(<AgentHealthCheckPanel result={healthy} onRerun={onRerun} />);
    fireEvent.click(
      screen.getByRole('button', { name: en['settings.healthcheck.rerun'] }),
    );
    expect(onRerun).toHaveBeenCalledTimes(1);
  });
});
