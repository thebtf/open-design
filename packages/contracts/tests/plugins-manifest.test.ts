import { describe, expect, it } from 'vitest';
import {
  OPEN_DESIGN_PLUGIN_SPEC_VERSION,
  MarketplacePluginEntrySchema,
  PluginManifestSchema,
  resolveLocalizedText,
} from '../src/plugins/index.js';

describe('plugin manifest localized text', () => {
  it('exports the current plugin spec version for manifests and registries', () => {
    expect(OPEN_DESIGN_PLUGIN_SPEC_VERSION).toBe('1.0.0');
  });

  it('accepts legacy string use-case queries', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'sample-plugin',
      version: '1.0.0',
      od: {
        useCase: {
          query: 'Make a {{topic}} brief.',
        },
      },
    });

    expect(manifest.od?.useCase?.query).toBe('Make a {{topic}} brief.');
  });

  it('accepts locale-map use-case queries', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'sample-plugin',
      version: '1.0.0',
      od: {
        useCase: {
          query: {
            en: 'Make a {{topic}} brief.',
            'zh-CN': '围绕 {{topic}} 写一份简报。',
          },
        },
      },
    });

    expect(resolveLocalizedText(manifest.od?.useCase?.query, 'zh-CN')).toBe(
      '围绕 {{topic}} 写一份简报。',
    );
  });

  it('accepts localized title and description metadata', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'sample-plugin',
      version: '1.0.0',
      title: 'Sample Plugin',
      title_i18n: {
        en: 'Sample Plugin',
        'zh-CN': '示例插件',
      },
      description: 'English fallback.',
      description_i18n: {
        en: 'English fallback.',
        'zh-CN': '中文描述。',
      },
    });

    expect(resolveLocalizedText(manifest.title_i18n, 'zh-CN')).toBe('示例插件');
    expect(resolveLocalizedText(manifest.description_i18n, 'zh-CN')).toBe('中文描述。');
  });

  it('accepts localized marketplace entry metadata', () => {
    const entry = MarketplacePluginEntrySchema.parse({
      name: 'open-design/example-sample',
      source: 'github:open-design/plugins/examples/sample',
      version: '1.0.0',
      title: 'Sample',
      title_i18n: {
        en: 'Sample',
        'zh-CN': '示例',
      },
      description: 'English fallback.',
      description_i18n: {
        en: 'English fallback.',
        'zh-CN': '中文描述。',
      },
    });

    expect(resolveLocalizedText(entry.title_i18n, 'zh-CN')).toBe('示例');
    expect(resolveLocalizedText(entry.description_i18n, 'zh-CN')).toBe('中文描述。');
  });

  it('accepts declared bundle children', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'deck-bundle',
      version: '1.0.0',
      od: {
        kind: 'bundle',
        bundle: {
          skills: [{ id: 'deck-skeleton', path: 'skills/deck-skeleton' }],
          designSystems: [{ id: 'linear-clone', path: 'design-systems/linear-clone' }],
          craft: [{ id: 'deck-pacing', path: 'craft/deck-pacing.md' }],
        },
      },
    });

    expect(manifest.od?.bundle?.skills?.[0]?.id).toBe('deck-skeleton');
    expect(manifest.od?.bundle?.designSystems?.[0]?.path).toBe('design-systems/linear-clone');
    expect(manifest.od?.bundle?.craft?.[0]?.id).toBe('deck-pacing');
  });

  it('falls back from exact locale to base language, English, then first value', () => {
    expect(resolveLocalizedText({ en: 'English', zh: '中文' }, 'zh-CN')).toBe('中文');
    expect(resolveLocalizedText({ 'zh-CN': '中文' }, 'fr')).toBe('中文');
  });
});
