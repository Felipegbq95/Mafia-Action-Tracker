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

test('multi-target: comma list fans into one action per target', () => {
  const rows = parse('**Sniff - Axatar, Bramblewood, Cortez**');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.target.player.id), ['1', '2', '3']);
  assert.ok(rows.every((r) => r.raw === 'Sniff - Axatar, Bramblewood, Cortez'));
});

test('multi-target still applies fuzzy misspell matching per target', () => {
  // "bramblewod" and "corte" are misspelled; both still resolve
  const rows = parse('**Kill - bramblewod, corte**');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ability.id, 'ab-kill');
  assert.deepEqual(rows.map((r) => r.target.player.id), ['2', '3']);
});

test('comma with only one real target stays a single action (no noise)', () => {
  const rows = parse('**cop: Axatar, please**');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target.player.id, '1');
});

test('unmatched parts in a multi-target list still surface, flagged', () => {
  const rows = parse('**Kill - Axatar, Bramblewood, nobodyhere**');
  assert.equal(rows.length, 3);
  assert.equal(rows[2].target.player, null);
  assert.equal(rows[2].needsReview, true);
});
