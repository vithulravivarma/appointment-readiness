import { hasDelegationIntent, hasExplicitDelegationDirective } from './delegation-intent-policy';

describe('delegation-intent-policy', () => {
  test('detects ask-named-person delegation intent', () => {
    expect(
      hasDelegationIntent('can you ask yashwanth about the toys he likes and whether there is food in the fridge?'),
    ).toBe(true);
  });

  test('detects reach-out delegation intent with pronouns', () => {
    expect(hasDelegationIntent('Please reach out to him')).toBe(true);
    expect(hasDelegationIntent('Contact the family for an update')).toBe(true);
  });

  test('detects reach-out to named person', () => {
    expect(hasDelegationIntent('can you reach out to yashwanth for the information we do not have?')).toBe(true);
    expect(hasDelegationIntent('message yashwanth and ask about ibuprofen')).toBe(true);
  });

  test('detects explicit delegate/delegation wording', () => {
    expect(hasDelegationIntent('Start a delegation for this visit')).toBe(true);
  });

  test('detects find-out directives for a person as delegation intent', () => {
    expect(
      hasDelegationIntent('does yashwanth have advil and ibuprofen? if you do not know, can you find out for me'),
    ).toBe(true);
    expect(
      hasExplicitDelegationDirective(
        'does yashwanth have advil and ibuprofen? if you do not know, can you find out for me',
      ),
    ).toBe(true);
  });

  test('does not misclassify direct assistant questions as delegation', () => {
    expect(hasDelegationIntent('can you ask what my schedule is tomorrow?')).toBe(false);
    expect(hasDelegationIntent('what did the family say about access code?')).toBe(false);
    expect(hasExplicitDelegationDirective('can you find out the weather for tomorrow?')).toBe(false);
  });
});
