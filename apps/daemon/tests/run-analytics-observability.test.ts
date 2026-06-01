import { describe, expect, it } from 'vitest';

import {
  scanRunEventsForUsageAnalytics,
  summarizeRunTimingAnalytics,
} from '../src/run-analytics-observability.js';

describe('scanRunEventsForUsageAnalytics', () => {
  it('extracts provider usage, cache tokens, and estimated context tokens', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: { type: 'status', label: 'initializing', model: 'claude-opus-4' },
        },
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cache_read_input_tokens: 250,
              cache_creation_input_tokens: 100,
            },
          },
        },
      ],
      '',
      40,
    );

    expect(result).toMatchObject({
      input_tokens: 1000,
      input_tokens_provider: 1000,
      input_tokens_effective: 1350,
      output_tokens: 50,
      total_tokens: 1400,
      cache_read_input_tokens: 250,
      cache_creation_input_tokens: 100,
      uncached_input_tokens: 1000,
      estimated_context_tokens: 1310,
      cache_token_source: 'anthropic',
      token_count_source: 'provider_usage',
      agent_reported_model: 'claude-opus-4',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(250 / 1350);
  });

  it('reads OpenAI-style cached prompt token details', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              prompt_tokens: 200,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 80 },
            },
          },
        },
      ],
      'gpt-4o',
      0,
    );

    expect(result.cache_read_input_tokens).toBe(80);
    expect(result.input_tokens_effective).toBe(200);
    expect(result.uncached_input_tokens).toBe(120);
    expect(result.cache_token_source).toBe('openai');
    expect(result.cache_hit_ratio).toBe(0.4);
  });

  it('does not invent cache split fields when provider usage lacks cache data', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 300,
              output_tokens: 30,
            },
          },
        },
      ],
      '',
      10,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 300,
      input_tokens_effective: 300,
      output_tokens: 30,
      total_tokens: 330,
      estimated_context_tokens: 290,
      cache_token_source: 'unavailable',
    });
    expect(result.cache_read_input_tokens).toBeUndefined();
    expect(result.uncached_input_tokens).toBeUndefined();
    expect(result.cache_hit_ratio).toBeUndefined();
  });

  it('treats normalized cached_read_tokens / cached_write_tokens aliases as input subsets', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 400,
              output_tokens: 20,
              cached_read_tokens: 120,
              cached_write_tokens: 30,
            },
          },
        },
      ],
      'gpt-5',
      0,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 400,
      input_tokens_effective: 400,
      output_tokens: 20,
      total_tokens: 420,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 30,
      uncached_input_tokens: 280,
      cache_token_source: 'openai',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(120 / 400);
  });

  it('preserves ACP provider totals when cache read tokens are already included in input', () => {
    const result = scanRunEventsForUsageAnalytics(
      [
        {
          event: 'agent',
          data: {
            type: 'usage',
            usage: {
              input_tokens: 31_711,
              output_tokens: 30,
              cached_read_tokens: 2_560,
              thought_tokens: 20,
              total_tokens: 31_741,
            },
          },
        },
      ],
      '',
      0,
    );

    expect(result).toMatchObject({
      input_tokens_provider: 31_711,
      input_tokens_effective: 31_711,
      output_tokens: 30,
      total_tokens: 31_741,
      cache_read_input_tokens: 2_560,
      uncached_input_tokens: 29_151,
      cache_token_source: 'openai',
    });
    expect(result.cache_hit_ratio).toBeCloseTo(2_560 / 31_711);
  });
});

describe('summarizeRunTimingAnalytics', () => {
  it('summarizes main run-path timings and aggregate tool duration', () => {
    const result = summarizeRunTimingAnalytics({
      runCreatedAt: 1_000,
      runUpdatedAt: 8_000,
      analyticsCapturedAt: 8_020,
      telemetry: {
        startRequestedAt: 1_100,
        startChatRunStartedAt: 1_200,
        processSpawnStartedAt: 1_700,
        processSpawnedAt: 1_760,
        firstTokenAt: 2_500,
      },
      events: [
        {
          id: 1,
          event: 'agent',
          timestamp: 3_000,
          data: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        {
          id: 2,
          event: 'agent',
          timestamp: 3_400,
          data: { type: 'tool_result', toolUseId: 'tool-1' },
        },
        {
          id: 3,
          event: 'agent',
          timestamp: 4_000,
          data: { type: 'tool_use', id: 'tool-2', name: 'Write' },
        },
        {
          id: 4,
          event: 'agent',
          timestamp: 4_250,
          data: { type: 'tool_result', toolUseId: 'tool-2' },
        },
      ],
    });

    expect(result).toEqual({
      queue_duration_ms: 200,
      pre_spawn_duration_ms: 500,
      process_spawn_duration_ms: 60,
      time_to_first_token_ms: 1300,
      spawn_to_first_token_ms: 740,
      generation_duration_ms: 5500,
      tool_call_count: 2,
      tool_duration_ms: 650,
      finalize_duration_ms: 20,
      total_duration_ms: 7020,
    });
  });
});
