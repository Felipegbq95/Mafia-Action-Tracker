import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, matchPlayer, isRecordableAction } from './parser.js';

const ABILITIES = [
  { id: 'ab-cop', name: 'Investigate', aliases: ['cop', 'check', 'investigate'] },
  { id: 'ab-doc', name: 'Protect', aliases: ['doctor', 'doc', 'protect'] },
  { id: 'ab-kill', name: 'Kill', aliases: ['mafia', 'kill'] },
];

const PLAYERS = [
  { id: '1', display_name: 'Axatar', channel_name: 'axatar', aliases: ['joe'] },
  { id: '2', display_name: 'Bramblewood', channel_name: 'bramble', aliases: ['bram'] },
  { id: '3', display_name: 'Cortez', channel_name: 'cortez', aliases: [] },
];

const parse = (content) => parseMessage(content, PLAYERS, ABILITIES);

test('clean "ability: target" with a colon', () => {
  const [r] = parse('**cop: Axatar**');
  assert.equal(r.ability.id, 'ab-cop');
  assert.equal(r.target.player.id, '1');
  assert.equal(r.needsReview, false);
});

test('target resolves via alias (joe -> Axatar)', () => {
  const [r] = parse('**cop: joe**');
  assert.equal(r.ability.id, 'ab-cop');
  assert.equal(r.target.player.id, '1');
  assert.equal(r.needsReview, false);
});

test('target resolves via channel name', () => {
  const [r] = parse('**protect bramble**');
  assert.equal(r.ability.id, 'ab-doc');
  assert.equal(r.target.player.id, '2');
});

test('dash and em-dash separators', () => {
  assert.equal(parse('**Doctor - Bramblewood**')[0].ability.id, 'ab-doc');
  assert.equal(parse('**mafia — Cortez**')[0].ability.id, 'ab-kill');
});

test('ability name resolved, no separator', () => {
  const [r] = parse('**investigate Axatar**');
  assert.equal(r.ability.id, 'ab-cop');
  assert.equal(r.target.player.id, '1');
});

test('action bolded inline within a larger message', () => {
  const [r] = parse("I'll go ahead and **investigate joe** tonight");
  assert.equal(r.ability.id, 'ab-cop');
  assert.equal(r.target.player.id, '1');
});

test('typo in target still fuzzy-matches', () => {
  assert.equal(parse('**cop: Axatr**')[0].target.player.id, '1');
});

test('unknown ability is flagged, not dropped', () => {
  const [r] = parse('**wizard: Axatar**');
  assert.equal(r.ability.id, null);
  assert.equal(r.needsReview, true);
  assert.equal(r.ability.raw, 'wizard');
});

test('unmatchable target is flagged, not dropped', () => {
  const [r] = parse('**cop: SomeoneNotInTheGame**');
  assert.equal(r.ability.id, 'ab-cop');
  assert.equal(r.target.player, null);
  assert.equal(r.needsReview, true);
});

// recording policy
test('clean bolded action is recordable', () => {
  assert.equal(isRecordableAction(parse('**cop: joe**')[0]), true);
});

test('bolded action with unknown ability is still recordable (for review)', () => {
  assert.equal(isRecordableAction(parse('**wizard: Axatar**')[0]), true);
});

test('non-bolded chatter is not recordable', () => {
  const [r] = parse('cop: Axatar');
  assert.equal(r.fromBold, false);
  assert.equal(isRecordableAction(r), false);
});

test('bolded plain emphasis is not recordable', () => {
  const [r] = parse("I **really** don't know who to pick");
  assert.equal(r.looksLikeAction, false);
  assert.equal(isRecordableAction(r), false);
});

test('matchPlayer matches channel name and alias, case-insensitively', () => {
  assert.equal(matchPlayer('AXATAR', PLAYERS).player.id, '1');
  assert.equal(matchPlayer('joe', PLAYERS).player.id, '1');
  assert.equal(matchPlayer('bramble', PLAYERS).player.id, '2');
});

test('matchPlayer returns null below threshold', () => {
  assert.equal(matchPlayer('zzz', PLAYERS), null);
});
