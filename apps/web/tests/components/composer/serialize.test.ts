import { describe, expect, it } from 'vitest';
import { createEditor, $getRoot } from 'lexical';

import { MentionNode } from '../../../src/components/composer/MentionNode';
import { serializeComposer } from '../../../src/components/composer/serialize';
import { setComposerFromText } from '../../../src/components/composer/deserialize';
import type { InlineMentionEntity } from '../../../src/utils/inlineMentions';

// Headless Lexical editor — no DOM required. `createEditor` runs purely in
// memory, so these specs stay in the default `node` test environment.
function makeEditor() {
  return createEditor({
    namespace: 'serialize-test',
    nodes: [MentionNode],
    onError(err) {
      throw err;
    },
  });
}

const FILE_ENTITY: InlineMentionEntity = {
  id: 'designs/landing.html',
  kind: 'file',
  label: 'designs/landing.html',
  token: '@designs/landing.html',
  title: 'File: designs/landing.html',
};

const MCP_ENTITY: InlineMentionEntity = {
  id: 'slack',
  kind: 'mcp',
  label: 'Slack MCP',
  token: '@Slack MCP',
  title: 'MCP: Slack MCP',
};

describe('serializeComposer / setComposerFromText round-trip', () => {
  it('round-trips a known file mention as a single @token plus trailing text', () => {
    const editor = makeEditor();
    const text = 'Use @designs/landing.html now';
    setComposerFromText(editor, text, [FILE_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe(text);
    expect(result.present).toHaveLength(1);
    expect(result.present[0]?.id).toBe('designs/landing.html');
    expect(result.present[0]?.kind).toBe('file');
  });

  it('preserves multi-newline spacing around a mention (no \\n collapse)', () => {
    const editor = makeEditor();
    const text = 'Plan:\n\n@designs/landing.html \n\nKeep spacing';
    setComposerFromText(editor, text, [FILE_ENTITY]);
    expect(serializeComposer(editor.getEditorState()).text).toBe(text);
  });

  it('emits the MCP token text verbatim including the space inside the label', () => {
    const editor = makeEditor();
    setComposerFromText(editor, '@Slack MCP ', [MCP_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('@Slack MCP ');
    expect(result.present[0]?.id).toBe('slack');
    expect(result.present[0]?.kind).toBe('mcp');
  });

  it('keeps unknown @tokens as plain text (not a MentionNode)', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'hi @nobody there', [FILE_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('hi @nobody there');
    expect(result.present).toHaveLength(0);
  });

  it('builds a single root paragraph (no \\n\\n block join)', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'line one\nline two', []);
    editor.getEditorState().read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
    });
    expect(serializeComposer(editor.getEditorState()).text).toBe('line one\nline two');
  });
});

describe('MentionNode atomic behaviour', () => {
  it('reports token text as its node text content', () => {
    const editor = makeEditor();
    setComposerFromText(editor, '@designs/landing.html', [FILE_ENTITY]);
    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild();
      const mention = para && 'getFirstChild' in para ? (para as any).getFirstChild() : null;
      expect(mention).toBeInstanceOf(MentionNode);
      expect((mention as MentionNode).getTextContent()).toBe('@designs/landing.html');
      expect((mention as MentionNode).getToken()).toBe('@designs/landing.html');
      expect((mention as MentionNode).getMode()).toBe('token');
    });
  });
});
