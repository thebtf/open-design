// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
} from '../../../src/components/composer/LexicalComposerInput';
import type { InlineMentionEntity } from '../../../src/utils/inlineMentions';

const FILE_ENTITY: InlineMentionEntity = {
  id: 'designs/landing.html',
  kind: 'file',
  label: 'designs/landing.html',
  token: '@designs/landing.html',
};

afterEach(() => {
  cleanup();
});

function setup(overrides: Partial<React.ComponentProps<typeof LexicalComposerInput>> = {}) {
  const ref = createRef<LexicalComposerInputHandle>();
  const onChange = vi.fn();
  const onTrigger = vi.fn();
  const onEnterSend = vi.fn();
  const onPopoverKey = vi.fn(() => true);
  render(
    <LexicalComposerInput
      ref={ref}
      placeholder="Type here"
      knownEntities={[FILE_ENTITY]}
      onChange={onChange}
      onTrigger={onTrigger}
      onEnterSend={onEnterSend}
      popoverOpen={false}
      onPopoverKey={onPopoverKey}
      {...overrides}
    />,
  );
  const input = screen.getByTestId('chat-composer-input');
  return { ref, input, onChange, onTrigger, onEnterSend, onPopoverKey };
}

describe('LexicalComposerInput', () => {
  it('imperative setText / getText round-trips an atomic mention', () => {
    const { ref } = setup();
    ref.current?.setText('Use @designs/landing.html now');
    expect(ref.current?.getText()).toBe('Use @designs/landing.html now');
    const pill = document.querySelector('.composer-inline-mention');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('@designs/landing.html');
    expect(pill?.getAttribute('data-mention-kind')).toBe('file');
  });

  it('sends on plain Enter and inserts a line break on Shift+Enter', () => {
    const { input, onEnterSend, ref } = setup();
    ref.current?.setText('hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnterSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    // Shift+Enter must NOT send.
    expect(onEnterSend).toHaveBeenCalledTimes(1);
  });

  it('does not send on Enter mid-IME-composition (issue #2851 shield)', () => {
    const { input, onEnterSend } = setup();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnterSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnterSend).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter force-sends even while the popover is open', () => {
    const { input, onEnterSend, onPopoverKey } = setup({ popoverOpen: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onEnterSend).toHaveBeenCalledTimes(1);
    expect(onPopoverKey).not.toHaveBeenCalled();
  });

  it('routes ArrowDown / Tab / Enter to the popover when open', () => {
    const { input, onPopoverKey, onEnterSend } = setup({ popoverOpen: true });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPopoverKey).toHaveBeenCalledWith('ArrowDown');
    expect(onPopoverKey).toHaveBeenCalledWith('Tab');
    expect(onPopoverKey).toHaveBeenCalledWith('Enter');
    expect(onEnterSend).not.toHaveBeenCalled();
  });

  it('clear() empties the editor', () => {
    const { ref } = setup();
    ref.current?.setText('something');
    expect(ref.current?.getText()).toBe('something');
    ref.current?.clear();
    expect(ref.current?.getText()).toBe('');
  });

  it('insertMention drops the active @query and inserts an atomic pill + space', () => {
    const { ref } = setup();
    ref.current?.setText('Use @la');
    ref.current?.insertMention({ token: '@designs/landing.html', entity: FILE_ENTITY });
    expect(ref.current?.getText()).toBe('Use @designs/landing.html ');
  });
});
