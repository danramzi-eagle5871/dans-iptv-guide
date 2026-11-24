// Dan's IPTV TV guide builder (runs on GitHub every 6 hours, see .github/workflows/build.yml).
// Reads the free public XMLTV guides in sources.json, keeps 3 hours back to 30 hours ahead, and writes:
//   out/epg/index.json        {"at": <unix s>, "n": {"<name key>": "<file id>", "us:<name key>": "<file id>", ...}}
//   out/epg/c/<file id>.json  {"p": [[start, end, "title", "description"], ...]}   (unix seconds)
// The app turns each of its channel names into the same key (Epg.kt GuideService.key - keep the two the same!).
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const REGIONS = {
  us: 'us', usa: 'us', uk: 'uk', gb: 'uk', ca: 'ca', can: 'ca',
  ar: 'ar', arab: 'ar', arabic: 'ar', ae: 'ar', uae: 'ar', sa: 'ar', ksa: 'ar', eg: 'ar', qa: 'ar', kw: 'ar', lb: 'ar',
  iq: 'ar', ma: 'ar', dz: 'ar', tn: 'ar', jo: 'ar', om: 'ar', bh: 'ar', sy: 'ar', ye: 'ar', ly: 'ar', sd: 'ar', ps: 'ar', mena: 'ar',
  de: 'de', ger: 'de', deu: 'de', fr: 'fr', fra: 'fr', it: 'it', ita: 'it', es: 'es', esp: 'es', spa: 'es', nl: 'nl', ned: 'nl', hol: 'nl',
  be: 'be', bel: 'be', pt: 'pt', por: 'pt', ch: 'ch', sui: 'ch', swi: 'ch', at: 'at', aut: 'at', ie: 'ie', irl: 'ie', pl: 'pl', pol: 'pl',
  tr: 'tr', tur: 'tr', gr: 'gr', gre: 'gr', al: 'al', alb: 'al', ro: 'ro', rom: 'ro', se: 'se', swe: 'se', no: 'no', nor: 'no', dk: 'dk', den: 'dk',
  fi: 'fi', fin: 'fi', cz: 'cz', sk: 'sk', hu: 'hu', hun: 'hu', yu: 'yu', ex: 'yu', exyu: 'yu', hr: 'yu', cro: 'yu', rs: 'yu', srb: 'yu', ba: 'yu', bih: 'yu',
  bg: 'bg', bul: 'bg', ua: 'ua', ukr: 'ua', lt: 'lt', lv: 'lv', lu: 'lu', mt: 'mt', cy: 'cy', ru: 'ru', rus: 'ru',
  in: 'in', ind: 'in', au: 'au', aus: 'au', nz: 'nz', za: 'za', br: 'br', bra: 'br', mx: 'mx', mex: 'mx', il: 'il', isr: 'il', jp: 'jp', ph: 'ph', my: 'my', sg: 'sg', hk: 'hk'
};
const PREFIX = new RegExp('^\\s*[\\[(|]?\\s*(' + Object.keys(REGIONS).concat(['en', 'pk', 'lat', 'vip']).join('|') + ')\\s*[\\])|:\\-–]+\\s*(?=\\S)');
const QUAL = /\b(?:hd|fhd|uhd|sd|4k|8k|hevc|h ?265|h ?264|1080p?|720p?|2160p?|50 ?fps|60 ?fps|raw|backup|bk|vip|multi|audio|tv|live|hq|lq|low|high|digital|mono)\b/g;
const CHANNEL = /\bchannel\b(?!\s*\d)/g;   // 'Fox News Channel' = 'Fox News', but 'Channel 4' stays

/** "USA| CNN HD" -> {key: "cnn", region: "us", shift: 0}; "MBC SD (-6/hr)" -> {key: "mbc", shift: -6} */
function key(raw) {
  let s = String(raw || '').replace(/&amp;/g, '&').replace(/_/g, ' ').toLowerCase();
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632));
  let region = '', m;
  for (let i = 0; i < 3 && (m = PREFIX.exec(s)); i++) { if (!region && REGIONS[m[1]]) region = REGIONS[m[1]]; s = s.slice(m[0].length); }
  let shift = 0;
  if ((m = /\(\s*([+-])\s*(\d{1,2})\s*(?:\/\s*)?h[a-z]*\s*\)/.exec(s))) shift = (m[1] === '-' ? -1 : 1) * Number(m[2]);
  else if ((m = /\s\+\s?(\d)\s*$/.exec(s))) shift = Number(m[1]);
  s = s.replace(/[\[({][^\])}]{0,14}[\])}]/g, ' ');
  if (shift > 0) s = s.replace(/\s\+\s?\d\s*$/, ' ');
  s = s.replace(/^\s*new\s+(?=bein)/, '').replace(/\s(?:ar|en|fr)\s*$/, ' ')                 // "NEW beIN ... AR"
  s = s.replace(/\bsports?\s*(\d)/g, 'sport $1').replace(/([a-z\s-])0+(\d)/g, '$1$2')            // "SPORTS1" = "sport 1", "max 05" = "max 5"
  s = s.replace(/&/g, ' and ').replace(/\bsports\b/g, 'sport').replace(CHANNEL, ' ').replace(QUAL, ' ');
  s = s.replace(/[^a-z0-9\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]+/g, '');   // Latin, Greek, Cyrillic, Hebrew, Arabic
  return { key: s, region, shift };
}
/** XMLTV channel id "MBC.1.ae" / "en:.Rotana.Drama.ae" -> a name ("MBC 1") */
function idName(id) {
  return String(id).replace(/^(?:en|ar):\.?/i, '').replace(/\.[a-z]{2,6}$/, '').replace(/[._]+/g, ' ');
}
function unxml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').trim();
}
/** "20261123002300 +0000" -> unix seconds */
function time(t) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(t || '');
  if (!m) return 0;
  let s = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) { const sign = m[7][0] === '-' ? -1 : 1; s -= sign * (Number(m[7].slice(1, 3)) * 3600 + Number(m[7].slice(3, 5)) * 60); }
  return s;
}
async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DansIPTV guide builder)' }, signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return (url.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
    } catch (e) { console.log('  try ' + attempt + ' failed: ' + e.message); await new Promise(f => setTimeout(f, 5000 * attempt)); }
  }
  return null;
}

async function main() {
  const { sources } = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
  const now = Math.floor(Date.now() / 1000), from = now - 3 * 3600, to = now + 30 * 3600;
  const out = path.join(__dirname, 'out'), cdir = path.join(out, 'epg', 'c');
  fs.mkdirSync(cdir, { recursive: true });
  const index = {};
  let files = 0, progs = 0;
  for (const src of sources) {
    console.log('source ' + src.url);
    const xml = await download(src.url);
    if (!xml) { console.log('  skipped'); continue; }
    const names = new Map();                                   // channel id -> [display names]
    for (const m of xml.matchAll(/<channel\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
      const dn = [...m[2].matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map(x => unxml(x[1]));
      names.set(unxml(m[1]), dn);
    }
    const lists = new Map();                                   // channel id -> programmes
    for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
      const a = {}; for (const x of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = x[2];
      const st = time(a.start), en = time(a.stop);
      if (!st || !en || en <= from || st >= to || en <= st) continue;
      const t = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(m[2]); if (!t) continue;
      const d = /<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]);
      let desc = d ? unxml(d[1]) : ''; if (desc.length > 220) desc = desc.slice(0, 217).replace(/\s+\S*$/, '') + '…';
      const ch = unxml(a.channel);
      if (!lists.has(ch)) lists.set(ch, []);
      lists.get(ch).push([st, en, unxml(t[1]).slice(0, 120), desc]);
    }
    let here = 0;
    for (const [ch, list] of lists) {
      list.sort((x, y) => x[0] - y[0]);
      const ded = list.filter((p, i) => i === 0 || p[0] !== list[i - 1][0]);
      const fid = crypto.createHash('sha1').update(src.url + '|' + ch).digest('hex').slice(0, 12);
      const keys = new Set([...(names.get(ch) || []), idName(ch)].map(n => key(n).key).filter(k => k.length >= 2));
      let used = false;
      for (const k of keys) {
        if (!index[k]) { index[k] = fid; used = true; }
        if (src.region && !index[src.region + ':' + k]) { index[src.region + ':' + k] = fid; used = true; }
      }
      if (!used) continue;
      fs.writeFileSync(path.join(cdir, fid + '.json'), JSON.stringify({ p: ded }));
      files++; here++; progs += ded.length;
    }
    console.log('  ' + names.size + ' channels, ' + here + ' written');
  }
  fs.writeFileSync(path.join(out, 'epg', 'index.json'), JSON.stringify({ at: now, n: index }));
  const shards = {};
  for (const [k, v] of Object.entries(index)) { const base = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k; const id = shard(base); (shards[id] = shards[id] || {})[k] = v; }
  fs.mkdirSync(path.join(out, 'epg', 'k'), { recursive: true });
  for (const [id, n] of Object.entries(shards)) fs.writeFileSync(path.join(out, 'epg', 'k', id + '.json'), JSON.stringify({ at: now, n }));
  console.log('name pieces: ' + Object.keys(shards).length);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Dan\'s IPTV guide</title><p>TV guide data for the Dan\'s IPTV app, built ' +
    new Date(now * 1000).toISOString() + ' from free public XMLTV guides (epgshare01.online, epg.pw). ' + files + ' channels, ' + progs + ' programmes.</p>');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log('done: ' + files + ' channel files, ' + Object.keys(index).length + ' names, ' + progs + ' programmes');
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
/** which piece of the name list a key is in: its first 2 letters as hex ("mbc1" -> "6d-62") - same in Epg.kt */
function shard(k) { return [...k.slice(0, 2)].map(c => c.codePointAt(0).toString(16)).join('-'); }
/** other keys tried when the first has no guide: "espn1" -> "espn" */
function alts(k) { const a = [k]; if (/[a-z\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]1$/.test(k)) a.push(k.slice(0, -1)); return a; }
module.exports = { key, idName, alts, shard };
