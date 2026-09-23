/**
 * manifest.js — Stremio / Nuvio Addon Manifest (iptv-org edition)
 *
 * Single catalog: all free live sports channels from iptv-org,
 * with a search catalog so users can filter by channel name.
 */

const { addonBuilder } = require('stremio-addon-sdk');
const { GENRES } = require('./channelGenres');

const manifest = {
  // Its own id, not upstream's. Sharing 'community.nuvio.live-sports' made the
  // two addons look like one to anything that keys installed addons by id.
  id: 'community.aiosports',
  version: '1.7.0',
  name: 'AIOSports',
  description:
    'Live sports fixtures and 24/7 channels from several public sources, gathered into one catalog ' +
    'with artwork for every event and channel. Self-hosted.',
  logo: '/logo-v2.png',

  types: ['tv'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Soccer', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_cricket', name: '🏏 Cricket', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_basketball', name: '🏀 Basketball', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_motorsport', name: '🏎️ Racing', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_hockey', name: '🏒 Hockey', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_baseball', name: '⚾ Baseball', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_mma', name: '🥊 MMA', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_golf', name: '⛳ Golf', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_tennis', name: '🎾 Tennis', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_rugby', name: '🏉 Rugby', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_american_football', name: '🏈 NFL', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_other_football', name: '🏈 Other Football', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_darts', name: '🎯 Darts', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_college', name: '🎓 College', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_other', name: '🏅 Other Sports', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_channels', name: '📺 Channels', extra: [{ name: 'genre', options: GENRES, isRequired: false }, { name: 'search', isRequired: false }] },

    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] },
    // The viewer's own cities' channels. Listed only when the config names a city.
    { type: 'tv', id: 'nuvio_sports_local', name: '📍 Local', extra: [{ name: 'search', isRequired: false }] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'markets', title: 'Local channels: your cities (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    {
      key: 'timezone',
      title: 'Timezone',
      type: 'text',
      default: 'UTC'
    },
    {
      key: 'timeFormat',
      title: 'Clock format (12 or 24)',
      type: 'text',
      default: '12'
    }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },
};

const builder = new addonBuilder(manifest);

// A tab kept off the home board is published twice, and the second copy wears
// this suffix. Both ids mean the same category; see the manifest route in
// index.js for why one catalog cannot cover all three surfaces at once.
const SEARCH_TWIN_SUFFIX = '__search';

module.exports = { builder, manifest, SEARCH_TWIN_SUFFIX };
