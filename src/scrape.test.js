import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionRows, channelActor } from './scrape.js';

const GAME = { id: 'g1', current_night_number: 2 };
const ABILITIES = [
  { id: 'ab-cop', name: 'Investigate', aliases: ['cop', 'investigate'] },
  { id: 'ab-kill', name: 'Kill', aliases: ['mafia', 'kill'] },
];
const PLAYERS = [
  { id: 'p1', display_name: 'Axatar', channel_name: 'axatar', aliases: ['joe'] },
  { id: 'p2', display_name: 'Bramble', channel_name: 'bramble', aliases: [] },
];
const msg = (id, author, content) => ({ id, author: { username: author }, content });

test('channelActor matches a channel by alias, name, or channel_name', () => {
  const roster = [
    { id: 'p1', display_name: 'Joe', channel_name: null, aliases: ['joe-smith', 'axatar'] },
    { id: 'p2', display_name: 'Peyton', channel_name: 'peyton-room', aliases: [] },
  ];
  assert.equal(channelActor('axatar', roster)?.id, 'p1'); // by alias
  assert.equal(channelActor('Joe-Smith', roster)?.id, 'p1'); // alias, normalized
  assert.equal(channelActor('joe', roster)?.id, 'p1'); // by display name
  assert.equal(channelActor('peyton-room', roster)?.id, 'p2'); // by channel_name
  assert.equal(channelActor('besties-duo', roster), null); // group channel -> nobody
});

test('personal channel attributes the actor from the channel owner', () => {
  const [row] = buildActionRows(
    [msg('10', 'whoever', '**cop: joe**')],
    { game: GAME, channel: { name: 'axatar' }, actor: PLAYERS[0], players: PLAYERS, abilities: ABILITIES },
  );
  assert.equal(row.actor_player_id, 'p1');
  assert.equal(row.ability_id, 'ab-cop');
  assert.equal(row.target_player_id, 'p1'); // joe -> Axatar
  assert.equal(row.night_number, 2);
  assert.equal(row.needs_review, false);
  assert.equal(row.source_channel, 'axatar');
});

test('shared channel leaves actor null and flags for review', () => {
  const [row] = buildActionRows(
    [msg('20', 'Carlos', '**kill bramble**')],
    { game: GAME, channel: { name: 'mafia' }, actor: null, players: PLAYERS, abilities: ABILITIES },
  );
  assert.equal(row.actor_player_id, null);
  assert.equal(row.ability_id, 'ab-kill');
  assert.equal(row.target_player_id, 'p2');
  assert.equal(row.needs_review, true); // shared channel needs manual actor
  assert.equal(row.actor_raw, 'Carlos'); // hint for who to assign it to
});

test('bot messages and chatter are skipped', () => {
  const rows = buildActionRows(
    [
      { id: '1', author: { username: 'bot', bot: true }, content: '**cop: joe**' },
      msg('2', 'Axatar', 'good luck everyone'),
      msg('3', 'Axatar', '**cop: joe**'),
    ],
    { game: GAME, channel: { name: 'axatar' }, actor: PLAYERS[0], players: PLAYERS, abilities: ABILITIES },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discord_message_id, '3');
});

test('unresolved target in a personal channel still records, flagged', () => {
  const [row] = buildActionRows(
    [msg('30', 'Axatar', '**cop: nobody**')],
    { game: GAME, channel: { name: 'axatar' }, actor: PLAYERS[0], players: PLAYERS, abilities: ABILITIES },
  );
  assert.equal(row.actor_player_id, 'p1');
  assert.equal(row.target_player_id, null);
  assert.equal(row.needs_review, true);
});
