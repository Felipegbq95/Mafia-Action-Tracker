import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, matchPlayer } from './parser.js';

const ROSTER = [
  { id: '1', displayName: 'Axatar' },
  { id: '2', displayName: 'Bramblewood', aliases: ['Bramble'] },
  { id: '3', displayName: 'Cortez' },
];

test('clean "Role: Target" with a colon', () => {
  const [result] = parseMessage('**cop: Axatar**', ROSTER);
  assert.equal(result.role.canonical, 'cop');
  assert.equal(result.target.player.id, '1');
  assert.equal(result.needsReview, false);
});

test('dash separator instead of colon', () => {
  const [result] = parseMessage('**Doctor - Bramblewood**', ROSTER);
  assert.equal(result.role.canonical, 'doctor');
  assert.equal(result.target.player.id, '2');
});

test('em dash separator', () => {
  const [result] = parseMessage('**mafia — Cortez**', ROSTER);
  assert.equal(result.role.canonical, 'mafia');
  assert.equal(result.target.player.id, '3');
});

test('ability name instead of role name, no separator', () => {
  const [result] = parseMessage('**investigate Axatar**', ROSTER);
  assert.equal(result.role.canonical, 'cop');
  assert.equal(result.target.player.id, '1');
});

test('bold action embedded within a larger message', () => {
  const [result] = parseMessage("I'll go ahead and **investigate Axatar** tonight, hope it works out", ROSTER);
  assert.equal(result.role.canonical, 'cop');
  assert.equal(result.target.player.id, '1');
});

test('alias resolves via player alias list, not just display name', () => {
  const [result] = parseMessage('**protect Bramble**', ROSTER);
  assert.equal(result.role.canonical, 'doctor');
  assert.equal(result.target.player.id, '2');
});

test('typo in target name still fuzzy-matches', () => {
  const [result] = parseMessage('**cop: Axatr**', ROSTER);
  assert.equal(result.target.player.id, '1');
});

test('unknown role phrase is flagged for review, not dropped', () => {
  const [result] = parseMessage('**wizard: Axatar**', ROSTER);
  assert.equal(result.role.canonical, null);
  assert.equal(result.needsReview, true);
  assert.equal(result.role.raw, 'wizard');
});

test('unmatchable target is flagged for review, not dropped', () => {
  const [result] = parseMessage('**cop: SomeoneNotInTheGame**', ROSTER);
  assert.equal(result.role.canonical, 'cop');
  assert.equal(result.target.player, null);
  assert.equal(result.needsReview, true);
});

test('message with no bold falls back to full text and is flagged', () => {
  const [result] = parseMessage('cop: Axatar', ROSTER);
  assert.equal(result.needsReview, true);
});

test('message with no action content at all is still flagged, never throws', () => {
  const results = parseMessage('good luck everyone tonight', ROSTER);
  assert.equal(results.length, 1);
  assert.equal(results[0].needsReview, true);
});

test('matchPlayer returns null below the similarity threshold', () => {
  assert.equal(matchPlayer('zzz', ROSTER), null);
});

test('matchPlayer is case-insensitive', () => {
  const match = matchPlayer('axatar', ROSTER);
  assert.equal(match.player.id, '1');
});
