import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeGame } from './scraper-core.js';

const GAME = { id: 'g1', current_night_number: 1, created_at: '2026-07-01T00:00:00Z' };
const ABILITIES = [{ id: 'ab-cop', name: 'Investigate', aliases: ['cop'] }];
const PLAYERS = [
  { id: 'p1', display_name: 'Axatar', channel_name: 'axatar', aliases: [] },
  { id: 'p2', display_name: 'Bramble', channel_name: 'bramble', aliases: [] },
];

function fakeDiscord({ channels, messagesByChannel }) {
  return {
    listTextChannels: async () => channels,
    fetchMessagesAfter: async (channelId) => messagesByChannel[channelId] ?? [],
    fetchRecentSince: async (channelId) => messagesByChannel[channelId] ?? [],
  };
}

function fakeDb() {
  const inserted = [];
  const cursors = {}; // channelName -> highest message id already "recorded"
  return {
    inserted,
    getLatestMessageId: async (_gameId, channelName) => cursors[channelName] ?? null,
    insertAction: async (row) => {
      inserted.push(row);
      cursors[row.source_channel] = row.discord_message_id;
      return true;
    },
  };
}

test('scrapeGame attributes personal channels and inserts rows', async () => {
  const discord = fakeDiscord({
    channels: [{ id: 'c1', name: 'axatar' }],
    messagesByChannel: { c1: [{ id: '1', author: { username: 'x' }, content: '**cop: Bramble**' }] },
  });
  const db = fakeDb();
  const result = await scrapeGame({
    discord, db, guildId: 'guild', excludedChannels: [],
    game: GAME, players: PLAYERS, abilities: ABILITIES,
  });
  assert.equal(result.channels, 1);
  assert.equal(result.messages, 1);
  assert.equal(result.inserted, 1);
  assert.equal(db.inserted[0].actor_player_id, 'p1');
  assert.equal(db.inserted[0].target_player_id, 'p2');
});

test('scrapeGame filters excluded channels', async () => {
  const discord = fakeDiscord({
    channels: [{ id: 'c1', name: 'axatar' }, { id: 'c2', name: 'general' }],
    messagesByChannel: {},
  });
  const db = fakeDb();
  const result = await scrapeGame({
    discord, db, guildId: 'guild', excludedChannels: ['general'],
    game: GAME, players: PLAYERS, abilities: ABILITIES,
  });
  assert.equal(result.channels, 1); // general excluded
});

test('scrapeGame continues past a channel that errors', async () => {
  const discord = {
    listTextChannels: async () => [{ id: 'bad', name: 'locked' }, { id: 'c1', name: 'axatar' }],
    fetchMessagesAfter: async () => [],
    fetchRecentSince: async (channelId) => {
      if (channelId === 'bad') throw new Error('403 forbidden');
      return [{ id: '1', author: { username: 'x' }, content: '**cop: Bramble**' }];
    },
  };
  const db = fakeDb();
  const result = await scrapeGame({
    discord, db, guildId: 'guild', excludedChannels: [],
    game: GAME, players: PLAYERS, abilities: ABILITIES,
  });
  assert.equal(result.channels, 2);
  assert.equal(result.inserted, 1); // the good channel still got scraped
  const errored = result.perChannel.find((c) => c.channel === 'locked');
  assert.equal(errored.error, '403 forbidden');
});

test('scrapeGame uses the per-channel cursor so re-runs only fetch new messages', async () => {
  const calls = [];
  const discord = {
    listTextChannels: async () => [{ id: 'c1', name: 'axatar' }],
    fetchMessagesAfter: async (channelId, afterId) => { calls.push(afterId); return []; },
    fetchRecentSince: async () => [{ id: '5', author: { username: 'x' }, content: '**cop: Bramble**' }],
  };
  const db = fakeDb();
  // first run: no cursor yet -> fetchRecentSince path, inserts message id 5
  await scrapeGame({ discord, db, guildId: 'g', excludedChannels: [], game: GAME, players: PLAYERS, abilities: ABILITIES });
  // second run: cursor now exists -> fetchMessagesAfter('5') path
  await scrapeGame({ discord, db, guildId: 'g', excludedChannels: [], game: GAME, players: PLAYERS, abilities: ABILITIES });
  assert.deepEqual(calls, ['5']);
});
