# Dan's IPTV - TV guide data

Program guide (EPG) data for the Dan's IPTV app, rebuilt every 6 hours by GitHub Actions from free public XMLTV guides
(epgshare01.online and epg.pw) - Arab countries, North America, all of Europe and more. Only 3 hours back to 30 hours ahead are kept, one small file per channel, plus a name index.
The app matches its channel names to this index when the TV service sends no guide of its own.

- `build.js` - the builder, `sources.json` - the guides it reads.
- Output: `epg/index.json` and `epg/c/<id>.json` on GitHub Pages.
