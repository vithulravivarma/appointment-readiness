import { buildCaregiverDelegationSummary } from './delegation-summary-policy';

describe('delegation-summary-policy', () => {
  test('builds caregiver-readable summary with objective and key updates only', () => {
    const summary = buildCaregiverDelegationSummary({
      startedAtLabel: 'Mar 2, 2026, 8:00 AM PST',
      endedAtLabel: 'Mar 2, 2026, 8:20 AM PST',
      objective: 'Confirm access details and medication readiness.',
      requestedQuestions: ['Any access code changes?', 'Are medications and supplies ready?', 'Any pet safety notes?'],
      llmKeyPoints: ['[FAMILY] Access code is still 9281.'],
      messages: [
        { senderType: 'AI_AGENT', content: 'Hi, any access code changes?' },
        { senderType: 'FAMILY', content: 'No changes, code is still 9281.' },
        { senderType: 'AI_AGENT', content: 'Are medications and supplies ready for today?' },
        { senderType: 'FAMILY', content: 'Yes, meds are set out in the kitchen.' },
      ],
    });

    expect(summary).toContain('Delegation objective: Confirm access details and medication readiness.');
    expect(summary).toContain('Key updates for caregiver:');
    expect(summary).toContain('code is still 9281');
    expect(summary).not.toContain('Follow-up for caregiver:');
    expect(summary).not.toContain('Traffic:');
  });

  test('uses concise fallback when no participant updates exist', () => {
    const summary = buildCaregiverDelegationSummary({
      startedAtLabel: 'Mar 2, 2026, 9:00 AM PST',
      endedAtLabel: 'Mar 2, 2026, 9:10 AM PST',
      objective: 'Collect updates.',
      requestedQuestions: ['Any access issues?'],
      messages: [{ senderType: 'AI_AGENT', content: 'Any access issues before I arrive?' }],
    });

    expect(summary).toContain('No new logistics updates were confirmed yet.');
  });

  test('removes speaker-prefix noise from LLM key points', () => {
    const summary = buildCaregiverDelegationSummary({
      startedAtLabel: 'Mar 2, 2026, 9:00 AM PST',
      endedAtLabel: 'Mar 2, 2026, 9:10 AM PST',
      objective: 'Collect updates.',
      requestedQuestions: [],
      llmKeyPoints: ['[COORDINATOR] caregiver should park behind gate B'],
      messages: [],
    });

    expect(summary).toContain('caregiver should park behind gate B');
    expect(summary).not.toContain('[COORDINATOR]');
  });

  test('humanizes informal acknowledgements into readable update lines', () => {
    const summary = buildCaregiverDelegationSummary({
      startedAtLabel: 'Mar 2, 2026, 9:00 AM PST',
      endedAtLabel: 'Mar 2, 2026, 9:10 AM PST',
      objective: 'Collect updates.',
      requestedQuestions: [],
      llmKeyPoints: ['yeah he does, it is in the cabinet by the microwave'],
      messages: [],
    });

    expect(summary).toContain('He does, it is in the cabinet by the microwave.');
  });
});
