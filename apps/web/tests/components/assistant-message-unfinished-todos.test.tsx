// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { AgentEvent, ChatMessage, ProjectFile } from '../../src/types';

function messageWithEvents(events: AgentEvent[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    events,
    startedAt: 1_000,
    endedAt: 3_000,
  };
}

function workspaceFile(name: string): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1700000000,
    kind: name.endsWith('.json') ? 'code' : 'text',
    mime: name.endsWith('.json') ? 'application/json' : 'text/plain',
  };
}

describe('AssistantMessage unfinished todo state', () => {
  afterEach(() => cleanup());

  it('keeps Done for a completed latest TodoWrite fixture', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Ship layout', status: 'completed' }] },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByText('Stopped with unfinished work')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue remaining tasks' })).toBeNull();
  });

  it('shows unfinished state and passes unfinished todos to the continue callback', () => {
    const onContinue = vi.fn();
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Draft layout', status: 'completed' },
                {
                  content: 'Build components',
                  status: 'in_progress',
                  activeForm: 'Building components',
                },
                { content: 'Run QA', status: 'pending' },
              ],
            },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
        onContinueRemainingTasks={onContinue}
      />,
    );

    expect(screen.getByText('Stopped with unfinished work')).toBeTruthy();
    expect(screen.getByText('2 task(s) remain')).toBeTruthy();
    const remainingList = screen.getByText('2 task(s) remain').closest('.unfinished-todos');
    expect(remainingList).not.toBeNull();
    expect(within(remainingList as HTMLElement).getByText('Building components')).toBeTruthy();
    expect(within(remainingList as HTMLElement).getByText('Run QA')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue remaining tasks' }));

    expect(onContinue).toHaveBeenCalledWith([
      {
        content: 'Build components',
        status: 'in_progress',
        activeForm: 'Building components',
      },
      { content: 'Run QA', status: 'pending', activeForm: undefined },
    ]);
  });

  it('hides the continue button on older assistant turns', () => {
    render(
      <AssistantMessage
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Run QA', status: 'pending' }] },
          },
        ])}
        streaming={false}
        projectId="project-1"
        isLast={false}
        onContinueRemainingTasks={vi.fn()}
      />,
    );

    expect(screen.getByText('Stopped with unfinished work')).toBeTruthy();
    expect(screen.getByText('1 task(s) remain')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue remaining tasks' })).toBeNull();
  });

  it('surfaces generated plugin next actions in the latest assistant turn', () => {
    const onOpen = vi.fn();
    render(
      <AssistantMessage
        message={{
          ...messageWithEvents([
            {
              kind: 'tool_use',
              id: 'write-manifest',
              name: 'Write',
              input: { path: 'generated-plugin/open-design.json' },
            },
            {
              kind: 'tool_result',
              toolUseId: 'write-manifest',
              content: 'ok',
              isError: false,
            },
          ]),
          content: 'Generated `generated-plugin/` and it is ready.',
        }}
        streaming={false}
        projectId="project-1"
        projectFiles={[
          workspaceFile('generated-plugin/open-design.json'),
          workspaceFile('generated-plugin/SKILL.md'),
          workspaceFile('generated-plugin/examples/demo.md'),
        ]}
        onRequestOpenFile={onOpen}
        isLast
      />,
    );

    expect(screen.getByText('Plugin ready')).toBeTruthy();
    expect(screen.getByTestId('assistant-plugin-install-generated-plugin')).toBeTruthy();
    expect(screen.getByTestId('assistant-plugin-publish-generated-plugin')).toBeTruthy();
    expect(screen.getByTestId('assistant-plugin-contribute-generated-plugin')).toBeTruthy();

    fireEvent.click(screen.getByTestId('assistant-plugin-open-manifest-generated-plugin'));
    expect(onOpen).toHaveBeenCalledWith('generated-plugin/open-design.json');
  });
});
