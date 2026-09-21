# Changelog

## v1.6.2 (2026-09-21)

Housekeeping the health check turned up. Of 79 stream-check failures in four hours, 74 were a single host — tvpass.org, which carries Marquee in the iptv-org data and has been gone for days — and each one was being attempted twice, because the retry added in v1.5.1 could not tell a dead name from a slow one. None of this ever reached a viewer; it was the background channel sweep spending time on a host that no longer exists.

### Bug Fixes

* **streams:** stop asking a host whose name does not resolve. ENOTFOUND is definitive in the way a 404 is, so it is no longer retried, and the host is written off for six hours — a stream on a host already written off is dropped without a network call at all. Written off by observation rather than by name, so the next host to disappear costs one failed lookup instead of a code change; timeouts and refused connections are still retried as before ([62df9eb](https://github.com/mlp2069/aiosports/commit/62df9eb))

## v1.6.1 (2026-09-21)

Two small fixes found while reviewing what upstream had been doing. A club whose name carries a letter no Unicode normal form takes apart — the ø in Bodø/Glimt, the ł in Łódź — had that letter deleted rather than folded, so ⭐ Your Teams never matched it. And a stream served as a progressive .mp4 was being judged against the rules for a playlist, which no mp4 can pass, so those rows were dropped before anyone saw them.

### Bug Fixes

* **catalog:** fold the letters no normal form decomposes — ø, ł, ß, đ, æ — so Your Teams matches a club the way a viewer spells it. The bundled ESPN table is not consistent about them, spelling Bodø/Glimt "bodo glimt" but Brøndby "brndby", so the lookup now tries the older spelling when the current one misses; both directions gain, and "Brondby" typed by hand resolves for the first time ([8b62e3b](https://github.com/mlp2069/aiosports/commit/8b62e3b))
* **streams:** stop dropping .mp4 streams as invalid playlists. The pre-flight check reads the head of a playlist and rejects a body with no #EXT in it, which is every mp4 ever served; web player links were already exempt for the same reason and progressive media now is too ([7f5bd45](https://github.com/mlp2069/aiosports/commit/7f5bd45))

## v1.6.0 (2026-09-20)

Streams used to die partway through a match and then vanish from the list when you refreshed. The stream was still on air — only its address had gone stale. Several sources hand out a playlist address that carries an expiry, and TotalSportek's lasts about thirty minutes, which is halfway through a football match. Watched one expire on the clock: a playlist forty seconds before the advertised time, and a 403 from the CDN thirty-six seconds after it. The addon now notices that answer, re-resolves the source, and serves the same feed under a fresh address without the player ever knowing.

### Features

* **streams:** re-mint a stream whose token has expired instead of letting it die. The feed is recognised in the freshly resolved list by reducing addresses to a skeleton — epoch and opaque path segments blanked, token-named query parameters dropped — so TotalSportek's `path` hash and WatchFooty's stream number still identify it while their tokens and expiries do not, and a re-mint cannot move you to a different feed of the match. Bounded to one attempt per address per thirty seconds and three in all, so a genuinely dead stream never becomes a hammer on the provider ([4a4358c](https://github.com/mlp2069/aiosports/commit/4a4358c))

## v1.5.1 (2026-09-20)

Two reliability fixes. 🔴 Live Now was showing matches that had finished — four of the eight tiles at the top of it returned no streams at all, between 3.8 and 5.3 hours past kickoff, because a provider's "live" flag was believed forever and none of the six providers that set it ever takes it back. And a stream that answered once with a timeout or a 503 was dropped outright, even though the code already knew that answer said nothing about the stream. Both are now held to the evidence.

### Bug Fixes

* **catalog:** stop trusting a provider's "live" status forever — it is now held to the same per-sport clock every other path already used, plus a 45 minute grace window for stoppage, extra time and delayed kickoffs. Measured against the 60 tiles showing as LIVE at the time of writing, 51 stay and 9 go, all nine football between 3.3 and 5.3 hours past kickoff ([bf56fa2](https://github.com/mlp2069/aiosports/commit/bf56fa2))
* **streams:** ask a second time before dropping a stream on a transient answer — a timeout, a dropped socket, 408, 429 or any 5xx is retried once after a short pause, so a source that blips no longer disappears from the list until the cache turns over. A 404 or a 403 is an answer about the stream and is still taken at its word ([cc9801b](https://github.com/mlp2069/aiosports/commit/cc9801b))

## v1.5.0 (2026-09-19)

A stream that never really breaks but keeps catching itself is the source's playlist, not your connection. Measured here over two minutes: TotalSportek publishes a segment every 4.02s like a metronome, while WatchFooty and TimStreams list four segments — sixteen and thirteen seconds — and publish in bursts, eight seconds of nothing and then two at once, eleven times between them. A player starts three segments from the end of a live playlist, so it holds about twelve seconds of video; one of those pauses spends most of it and the next slow chunk is a stall. Extra Buffer, in `/configure` or `LIVE_BUFFER_SECONDS`, hands the player a deeper window of what the source has already published and tells it to start further back in it. Off by default, and off stays exactly as it was.

### Features

* **streams:** an extra buffer for sources that publish in bursts. The segments a source publishes are remembered and kept in what is served after the source drops them — measured on real playlists, a sixteen second window becomes a hundred and four, and all 56 segments in the deepened windows still fetched — and #EXT-X-START tells the player how far back to begin, which ExoPlayer reads before anything else. The live edge never moves and the media sequence only goes forward; a host that deletes a segment when it stops listing it is found out and served its own window unchanged ([cbb99c4](https://github.com/mlp2069/aiosports/commit/cbb99c4)) 

### Bug Fixes

* **player:** stop the web player seeking back to the live edge on healthy streams. liveMaxLatencyDurationCount was 5 where hls.js defaults to no limit at all, so twenty seconds of drift reset playback to the live edge and threw the buffer away — and twenty seconds of drift is ordinary on a source that pauses eight seconds at a time ([d69fa01](https://github.com/mlp2069/aiosports/commit/d69fa01))
* **docs:** the FAQ said the prebuilt image was amd64 only, which it has not been since v1.3.0 ([cbb99c4](https://github.com/mlp2069/aiosports/commit/cbb99c4))

## v1.4.1 (2026-09-16)

A follow-up to v1.4.0. Every local station is now a tile of its own — FOX 32 Chicago, NBC 5 Chicago, ABC 15 Phoenix and about 350 more — instead of a row buried inside its network's tile. The release also reports its own version correctly again, and release builds no longer fail on their first attempt. No reinstall is needed.

### Features

* **channels:** give every local station its own tile, named for its city and channel number, across all 220 cities with a free stream rather than only the cities in your profile. the fox, nbc, abc and cbs tiles keep just their national feeds, and cw, mnt and pbs no longer have a tile of their own because every stream they carried was a local station ([337ac56](https://github.com/mlp2069/aiosports/commit/337ac56))

### Bug Fixes

* **manifest:** report the right version in the manifest, /api/version and the readme badge — v1.4.0 still announced itself as 1.3.0 ([8f0a023](https://github.com/mlp2069/aiosports/commit/8f0a023))
* **ci:** wait for impit to report in before judging the image, instead of reading its log once the moment the server answers. that race is why the first v1.3.0 and v1.4.0 tag builds published no image and had to be re-cut ([a95dc76](https://github.com/mlp2069/aiosports/commit/a95dc76))

## v1.4.0 (2026-09-16)

⭐ Your Teams asked whether a fixture's title contained the name you typed. A feed writes "Braves @ Cubs" where you wrote "Chicago Cubs", so your own club never matched and the tab stood empty during your own game — while the same question handed a Chicago supporter Mercer Bears and California Golden Bears, who are other people's Bears entirely. A title is a sentence, not an identity, and the crests that settle it were on hand the whole time. The fixtures nobody streams yet were picked the same way, where a single word could collect three hundred other clubs' games. And dragging the sources into an order still changed nothing about the list that came back from them.

### Features

* **streams:** sort the list by your own source order as well as by the rating — the rating breaks ties inside each source, and the CDN rotation moves inside one too, since promoting a second host over the whole of your first-choice source undoes the order being asked for. Left unset, ordering your sources is what selects it, so the control that already existed starts meaning something without anyone having to find this one ([4e1f12a](https://github.com/mlp2069/aiosports/commit/4e1f12a))

### Bug Fixes

* **catalog:** read ⭐ Your Teams on who is playing rather than on what the title says, so a club answers to every spelling its feeds use and to nobody else's nickname — measured across 2,380 fixture-and-team pairs, nothing that belonged in the tab left it. A club's own 24/7 channel leaves it as well: it has no kickoff, so it is not a game, and it sat at the top on every day of the year ([765572c](https://github.com/mlp2069/aiosports/commit/765572c))
* **catalog:** match the fixtures nobody streams yet on identity instead of on a substring. A club's city sits inside its name and a nickname is shared across leagues, so "city" was collecting 357 of 6,628 scheduled fixtures — every Kansas City Chiefs game among them — "united" 235, and "bears" 91. Both the crest and the keyed spellings are consulted, because ESPN files one club under more than one crest id and a crest-only test loses half of a correctly named club's games ([3e1bb71](https://github.com/mlp2069/aiosports/commit/3e1bb71))
* **catalog:** drop a listing whose title is the separator alone — a "vs" with neither side filled in, arriving as a blank grey tile. Narrowly, because the obvious rule is wrong: of nine fixtures resolving to no matchup, eight were a UFC card, a wrestling show, a race meeting and two tennis tournaments, all of them real events that simply have one name rather than two ([2ff3521](https://github.com/mlp2069/aiosports/commit/2ff3521))

## v1.3.0 (2026-09-16)

An ARM release. The published image was x86 only, so an Ampere box — an Oracle free-tier instance, a Raspberry Pi — had to build the whole thing from source before it could run any of this. It now ships for arm64 under the same tag, and the pull command does not change: Docker reads the machine it is on and fetches the half that fits it.

### Features

* **ci:** publish the image for linux/arm64 as well as linux/amd64, each half built on a runner of its own rather than one emulating the other, and each one started and asked for `/health` on its own architecture before the tag naming both is written — whether a native binary loads is not something a test can answer from the machine that compiled it ([02b7157](https://github.com/mlp2069/aiosports/commit/02b7157))
* **docs:** say how to run it on an oracle ampere instance, including the part that catches people out — a port there has to be opened in the subnet's security list *and* on the machine, whose ubuntu images ignore `ufw` ([48938cf](https://github.com/mlp2069/aiosports/commit/48938cf))

## v1.2.2 (2026-09-16)

The other half of the release before it. A fixture's sport was read off the last words of its address, and club names are full of sports: the tail of `barcelona-vs-racing-de-santander` is "racing de santander", which went out as motorsport. The wrong tab was again the smaller half — two rows that disagree about the sport are never merged, so that game was listed twice, once here and once from another source, with the streams divided between the two tiles. A fixture nobody can place merges perfectly well; only a confident wrong answer stops it, which makes naming no sport strictly better than guessing at one.

### Bug Fixes

* **providers:** read a totalsportek address for its sport only where it names one outright, so a club called Racing is not motor racing and a game is not listed twice for it ([d9c0447](https://github.com/mlp2069/aiosports/commit/d9c0447))

## v1.2.1 (2026-09-16)

Cleaning up after the release before it. A site that lists two club names and a kickoff has not said what sport is being played, so fifty-four fixtures landed in Other Sports — twenty-six of them major league baseball. The wrong tab was the smaller half: two rows that disagree about the sport are never merged, so the same game from a source that did name its sport sat on a second tile with the streams divided between them. The crests settle it, and they were already on hand.

### Bug Fixes

* **catalog:** read a fixture's sport off its two crests when the listing never named one, before the merge rather than after — so a game does not sit in Other Sports, and does not sit there as a second tile beside the same game from a source that knew what it was ([a425bc0](https://github.com/mlp2069/aiosports/commit/a425bc0))

## v1.2.0 (2026-09-16)

A sources release, and a short one. Adding a site is only worth the code if it can be up when the others are down — and most of the ones worth checking are not: they land on embeds this addon already resolves, or were seized over the summer, or are parked. TotalSportek is the exception, on infrastructure nothing else here touches, so a bad minute on one edge is not a bad minute on both. It is on by default and can be turned off like any other source in `/configure`.

### Features

* **providers:** add totalsportek, whose playlists come off a chain no other source here reaches, so its streams fail at different times to theirs; the listing is read once per sync and the five-hop walk down to a playlist waits until a viewer opens a tile, since the pages it needs are a hundred and ten of them at some 142 KB each ([463482e](https://github.com/mlp2069/aiosports/commit/463482e))

## v1.1.0 (2026-09-15)

A fixtures release. The scoreboards this addon reads had stopped answering the way it was asking, and nothing said so: most of the catalog had quietly lost which side was at home and which badge belonged on the card. Repairing that turned out to pay for the rest, because the same responses already carried the kickoff, the venue and the channel showing the game, and all of it was being thrown away. So a tile now names the network, shows a kickoff worth trusting, and — for the teams you follow — appears days before any site has posted a link. Stream rows say which site they really came from, and are ordered by what was measured rather than what was claimed.

### Features

* **catalog:** name the network carrying a fixture on its tile, and show the scoreboard's kickoff where a source site disagrees with it by more than a quarter of an hour ([06a1d48](https://github.com/mlp2069/aiosports/commit/06a1d48))
* **catalog:** list your own teams' fixtures for the week ahead in ⭐ Your Teams before any site has posted a stream for them, saying so on the tile ([06a1d48](https://github.com/mlp2069/aiosports/commit/06a1d48))
* **streams:** rank a row on the resolution and bitrate verification actually read from it, and on how its provider has been answering lately, rather than on the sentence the provider wrote ([eadaa2c](https://github.com/mlp2069/aiosports/commit/eadaa2c))
* **streams:** put the best row from each edge server at the top, so the second choice is a second chance instead of a second link to the machine that just stalled ([eadaa2c](https://github.com/mlp2069/aiosports/commit/eadaa2c))
* **espn:** keep the kickoff, status, venue and television network the scoreboards were already carrying and the addon was discarding ([3a449c2](https://github.com/mlp2069/aiosports/commit/3a449c2))

### Bug Fixes

* **espn:** fetch the scoreboards a day and a month at a time, the forms espn still answers — the range form it retired had left eleven of eighty-four requests succeeding, and with them the home side and the league badge on every board but soccer ([3a449c2](https://github.com/mlp2069/aiosports/commit/3a449c2))
* **streams:** stop a row whose source is unrecognised being labelled as another provider, which made a site look like one that had worked the night before ([eadaa2c](https://github.com/mlp2069/aiosports/commit/eadaa2c))
* **catalog:** refuse a scoreboard record too far from a fixture's own hour to be the same game, so the second game of a doubleheader no longer wears the first one's time and channel ([06a1d48](https://github.com/mlp2069/aiosports/commit/06a1d48))

### Performance Improvements

* **espn:** fifty-five scoreboard requests where there were eighty-four, and one record per event shared by every key naming it instead of a copy written out under each ([3a449c2](https://github.com/mlp2069/aiosports/commit/3a449c2))
* **streams:** resolve four sources at a time rather than all of them at once, so a dozen mints and decrypts stop contending for two cores and timing out on work that was only waiting for one ([eadaa2c](https://github.com/mlp2069/aiosports/commit/eadaa2c))

## v1.0.3 (2026-09-13)

A quiet release. A restart no longer costs the server minutes of work, the stream relay handles keyed streams, and a dropped connection gets a second try.

### Bug Fixes

* **streams:** answer a chunk that has gone as a 404 so a player skips it instead of choking on it, and relay keys and init sections under names that say what they are ([6ac3c09](https://github.com/mlp2069/aiosports/commit/6ac3c09))
* **providers:** try a connection the host cut off once more before giving up on it ([8906837](https://github.com/mlp2069/aiosports/commit/8906837))

### Performance Improvements

* **cache:** keep finished cards, fetched logos, the catalog and the logo and fixture indexes on the data volume, and serve the saved catalog the moment the server is up, so a restart no longer redraws every cover, refetches every logo or re-reads every source ([f5e7cc8](https://github.com/mlp2069/aiosports/commit/f5e7cc8))
* **cache:** stop the card warmer's own reads from minting streams, which was most of a restart's cpu: 33 matches minted and 52 decrypts, for tokens nobody would use ([a04bbb9](https://github.com/mlp2069/aiosports/commit/a04bbb9))

## v1.0.2 (2026-09-13)

A local release. Hardened for a public launch, then the channels of your own cities, and streamed's streams playing in nuvio the way they play in a browser. The manifest id changed to community.aiosports: reinstall the addon in your player.

### Features

* **channels:** name your cities under local channels in /configure, or in local_markets, and each of their stations that iptv-org has a stream for becomes a tile of its own, such as fox 32 chicago, listed in a new 📍 local tab beside the channels named after the city ([c256be4](https://github.com/mlp2069/aiosports/commit/c256be4))
* **channels:** put your own cities' stations first on the abc, cbs, nbc and fox tiles ([c256be4](https://github.com/mlp2069/aiosports/commit/c256be4))
* **streams:** label every stream on the abc, cbs, nbc and fox tiles with its station's city and call sign, such as los angeles, ca · kttv, taking the state from the station's own record rather than the stream's title ([a420ece](https://github.com/mlp2069/aiosports/commit/a420ece), [24faf34](https://github.com/mlp2069/aiosports/commit/24faf34))
* **streams:** relay the video chunks of hosts that refuse a player's own client, as streamed's cdn does, so its streams play in nuvio instead of stalling, and try each host once so only the ones that need it are relayed (proxy_segment_hosts) ([6567759](https://github.com/mlp2069/aiosports/commit/6567759))
* **artwork:** put the channel's name in a line along the top of its cover with the logo centred, and read espn2 as espn 2 ([0e24773](https://github.com/mlp2069/aiosports/commit/0e24773))
* **artwork:** stamp every card with an art generation so clearing the cache reaches players, draw matchup cards in the leagues' official team colours, and never cache a fallback card ([0e1c2bc](https://github.com/mlp2069/aiosports/commit/0e1c2bc))
* **security:** sign stream links, guard everything the server fetches against private addresses, give profiles saved without auth_key an edit key, lock out repeated failed sign-ins, and limit requests per address ([0e1c2bc](https://github.com/mlp2069/aiosports/commit/0e1c2bc))
* **security:** give the addon its own manifest id, community.aiosports, instead of sharing upstream's ([0e1c2bc](https://github.com/mlp2069/aiosports/commit/0e1c2bc))

### Bug Fixes

* **channels:** remember which channels are dead across restarts, so a deploy no longer brings every empty tile back for the hour the next check takes ([d6b517d](https://github.com/mlp2069/aiosports/commit/d6b517d))
* **artwork:** drop the colour stripes on matchup cards ([56f53d5](https://github.com/mlp2069/aiosports/commit/56f53d5))

### Performance Improvements

* **cache:** keep card warming to a quarter of a core (warm_cpu_share) ([30e5a0b](https://github.com/mlp2069/aiosports/commit/30e5a0b))

## v1.0.1 (2026-09-12)

A channels release. New channel sources, a cover for every channel with its real logo, and a Channels tab that lists one tile per channel and hides the ones that do not play.

### Features

* **artwork:** draw every 24/7 channel as a wide cover: its logo on flat grey with the channel's name underneath ([497ad1a](https://github.com/mlp2069/aiosports/commit/497ad1a), [aca080f](https://github.com/mlp2069/aiosports/commit/aca080f), [76696e9](https://github.com/mlp2069/aiosports/commit/76696e9))
* **artwork:** find each channel's logo in a curated logo set for its own country, add 70 hand-checked logos, and give channels with no usable logo a clean name-only cover ([aca080f](https://github.com/mlp2069/aiosports/commit/aca080f), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **artwork:** lighten dark and navy logos so they read on the grey, without changing brand colours ([3ea390c](https://github.com/mlp2069/aiosports/commit/3ea390c), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **cache:** show in the cache stats how many channels the health check has hidden and how many are waiting on a second check ([40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **channels:** add sec network, which plays but is missing from timstreams' own channel list ([aca080f](https://github.com/mlp2069/aiosports/commit/aca080f))
* **channels:** add usa tv next, cdnlive and timstreams' 24/7 channels as channel sources, and bring back iptv-org for us sports and news channels ([1c73a4f](https://github.com/mlp2069/aiosports/commit/1c73a4f), [c80b69d](https://github.com/mlp2069/aiosports/commit/c80b69d), [f69cd8b](https://github.com/mlp2069/aiosports/commit/f69cd8b), [b74c382](https://github.com/mlp2069/aiosports/commit/b74c382))
* **channels:** hide channels that open to nothing, after two empty checks at least 15 minutes apart or three failed checks over half an hour, and bring them back once they play (hide_empty_channels=0 turns it off) ([40d3318](https://github.com/mlp2069/aiosports/commit/40d3318), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))
* **channels:** label a channel that exists in several countries with its region, such as espn us and espn nz, and never merge two countries' feeds ([1b299af](https://github.com/mlp2069/aiosports/commit/1b299af))
* **channels:** list a channel once when several sources carry it, with all of their streams on the one tile ([b74c382](https://github.com/mlp2069/aiosports/commit/b74c382), [76696e9](https://github.com/mlp2069/aiosports/commit/76696e9), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))
* **channels:** sort the channels tab a to z with numbers in order, and add a genre picker ([aca080f](https://github.com/mlp2069/aiosports/commit/aca080f), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **configure:** list usa tv and iptv-org among the sources so they can be switched off or reordered ([1c73a4f](https://github.com/mlp2069/aiosports/commit/1c73a4f), [b74c382](https://github.com/mlp2069/aiosports/commit/b74c382))
* **providers:** add usatv_base, iptv_categories, iptv_country, cdnlive_countries and cdnlive_health_per_hour for self-hosters ([1c73a4f](https://github.com/mlp2069/aiosports/commit/1c73a4f), [b74c382](https://github.com/mlp2069/aiosports/commit/b74c382), [1b299af](https://github.com/mlp2069/aiosports/commit/1b299af), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))

### Bug Fixes

* **aggregator:** merge one channel listed under different names, such as fs1 and fox sports 1, espn 2 and espn2, tsn 1 and tsn1, fox news channel and fox news, and dazn 1 germany and dazn 1 ([76696e9](https://github.com/mlp2069/aiosports/commit/76696e9), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))
* **aggregator:** stop different channels that share a logo from merging, such as espn and espn deportes, two nbc sports regionals, or spectrum sportsnet and spectrum sportsnet la ([1c73a4f](https://github.com/mlp2069/aiosports/commit/1c73a4f), [669f098](https://github.com/mlp2069/aiosports/commit/669f098))
* **artwork:** fetch logos a few at a time per host and back off a host that rate-limits, so covers still load when a whole tab opens at once ([40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **artwork:** give channels their cover instead of promo art, and keep logos sharp with their frames and lettering intact ([76696e9](https://github.com/mlp2069/aiosports/commit/76696e9), [331da21](https://github.com/mlp2069/aiosports/commit/331da21), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **artwork:** show each channel's own logo instead of a sibling's or another country's, as on fox sports 503, tsn, sportsnet, tnt sports and espn 4 ([1b299af](https://github.com/mlp2069/aiosports/commit/1b299af), [331da21](https://github.com/mlp2069/aiosports/commit/331da21), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **cache:** stop players keeping a placeholder for good when a channel's logo is slow while a whole tab loads ([76696e9](https://github.com/mlp2069/aiosports/commit/76696e9), [40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **channels:** keep iptv-org's abc, cbs, nbc, fox, cw, mnt, galavision and telemundo streams on those networks' tiles while its public-access channels stay out ([2ec89c0](https://github.com/mlp2069/aiosports/commit/2ec89c0))
* **channels:** leave out listings that are not channels: mlb club channels, city public-access and government channels, a radio studio webcam, abc news overflow feeds, qvc and streamed.pk's nfl schedule page ([40d3318](https://github.com/mlp2069/aiosports/commit/40d3318), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))
* **providers:** leave out usa tv next channels whose stream hosts are gone, rechecking every six hours ([71d6ba9](https://github.com/mlp2069/aiosports/commit/71d6ba9))
* **providers:** list espn from streamed.pk as its own channel, and split that feed so espn2, espn deportes and abc get their own streams instead of piling onto espn us ([f69cd8b](https://github.com/mlp2069/aiosports/commit/f69cd8b), [5e71334](https://github.com/mlp2069/aiosports/commit/5e71334))
* **providers:** pause cdnlive player lookups for ten minutes after a rate limit, read its channel list from its second domain when the first fails, and stop fetching its channel images that never load ([f69cd8b](https://github.com/mlp2069/aiosports/commit/f69cd8b), [331da21](https://github.com/mlp2069/aiosports/commit/331da21))
* **streams:** label cdnlive streams as cdnlive and play them with its own referer ([f69cd8b](https://github.com/mlp2069/aiosports/commit/f69cd8b))

### Performance Improvements

* **cache:** keep finished covers and enough logos for the whole channels tab, and warm up to 2500 cards, so opening it does not refetch every logo ([40d3318](https://github.com/mlp2069/aiosports/commit/40d3318))
* **cache:** warm popular channels alongside live fixtures so busy channels like espn return every stream on the first open ([f65015d](https://github.com/mlp2069/aiosports/commit/f65015d))
* **providers:** reuse a cdnlive stream link until shortly before it expires instead of reloading its player page on every open ([f69cd8b](https://github.com/mlp2069/aiosports/commit/f69cd8b))

## v1.0.0 (2026-09-12)

First release under the AIOSports name. The project is a fork of [rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin), and the version resets to 1.0.0 to start its own line.

### Features

* **artwork:** back a fixture detail page with its own crest card rather than the provider's artwork ([e92d9d1](https://github.com/mlp2069/aiosports/commit/e92d9d1))
* **artwork:** fall back to thesportsdb for crests espn has no table for, covering 53 more sides ([8e300e2](https://github.com/mlp2069/aiosports/commit/8e300e2))
* **artwork:** paint generated matchup cards in the two teams' own colours ([56b1e08](https://github.com/mlp2069/aiosports/commit/56b1e08))
* **artwork:** read all 25 espn rugby competitions and wire up the urc, super rugby and six nations badges ([947f0ea](https://github.com/mlp2069/aiosports/commit/947f0ea))
* **artwork:** show real team crests on catalog cards instead of category placeholders ([864da80](https://github.com/mlp2069/aiosports/commit/864da80))
* **artwork:** work out a fixture's competition badge from the crests when no feed names a league ([79b6918](https://github.com/mlp2069/aiosports/commit/79b6918))
* **cache:** render match cards in the background before a tab is opened, with a dashboard to watch it ([22d936e](https://github.com/mlp2069/aiosports/commit/22d936e))
* **catalogs:** collect always-on channels into their own tab instead of scattering them across sports ([3dea763](https://github.com/mlp2069/aiosports/commit/3dea763))
* **catalogs:** give each tab its own settings: hide, search-only, no search, seeded shuffle and reverse ([c6572ea](https://github.com/mlp2069/aiosports/commit/c6572ea))
* **catalogs:** give the nfl its own tab and move the cfl and afl to other football ([008b276](https://github.com/mlp2069/aiosports/commit/008b276))
* **catalogs:** offer a 12- or 24-hour clock for kickoff times alongside the timezone ([399d0e8](https://github.com/mlp2069/aiosports/commit/399d0e8))
* **catalogs:** orient fixtures from espn scoreboards so cards and titles read away @ home ([860146a](https://github.com/mlp2069/aiosports/commit/860146a))
* **catalogs:** show kickoff times as 1:00 pm (et) instead of 13:00 (america/new_york) ([9e0d73f](https://github.com/mlp2069/aiosports/commit/9e0d73f))
* **configure:** add a no-preference stream order, and show my teams once a team is tracked ([e22bf5e](https://github.com/mlp2069/aiosports/commit/e22bf5e))
* **configure:** apply any tab option to every selected tab at once from the bulk bar or the row menu ([6f53ca5](https://github.com/mlp2069/aiosports/commit/6f53ca5))
* **configure:** edit name, description and logo in a dialog, and add favicons and a version line ([8fbae8f](https://github.com/mlp2069/aiosports/commit/8fbae8f))
* **configure:** export and import settings as a json file ([3e5d2b8](https://github.com/mlp2069/aiosports/commit/3e5d2b8))
* **configure:** give each saved setup its own uuid and install url so one server can hold several ([e0d3ed2](https://github.com/mlp2069/aiosports/commit/e0d3ed2))
* **configure:** manage catalog tabs from a row list, and ship the new logo and blue accent across the pages ([60345e9](https://github.com/mlp2069/aiosports/commit/60345e9))
* **configure:** order sources and pick whether direct or web streams come first ([2fc0356](https://github.com/mlp2069/aiosports/commit/2fc0356))
* **configure:** put each catalog row's five options on the row as buttons that light up when set ([935d7df](https://github.com/mlp2069/aiosports/commit/935d7df))
* **configure:** reorder catalog tabs by dragging a handle, and rename any of them ([eefae0f](https://github.com/mlp2069/aiosports/commit/eefae0f))
* **configure:** serve settings from a fixed /saved url so edits apply without reinstalling, and rename to aiosports ([16e7b70](https://github.com/mlp2069/aiosports/commit/16e7b70))
* **configure:** show the install url in a copyable field with a copy button instead of inside a sentence ([821b3d5](https://github.com/mlp2069/aiosports/commit/821b3d5))
* **docker:** publish prebuilt images to ghcr on every push to main ([c062968](https://github.com/mlp2069/aiosports/commit/c062968))
* **manifest:** let each install rename the addon so two of them can be told apart in a player ([7e77e4b](https://github.com/mlp2069/aiosports/commit/7e77e4b))
* **manifest:** show the project's own addon logo in stremio and nuvio ([8037493](https://github.com/mlp2069/aiosports/commit/8037493))
* **providers:** let timstreams fall back to its other hosts when one goes dark, with no rebuild ([294a629](https://github.com/mlp2069/aiosports/commit/294a629))
* **security:** gate every page behind a sign-in and keep admin_token for actions that change state ([cf9007e](https://github.com/mlp2069/aiosports/commit/cf9007e))
* **security:** offer a sign-out on the catalog page when the server asks for a password ([b149bdc](https://github.com/mlp2069/aiosports/commit/b149bdc))

### Bug Fixes

* **aggregator:** keep always-on channels in the catalog instead of expiring them against a merged kickoff ([1e1c060](https://github.com/mlp2069/aiosports/commit/1e1c060))
* **aggregator:** merge duplicate fixtures by the crests both sides resolve to, not by how a provider spelled them ([b5848b4](https://github.com/mlp2069/aiosports/commit/b5848b4))
* **aggregator:** merge duplicate fixtures whose titles say "at" rather than "vs" ([056026f](https://github.com/mlp2069/aiosports/commit/056026f))
* **aggregator:** resolve afl and cfl crests, merge duplicate events, and correct kickoff times that ran 7h late ([c4fb958](https://github.com/mlp2069/aiosports/commit/c4fb958))
* **aggregator:** stop unrelated football listings from collapsing into one match and dropping out of the catalog ([b23ddd5](https://github.com/mlp2069/aiosports/commit/b23ddd5))
* **artwork:** badge cards with the governing body's mark and file dateless channels by their name ([be3b568](https://github.com/mlp2069/aiosports/commit/be3b568))
* **artwork:** look up channel logos for channel-like titles and replace the dead logo urls ([5917f7f](https://github.com/mlp2069/aiosports/commit/5917f7f))
* **artwork:** pick crests from urls that actually fetch so the same game looks alike from every provider ([6a8b759](https://github.com/mlp2069/aiosports/commit/6a8b759))
* **artwork:** restore card image quality to 90 now that it costs no measurable cpu ([fb493c6](https://github.com/mlp2069/aiosports/commit/fb493c6))
* **artwork:** serve catalog cards as jpeg so clients that cannot draw svg posters show them sharp ([b0c362b](https://github.com/mlp2069/aiosports/commit/b0c362b))
* **artwork:** show a crest for a club that plays in several competitions, such as exeter chiefs ([d4e536a](https://github.com/mlp2069/aiosports/commit/d4e536a))
* **artwork:** show the competition crest in the card's logo slot instead of an unreadable title card ([09a902c](https://github.com/mlp2069/aiosports/commit/09a902c))
* **artwork:** stop bare nicknames resolving to the wrong club's crest and repaint the fallback name cards ([4d0390f](https://github.com/mlp2069/aiosports/commit/4d0390f))
* **cache:** version generated card urls so restyled artwork is not hidden behind a day-old cache ([1d654b9](https://github.com/mlp2069/aiosports/commit/1d654b9))
* **catalogs:** badge a college fixture with its own sport's mark, and shorten the college and racing tab names ([8167442](https://github.com/mlp2069/aiosports/commit/8167442))
* **catalogs:** file college fixtures under college when their crests say so and no league is named ([7541772](https://github.com/mlp2069/aiosports/commit/7541772))
* **catalogs:** show rugby crests and file events by their league so nfl games leave the soccer tab ([b804f4d](https://github.com/mlp2069/aiosports/commit/b804f4d))
* **catalogs:** stop any sports selection from silently dropping the college, other football and channels tabs ([65a654d](https://github.com/mlp2069/aiosports/commit/65a654d))
* **catalogs:** stop college fixtures landing beside the nfl or in hockey when a name shortens saint to st ([4b563a1](https://github.com/mlp2069/aiosports/commit/4b563a1))
* **catalogs:** stop the sport filter showing two football boxes, and label soccer cards soccer ([f156729](https://github.com/mlp2069/aiosports/commit/f156729))
* **configure:** drop a tab from catalog management when its sport is switched off ([009a77c](https://github.com/mlp2069/aiosports/commit/009a77c))
* **configure:** give the paired stream-order and support buttons equal size with centred labels ([65aa22d](https://github.com/mlp2069/aiosports/commit/65aa22d))
* **configure:** keep a saved config after a reload instead of restoring the one it replaced ([8b44acd](https://github.com/mlp2069/aiosports/commit/8b44acd))
* **configure:** make unticking sources and sports actually filter, and reset all clear the tab options ([c712504](https://github.com/mlp2069/aiosports/commit/c712504))
* **configure:** point the tip and support buttons and the readme badge at this fork's ko-fi ([e64bd69](https://github.com/mlp2069/aiosports/commit/e64bd69))
* **configure:** say which settings need a reinstall to take effect instead of promising save is enough ([2b5fc3f](https://github.com/mlp2069/aiosports/commit/2b5fc3f))
* **configure:** send a browser to the setup page when nothing is saved instead of answering with json ([1c67828](https://github.com/mlp2069/aiosports/commit/1c67828))
* **configure:** show disabled buttons as disabled, including save while it is saving ([8739761](https://github.com/mlp2069/aiosports/commit/8739761))
* **configure:** stop the footer buttons overlapping and the install button forcing a sideways scroll on phones ([f32998f](https://github.com/mlp2069/aiosports/commit/f32998f))
* **configure:** widen the form so long tab names and the install url are no longer clipped ([1a913bc](https://github.com/mlp2069/aiosports/commit/1a913bc))
* **providers:** file mixed martial arts under mma so both providers' streams land on the same fight ([bd76963](https://github.com/mlp2069/aiosports/commit/bd76963))
* **providers:** follow timstreams to its new domain so its streams load again ([860566c](https://github.com/mlp2069/aiosports/commit/860566c))
* **providers:** route the remaining providers through impit so stricter hosts stop blocking them ([67b8e32](https://github.com/mlp2069/aiosports/commit/67b8e32))
* **security:** keep signed stream urls and their tokens out of the logs ([795b787](https://github.com/mlp2069/aiosports/commit/795b787))
* **security:** require admin_token for the dashboard instead of trusting any caller on a private address ([d82f085](https://github.com/mlp2069/aiosports/commit/d82f085))
* **security:** stop a forged x-forwarded-for granting admin, and load .env so auth_key actually applies ([2a177e9](https://github.com/mlp2069/aiosports/commit/2a177e9))
* **streams:** keep streams playing when the impit binary is missing instead of dropping to the webplayer ([772775c](https://github.com/mlp2069/aiosports/commit/772775c))
* **streams:** return the complete stream list on the first open instead of letting it grow on a reload ([1d95b53](https://github.com/mlp2069/aiosports/commit/1d95b53))
* **streams:** serve the last good playlist on an upstream blip instead of refusing every viewer for 15s ([2fd8068](https://github.com/mlp2069/aiosports/commit/2fd8068))
* **streams:** stop six mirrors of one stream from rendering as identical rows ([7e2d825](https://github.com/mlp2069/aiosports/commit/7e2d825))
* **streams:** stop the liveness check from overloading sources and discarding streams that work ([87002af](https://github.com/mlp2069/aiosports/commit/87002af))

### Performance Improvements

* **artwork:** halve the cpu a card costs to draw and keep 1200 rendered cards instead of 160 ([07b6634](https://github.com/mlp2069/aiosports/commit/07b6634))
* **cache:** warm top live fixtures while a catalog is browsed so the first click answers in milliseconds ([e380873](https://github.com/mlp2069/aiosports/commit/e380873))
* **catalogs:** cut catalog render time roughly sixteenfold by reusing date formatters ([97f0528](https://github.com/mlp2069/aiosports/commit/97f0528))
* **streams:** answer on a deadline instead of waiting for the slowest source, cutting 11s waits to 2-4s ([35b851f](https://github.com/mlp2069/aiosports/commit/35b851f))
