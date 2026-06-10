// @vitest-environment jsdom

// First-run guidance trail (home-hero/firstRunGuide.ts).
//
// A brand-new user (no projects, fresh storage) gets a sheen pulse on the
// Prototype type chip; picking any type chip advances the persisted stage
// so the first example card can pulse next, and the trail never replays.
// Users with existing projects have the trail completed silently.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import {
  readHomeGuideStage,
  writeHomeGuideStage,
} from '../../src/components/home-hero/firstRunGuide';

const SAMPLE_PROJECT = {
  id: 'p1',
  name: 'existing project',
  createdAt: 0,
  updatedAt: 0,
};

function stubPluginsFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (typeof url === 'string' && url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

function renderHome(projects: unknown[] = []) {
  return render(
    <I18nProvider initial="en">
      <HomeView
        projects={projects as never}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.localStorage.clear();
});

describe('Home first-run guide trail', () => {
  it('pulses the Prototype chip for a fresh user and advances on chip pick', async () => {
    stubPluginsFetch();
    renderHome([]);

    expect(readHomeGuideStage()).toBe('chip');
    const chip = await screen.findByTestId('home-hero-rail-prototype');
    await waitFor(
      () => {
        expect(chip.className).toContain('home-hero__attention-sheen');
      },
      { timeout: 3000 },
    );

    fireEvent.click(chip);
    expect(readHomeGuideStage()).not.toBe('chip');
    expect(chip.className).not.toContain('home-hero__attention-sheen');
  });

  it('completes the trail silently for users who already have projects', async () => {
    stubPluginsFetch();
    renderHome([SAMPLE_PROJECT]);

    await screen.findByTestId('home-hero-input');
    await waitFor(() => {
      expect(readHomeGuideStage()).toBe('done');
    });
    const chip = screen.queryByTestId('home-hero-rail-prototype');
    expect(chip?.className ?? '').not.toContain('home-hero__attention-sheen');
  });

  it('never replays once done', async () => {
    writeHomeGuideStage('done');
    stubPluginsFetch();
    renderHome([]);

    const chip = await screen.findByTestId('home-hero-rail-prototype');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(chip.className).not.toContain('home-hero__attention-sheen');
  });
});
