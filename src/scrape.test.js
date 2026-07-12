import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionRows, channelActor } from './scrape.js';
import { isIgnoredAuthor } from './scraper-core.js';

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

test('isIgnoredAuthor matches mods by username, display name, or id; and bots', () => {
  const mods = ['ModMike', '999888777'];
  assert.equal(isIgnoredAuthor({ username: 'modmike' }, mods), true); // username, case-insensitive
  assert.equal(isIgnoredAuthor({ global_name: 'ModMike' }, mods), true); // display name
  assert.equal(isIgnoredAuthor({ id: '999888777', username: 'whoever' }, mods), true); // id
  assert.equal(isIgnoredAuthor({ username: 'Axatar' }, mods), false); // a real player
  assert.equal(isIgnoredAuthor({ username: 'x', bot: true }, mods), true); // bots always
  assert.equal(isIgnoredAuthor({ username: 'x' }, []), false);
});

test('buildActionRows drops messages from mod accounts (bolded results)', () => {
  const players = [
    { id: 'p1', display_name: 'Axatar', channel_name: 'axatar', aliases: [] },
    { id: 'p2', display_name: 'Bramble', channel_name: 'bramble', aliases: [] },
  ];
  const abilities = [{ id: 'ab', name: 'Investigate', aliases: ['cop'] }];
  const rows = buildActionRows(
    [
      // mod posts a bolded RESULT into the cop's channel - must be ignored
      { id: '1', author: { username: 'ModMike' }, content: '**cop result: Bramble is town**' },
      // the actual player action
      { id: '2', author: { username: 'axatar_user' }, content: '**cop: Bramble**' },
    ],
    { game: { id: 'g', current_night_number: 1 }, channel: { name: 'axatar' },
      actor: players[0], players, abilities, mods: ['ModMike'] },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discord_message_id, '2');
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

test('a message with several bolded actions yields one row per span (mafia channel)', () => {
  const players = [
    { id: 'p1', display_name: 'Rottweiler', channel_name: 'rottweiler', aliases: [] },
    { id: 'p2', display_name: 'Irish Wolfhound', channel_name: 'irish-wolfhound', aliases: [] },
    { id: 'p3', display_name: 'Beagle', channel_name: 'beagle', aliases: [] },
  ];
  const abilities = [
    { id: 'ab-kill', name: 'Faction Kill', aliases: ['faction kill', 'kill'] },
    { id: 'ab-inv', name: 'Investigate', aliases: ['investigate'] },
  ];
  const rows = buildActionRows(
    [{ id: '50', author: { username: 'mafioso' },
       content: '**Faction Kill - Rottweiler by Luka** **Steal Goal - on Irish Wolfhound** **Investigate - Beagle**' }],
    { game: { id: 'g', current_night_number: 1 }, channel: { name: 'mafia' },
      actor: null, players, abilities },
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.span_index), [0, 1, 2]);
  assert.equal(rows[0].ability_id, 'ab-kill');
  assert.equal(rows[2].ability_id, 'ab-inv');
  assert.equal(rows[2].target_player_id, 'p3');
  assert.ok(rows.every((r) => r.needs_review)); // shared channel: actors unassigned
  assert.ok(rows.every((r) => r.discord_message_id === '50'));
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

test('nights: actions are assigned by message timestamp; day messages skipped', async () => {
  const { nightForTimestamp } = await import('./scraper-core.js');
  const nights = [
    { night_number: 1, started_at: '2026-07-01T21:00:00Z', ends_at: '2026-07-02T09:00:00Z' },
    { night_number: 2, started_at: '2026-07-03T21:00:00Z', ends_at: null }, // ongoing
  ];
  assert.deepEqual(nightForTimestamp('2026-07-01T23:30:00Z', nights, 9), { night: 1, skip: false });
  assert.deepEqual(nightForTimestamp('2026-07-04T02:00:00Z', nights, 9), { night: 2, skip: false });
  // between nights = day phase -> skip
  assert.deepEqual(nightForTimestamp('2026-07-02T15:00:00Z', nights, 9), { night: null, skip: true });
  // no windows defined -> fallback, keep
  assert.deepEqual(nightForTimestamp('2026-07-02T15:00:00Z', [], 9), { night: 9, skip: false });
});

test('buildActionRows uses night windows and stores posted_at', () => {
  const players = [{ id: 'p1', display_name: 'Axatar', channel_name: 'axatar', aliases: [] }];
  const abilities = [{ id: 'ab', name: 'Investigate', aliases: ['cop'] }];
  const nights = [{ night_number: 2, started_at: '2026-07-03T21:00:00Z', ends_at: null }];
  const rows = buildActionRows(
    [
      { id: '1', author: { username: 'x' }, content: '**cop: Axatar**', timestamp: '2026-07-04T01:00:00Z' },
      { id: '2', author: { username: 'x' }, content: '**cop: Axatar**', timestamp: '2026-07-01T12:00:00Z' }, // before night 2 -> day, skipped
    ],
    { game: { id: 'g', current_night_number: 1 }, channel: { name: 'axatar' },
      actor: players[0], players, abilities, nights },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].night_number, 2);
  assert.equal(rows[0].posted_at, '2026-07-04T01:00:00Z');
});

test('one bold block with several lines yields one action per line (mafia format)', () => {
  const players = [
    { id: 'p1', display_name: 'Rottweiler', channel_name: 'rottweiler', aliases: [] },
    { id: 'p2', display_name: 'Beagle', channel_name: 'beagle', aliases: [] },
    { id: 'p3', display_name: 'Chihuahua', channel_name: 'chihuahua', aliases: [] },
  ];
  const abilities = [
    { id: 'ab-kill', name: 'Faction Kill', aliases: ['faction kill'] },
    { id: 'ab-inv', name: 'Investigate', aliases: ['investigate'] },
    { id: 'ab-watch', name: 'Watch Tape', aliases: ['watch tape'] },
  ];
  const rows = buildActionRows(
    [{ id: '60', author: { username: 'mafioso' },
       content: '**Faction Kill - Rottweiler\nInvestigate - Beagle\nWatch Tape - Chihuahua**' }],
    { game: { id: 'g', current_night_number: 1 }, channel: { name: 'mafia' },
      actor: null, players, abilities },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ability_id, 'ab-kill');
  assert.equal(rows[1].ability_id, 'ab-inv');
  assert.equal(rows[1].target_player_id, 'p2');
  assert.equal(rows[2].ability_id, 'ab-watch');
});
