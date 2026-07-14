import { describe, expect, it } from 'vitest';

import { composeSystemPrompt } from '../../src/prompts/system.js';
import { antigravityAgentDef } from '../../src/runtimes/defs/antigravity.js';

/**
 * Daemon-side mirror of the API-mode override fix for #313.
 *
 * The web-app/BYOK path goes through `@open-design/contracts`'s
 * `composeSystemPrompt`, which got the top-anchored fix first. But the
 * daemon has its own copy at `apps/daemon/src/prompts/system.ts`
 * (invoked by `apps/daemon/src/server.ts:6186-6193` for any agent whose
 * adapter declares `streamFormat: 'plain'` — e.g. DeepSeek). Without
 * mirroring the same fix here, plain-stream daemon agents still hit the
 * old bottom-appended `## API mode rule`, which sits BELOW
 * DISCOVERY_AND_PHILOSOPHY and therefore loses the precedence war
 * against the discovery layer's "TodoWrite on turn 3" hard rule.
 */

describe('daemon composeSystemPrompt — API mode (#313)', () => {
  describe('non-plain stream (no streamFormat)', () => {
    it('keeps the discovery layer TodoWrite hard rule (control)', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).toMatch(/TodoWrite/);
    });

    it('does not inject the API-mode preamble', () => {
      const prompt = composeSystemPrompt({});
      expect(prompt).not.toMatch(/API mode — no tools available/i);
    });
  });

  describe('plain stream (streamFormat: plain)', () => {
    it('injects the API-mode override section', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).toMatch(/API mode — no tools available/i);
    });

    it('pins the override above the discovery layer header', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      const overrideIdx = prompt.search(/API mode — no tools available/i);
      const discoveryIdx = prompt.indexOf('# OD core directives');
      expect(overrideIdx).toBeGreaterThanOrEqual(0);
      expect(discoveryIdx).toBeGreaterThanOrEqual(0);
      expect(overrideIdx).toBeLessThan(discoveryIdx);
    });

    it('drops the obsolete bottom "## API mode rule" section', () => {
      // The old append-at-end section is the precedence bug. With the
      // top-anchored override in place, the trailing section is dead
      // weight and must be removed so we have a single source of truth.
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).not.toMatch(/## API mode rule\n\nDo not emit tool_calls/);
    });

    it('names every tool the agent must not pretend to call', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).toMatch(/\bTodoWrite\b/);
      expect(prompt).toMatch(/\bRead\b/);
      expect(prompt).toMatch(/\bWrite\b/);
      expect(prompt).toMatch(/\bEdit\b/);
      expect(prompt).toMatch(/\bBash\b/);
      expect(prompt).toMatch(/\bWebFetch\b/);
    });

    it('forbids the pseudo-tool markup observed in #313', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).toMatch(/<todo-list>/);
      expect(prompt).toMatch(/\[读取/);
    });

    it('keeps tool-unavailable details out of user-visible prose', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).toContain('Do not mention tool unavailability to the user');
      expect(prompt).toContain('Avoid phrases such as "TodoWrite is unavailable"');
      expect(prompt).toContain('without mentioning missing tools');
    });

    it('still allows <artifact> output', () => {
      const prompt = composeSystemPrompt({ streamFormat: 'plain' });
      expect(prompt).toMatch(/<artifact>/);
    });

    it('omits the API-mode override for filesystem-capable plain runtimes', () => {
      const prompt = composeSystemPrompt({
        streamFormat: 'plain',
        executionProfile: 'filesystem',
      });
      expect(prompt).not.toMatch(/API mode — no tools available/i);
    });

    it('uses native tool vocabulary for the Antigravity filesystem path', () => {
      const prompt = composeSystemPrompt({
        streamFormat: antigravityAgentDef.streamFormat,
        executionProfile: antigravityAgentDef.executionProfile,
        promptToolVocabulary: antigravityAgentDef.promptToolVocabulary,
      });
      expect(prompt).not.toMatch(/API mode — no tools available/i);
      for (const toolName of [
        'TodoWrite',
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
      ]) {
        expect(prompt).not.toMatch(new RegExp(`\\b${toolName}\\b`));
      }
      expect(prompt).toContain('filesystem-backed project');
      expect(prompt).toContain("runtime's native tool-call interface");
      expect(prompt).toContain('This runtime owns its tool names');
    });

    it('keeps native filesystem semantics in the slim charter', () => {
      const prompt = composeSystemPrompt({
        streamFormat: antigravityAgentDef.streamFormat,
        executionProfile: antigravityAgentDef.executionProfile,
        promptToolVocabulary: antigravityAgentDef.promptToolVocabulary,
        promptCoreVariant: 'slim',
      });
      const nativeToolsIdx = prompt.indexOf('# Native runtime tools');
      const charterIdx = prompt.indexOf('# Open Design charter');

      expect(prompt).not.toMatch(/API mode — no tools available/i);
      expect(nativeToolsIdx).toBeGreaterThanOrEqual(0);
      expect(charterIdx).toBeGreaterThan(nativeToolsIdx);
      expect(prompt).toContain('filesystem-backed project');
      for (const toolName of ['TodoWrite', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']) {
        expect(prompt).not.toMatch(new RegExp(`\\b${toolName}\\b`));
      }
    });

    it('preserves injected memory copy in the slim native prompt', () => {
      const injectedCopy = 'Pre-Read: Read, Write, Edit, Bash, and Grep.';
      const prompt = composeSystemPrompt({
        streamFormat: antigravityAgentDef.streamFormat,
        executionProfile: antigravityAgentDef.executionProfile,
        promptToolVocabulary: antigravityAgentDef.promptToolVocabulary,
        promptCoreVariant: 'slim',
        memoryBody: `MEMORY ${injectedCopy}`,
      });

      expect(prompt).toContain(`MEMORY ${injectedCopy}`);
    });

    it('preserves injected copy while neutralizing only Open Design core instructions', () => {
      const injectedCopy = 'Pre-Read: Read, Write, Edit, Bash, and Grep.';
      const prompt = composeSystemPrompt({
        streamFormat: antigravityAgentDef.streamFormat,
        executionProfile: antigravityAgentDef.executionProfile,
        promptToolVocabulary: antigravityAgentDef.promptToolVocabulary,
        memoryBody: `MEMORY ${injectedCopy}`,
        userInstructions: `USER ${injectedCopy}`,
        projectInstructions: `PROJECT ${injectedCopy}`,
        designSystemTitle: `DESIGN TITLE ${injectedCopy}`,
        designSystemUsageMd: `DESIGN USAGE ${injectedCopy}`,
        designSystemBody: `DESIGN BODY ${injectedCopy}`,
        designSystemTokensCss: `:root { --copy: "${injectedCopy}"; }`,
        designSystemComponentsManifest: `MANIFEST ${injectedCopy}`,
        designSystemPullIndex: `PULL INDEX ${injectedCopy}`,
        craftSections: [`CRAFT SECTION ${injectedCopy}`],
        craftBody: `CRAFT BODY ${injectedCopy}`,
        skillName: `SKILL NAME ${injectedCopy}`,
        skillBody: `SKILL BODY ${injectedCopy}\nassets/template.html`,
        pluginBlock: `PLUGIN ${injectedCopy}`,
        activeStageBlocks: [`STAGE ${injectedCopy}`],
        metadata: {
          kind: 'template',
          examplePrompt: true,
          examplePromptTitle: `EXAMPLE TITLE ${injectedCopy}`,
          examplePromptBrief: { brief: `EXAMPLE BRIEF ${injectedCopy}` },
        },
        template: {
          name: `TEMPLATE ${injectedCopy}`,
          description: `TEMPLATE DESCRIPTION ${injectedCopy}`,
          files: [{ name: 'index.html', content: `<h1>${injectedCopy}</h1>` }],
        },
      });

      for (const expected of [
        `MEMORY ${injectedCopy}`,
        `USER ${injectedCopy}`,
        `PROJECT ${injectedCopy}`,
        `DESIGN TITLE ${injectedCopy}`,
        `DESIGN USAGE ${injectedCopy}`,
        `DESIGN BODY ${injectedCopy}`,
        `MANIFEST ${injectedCopy}`,
        `PULL INDEX ${injectedCopy}`,
        `CRAFT SECTION ${injectedCopy}`,
        `CRAFT BODY ${injectedCopy}`,
        `SKILL NAME ${injectedCopy}`,
        `SKILL BODY ${injectedCopy}`,
        `PLUGIN ${injectedCopy}`,
        `STAGE ${injectedCopy}`,
        `EXAMPLE TITLE ${injectedCopy}`,
        `EXAMPLE BRIEF ${injectedCopy}`,
        `TEMPLATE ${injectedCopy}`,
        `TEMPLATE DESCRIPTION ${injectedCopy}`,
        `<h1>${injectedCopy}</h1>`,
      ]) {
        expect(prompt).toContain(expected);
      }
      expect(prompt).toContain(':root { --copy: "Pre-Read: Read, Write, Edit, Bash, and Grep."; }');
      expect(prompt).toContain(
        '**Pre-flight (do this before any other tool):** read `assets/template.html`',
      );
      expect(prompt).not.toContain(
        '**Pre-flight (do this before any other tool):** Read `assets/template.html`',
      );
      expect(prompt).toContain('Output your task list plan and then the artifact immediately.');
      expect(prompt).not.toContain('Output your TodoWrite plan and then the artifact immediately.');
      expect(prompt).toContain('you still plan with task list');
      expect(prompt).not.toContain('you still plan with TodoWrite');
    });
  });
});
