import {
  buildAgentDeskTurnDedupeKey,
  compileDelegationContext,
  inferDelegationTypeFromCommand,
} from './delegation-context-compiler';

describe('delegation-context-compiler', () => {
  test('falls back safely without API key', async () => {
    const compiled = await compileDelegationContext({
      command: 'Does Yashwanth have Advil and ibuprofen?',
      history: [{ role: 'CAREGIVER', content: 'Please find out meds at home.' }],
      model: 'gpt-4o-mini',
    });

    expect(compiled.objective.toLowerCase()).toContain('yashwanth');
    expect(compiled.questions.length).toBeGreaterThan(0);
    expect(compiled.questionItems.length).toBe(compiled.questions.length);
    expect(compiled.questionItems.every((item) => item.priority === 'PRIMARY')).toBe(true);
    expect(compiled.contextPacket.model).toBe('deterministic_fallback');
  });

  test('normalizes model output and dedupes questions', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                delegationType: 'OPEN_ENDED',
                objective: 'Collect medication and pet-home status before visit.',
                questionItems: [
                  { text: 'Does he have Advil', priority: 'PRIMARY' },
                  { text: 'Is the dog at home?', priority: 'PRIMARY' },
                  { text: 'Does he have Advil?', priority: 'OPTIONAL' },
                ],
                questions: [
                  'Does he have Advil',
                  'Does he have Advil?',
                  'Is the dog at home?',
                ],
                knownFacts: ['Fridge has apples and bananas'],
                missingFacts: ['Advil availability', 'Dog home status'],
                evidence: ['[CAREGIVER] Ask about advil and dog'],
              }),
            },
          },
        ],
      }),
    });

    const previousFetch = global.fetch;
    // @ts-ignore
    global.fetch = fetchMock;
    try {
      const compiled = await compileDelegationContext({
        command: 'Does he have advil and is the dog at home?',
        history: [
          { role: 'CAREGIVER', content: 'Does Yashwanth have Advil?' },
          { role: 'ASSISTANT', content: 'I can ask if you want me to reach out.' },
        ],
        openaiApiKey: 'test-key',
        model: 'gpt-4o-mini',
      });

      expect(compiled.objective).toContain('medication');
      expect(compiled.questions).toEqual(['Does he have Advil?', 'Is the dog at home?']);
      expect(compiled.questionItems).toEqual([
        { text: 'Does he have Advil?', priority: 'PRIMARY' },
        { text: 'Is the dog at home?', priority: 'PRIMARY' },
      ]);
      expect(compiled.contextPacket.knownFacts).toContain('Fridge has apples and bananas');
    } finally {
      global.fetch = previousFetch;
    }
  });

  test('fallback when model returns malformed payload', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'not-json' } }],
      }),
    });

    const previousFetch = global.fetch;
    // @ts-ignore
    global.fetch = fetchMock;
    try {
      const compiled = await compileDelegationContext({
        command: 'Can you verify if Advil is available?',
        history: [{ role: 'CAREGIVER', content: 'verify advil' }],
        openaiApiKey: 'test-key',
        model: 'gpt-4o-mini',
      });

      expect(compiled.questions.length).toBeGreaterThan(0);
      expect(compiled.contextPacket.model).toBe('gpt-4o-mini');
      expect(compiled.contextPacket.missingFacts.length).toBeGreaterThan(0);
    } finally {
      global.fetch = previousFetch;
    }
  });

  test('fact-check flow caps to two primary questions and no optional', async () => {
    const compiled = await compileDelegationContext({
      command: 'Does Yashwanth have Advil at home and where in the house is it?',
      history: [{ role: 'CAREGIVER', content: 'if unknown please find out' }],
      model: 'gpt-4o-mini',
    });

    expect(compiled.delegationType).toBe('FACT_CHECK');
    expect(compiled.questionItems.length).toBeLessThanOrEqual(2);
    expect(compiled.questionItems.every((item) => item.priority === 'PRIMARY')).toBe(true);
  });

  test('infers delegation type from command', () => {
    expect(inferDelegationTypeFromCommand('Does he have Advil and where is it in the house?')).toBe('FACT_CHECK');
    expect(inferDelegationTypeFromCommand('Can you ask for access and parking logistics?')).toBe('LOGISTICS');
  });

  test('builds stable dedupe key', () => {
    const key1 = buildAgentDeskTurnDedupeKey({
      caregiverId: 'u1',
      role: 'CAREGIVER',
      content: 'hello',
      createdAt: '2026-03-03T00:00:00.000Z',
    });
    const key2 = buildAgentDeskTurnDedupeKey({
      caregiverId: 'u1',
      role: 'CAREGIVER',
      content: 'hello',
      createdAt: '2026-03-03T00:00:00.000Z',
    });
    expect(key1).toBe(key2);
  });
});
