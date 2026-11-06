// Unit tests for the pure popularity helpers in src/core.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { URLSearchParams, URL, TextDecoder, setTimeout, console, navigator: { languages: ['en'] } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8') + '\nthis.C = TTHCore;', ctx);
const C = ctx.C;

let failures = 0;
let autoTest = async () => {};
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = Date.now();

const stats = {
  'yuto arc v': { followers: 900, notes: 20, rate: 1, match: 90, sample: 18, co: [['arc v', 16], ['ruri kurosaki', 9], ['yugioh', 14], ['fallenangelshipping', 5]], at: now },
  'yuto': { followers: 300, notes: 5, rate: 3, match: 20, sample: 4, co: [['yuto arc v', 2]], at: now },
  'yuto yugioh': { followers: 12, notes: 2, rate: 0.1, match: 80, sample: 2, co: [['arc v', 2]], at: now },
  'ygo': { followers: 50000, notes: 30, rate: 200, match: 95, sample: 19, co: [], at: now },
};

// sortByHeat: followers first, unknown tags keep their order at the end, strings untouched
check(eq(C.sortByHeat(['Yuto', 'unknown b', 'yuto arc v', 'unknown a', 'ygo'], stats), ['ygo', 'yuto arc v', 'Yuto', 'unknown b', 'unknown a']), 'sortByHeat orders by followers and keeps unknowns in place');
const tie = { a: { followers: 10, notes: 5, rate: 1 }, b: { followers: 10, notes: 9, rate: 1 } };
check(eq(C.sortByHeat(['a', 'b'], tie), ['b', 'a']), 'sortByHeat breaks follower ties by typical notes');

// heatRanks: 1 = hottest, only sampled tags
const ranks = C.heatRanks(['yuto', 'ygo', 'nope', 'yuto arc v'], stats);
check(C.isUpsell('使用高级版获得无广告浏览，并可提前使用新功能。') && C.isUpsell('Go Ad-Free with Premium') && !C.isUpsell('查看这些博客 example-blog 关注') && !C.isUpsell('ad-free '.repeat(30)), 'isUpsell matches only short ad-free boxes');
check(ranks.get('ygo') === 1 && ranks.get('yuto arc v') === 2 && ranks.get('yuto') === 3 && !ranks.has('nope'), 'heatRanks');

// suggestTagChanges for the character 游斗 with tags [yuto arc v, yuto, yuto yugioh]
const s = C.suggestTagChanges(['yuto arc v', 'yuto', 'yuto yugioh'], stats, { exclude: ['arc v', 'yugioh'] });
check(eq(s.add.map(a => a.tag), ['ruri kurosaki']), 'add: frequent co-tags, excluding own and base tags: ' + JSON.stringify(s.add));
check(s.add[0].share === 0.38, 'add share is per sampled post (9 of 24): ' + s.add[0].share);
check(eq(s.remove.map(r => r.tag + ':' + r.reason), ['yuto:fuzzy', 'yuto yugioh:cold']), 'remove: fuzzy and relatively cold: ' + JSON.stringify(s.remove));
check(C.suggestTagChanges(['yuto arc v', 'ygo'], stats).remove.length === 0, 'no "cold" verdict with fewer than 3 sampled tags');

// Name clashes with other fandoms, from real Tumblr data: 17 of 20 "kurosaki family" posts were Bleach
const clash = {
  'kurosaki family': { followers: 91, notes: 3, rate: 1, match: 100, sample: 20, co: [['bleach', 14], ['ichigo kurosaki', 10], ['karin kurosaki', 6]], at: now },
  'yuto arc v': stats['yuto arc v'],
  'arc v': { followers: 1150, notes: 10, rate: 5, match: 90, sample: 20, co: [['yugioh', 15]], at: now },
};
const fandom = ['yugioh', 'arc v', 'yugioh arc v'];
const r2 = C.suggestTagChanges(['kurosaki family', 'yuto arc v', 'arc v'], clash, { fandom });
check(eq(r2.remove.map(r => r.tag + ':' + r.reason), ['kurosaki family:offtopic']), 'offtopic: tag used mostly by another fandom: ' + JSON.stringify(r2.remove));
check(C.fandomShare('yuto arc v', clash['yuto arc v'], fandom) === 0.89 && C.fandomShare('arc v', clash['arc v'], fandom) === null, 'fandomShare: 16/18 for yuto arc v; fandom tags themselves are not judged');

// judgeTags: one verdict for the templates, the pack review and the cleanup
{
  const h = (n, more) => ({ followers: n, notes: 1, rate: 1, match: 100, ...more });
  const st = { a: h(900), b: h(500), 'c arc v': h(3), 'a arc v': h(2), z: h(0, { rate: 0 }), f: h(50, { match: 10 }), k: h(91, { sample: 20, co: [['bleach', 14]] }) };
  const all = ['a', 'b', 'c arc v', 'a arc v', 'z', 'f', 'k'];
  const v = C.judgeTags(all, st, {}, { fandom: tg => (tg === 'k' ? ['arc v'] : []) });
  check(v.get('k').reason === 'offtopic' && v.get('z').reason === 'dead' && v.get('f').reason === 'fuzzy' && v.get('a arc v').reason === 'cold' && !v.has('a') && !v.has('b'),
    'judgeTags: offtopic, dead, fuzzy, then relatively cold: ' + JSON.stringify([...v]));
  const kept = C.judgeTags(all, st, {}, { keepWords: ['arc v'] });
  check(!kept.has('c arc v') && !kept.has('z') && kept.get('a arc v')?.reason === 'cold', 'judgeTags: with keepWords the only tag carrying a word is never dead or cold: ' + JSON.stringify([...kept]));
  check(C.judgeTags(all, st, { cold: false, match: false, offtopic: false }).size === 1, 'judgeTags: rules switch off cold, fuzzy and offtopic (dead stays)');
}

// statFresh needs the newer fields
check(C.searchMatch('yuto (arc v)', { match: 10 }) === null && C.searchMatch('arc-v', { match: 0 }) === null && C.searchMatch('yuto arc v', { match: 90 }) === 90 && C.searchMatch('游斗', { match: 40 }) === 40, 'searchMatch skips tags with punctuation');
check(!C.suggestTagChanges(['x'], { x: { match: 100, sample: 10, co: [['x (y)', 9], ['x y', 9]], at: Date.now() } }).add.some(e => e.tag === 'x (y)'), 'upkeep never suggests punctuated tags');
{
  // sortTagsFair: subjects take turns, so a cold character's best tag isn't pushed behind a hot one's spellings
  const h = n => ({ followers: n, notes: 1, rate: 1 });
  const st = { yugioh: h(60000), 'arc v': h(1150), zarc: h(213), 'supreme king zarc': h(120), 'zarc arc v': h(43), 'shinji weber': h(20), 'zarc x shinji': h(0) };
  const tags = ['zarc', 'zarc arc v', 'supreme king zarc', 'shinji weber', 'zarc x shinji', 'yugioh', 'arc v'];
  const g = C.nameGroups([...tags, 'fanart', 'art'], ['arc v', 'yugioh']);
  check(g.get('zarc') === g.get('supreme king zarc') && g.get('zarc') !== g.get('shinji weber') && g.get('yugioh') === g.get('arc v') && g.get('fanart') !== g.get('art'),
    'nameGroups: shared names group, a two-name tag merges nothing, fandom-only tags are one work, generic tags stand alone');
  check(eq(C.sortTagsFair(tags, st, { stop: ['arc v', 'yugioh'] }), ['yugioh', 'zarc', 'shinji weber', 'arc v', 'supreme king zarc', 'zarc arc v', 'zarc x shinji']), 'sortTagsFair: each subject\'s best tag first (one for the work), then the rest by heat');
  // with a pack: work first, then characters, then relations; then the rest by heat; old spellings count
  const pk = C.parsePack({ format: 'tth-template-pack', id: 'p', base: ['yugioh', 'arc v'],
    characters: [{ id: 'zarc', name: 'Zarc', tags: ['zarc', 'zarc arc v'], retired: ['zarc (arc v)'] }, { id: 'shinji', name: 'Shinji', tags: ['shinji weber'] }],
    relations: [{ id: 'zs', members: ['zarc', 'shinji'], type: 'romance', tags: ['zarcshinji'] }],
    sections: [{ id: 'fmt', kind: 'format', items: [{ id: 'art', tags: ['fanart'] }] }] });
  const st2 = { ...st, zarcshinji: h(5000), fanart: h(90000), 'zarc (arc v)': h(1) };
  check(eq(C.sortTagsFair(['fanart', 'zarcshinji', 'zarc (arc v)', 'zarc arc v', 'shinji weber', 'zarc', 'arc v', 'yugioh'], st2, C.packGrouping([pk])),
    ['yugioh', 'zarc', 'shinji weber', 'zarcshinji', 'fanart', 'arc v', 'zarc arc v', 'zarc (arc v)']), 'sortTagsFair: work, characters, relations, other; then by heat');
  check(eq(pk.items.get('zarc').retired, ['zarc (arc v)']), 'parsePack keeps retired spellings');
}
{
  // upkeep: retired spellings are replaced in place or removed; only posts with a base tag; other tags untouched
  const pk = C.parsePack({ format: 'tth-template-pack', id: 'p', base: ['arc v'],
    characters: [{ id: 'yuto', tags: ['yuto arc v'], retired: ['yuto (arc v)', 'yuuto arc v'] }, { id: 'ruri', tags: ['ruri kurosaki'] }],
    relations: [{ id: 'sib', members: ['yuto', 'ruri'], type: 'family', tags: [], retired: ['kurosaki siblings'] }] });
  const r1 = C.upkeepTags(['art', 'yuto (arc v)', 'arc v', 'yuuto arc v', 'kurosaki siblings', 'My%20Art'], [pk]);
  check(eq(r1.tags, ['art', 'yuto arc v', 'arc v', 'My%20Art']) && r1.changes.map(c => c.type).join() === 'replace,remove,remove', 'upkeep: replace first retired spelling in place, remove the rest: ' + JSON.stringify(r1.tags));
  check(eq(C.upkeepTags(['yuto arc v', 'yuto (arc v)', 'arc v'], [pk]).tags, ['yuto arc v', 'arc v']), 'upkeep: retired spelling removed when the post already has the item');
  check(C.upkeepTags(['yuto (arc v)', 'bleach'], [pk]).changes.length === 0, 'upkeep: posts without a base tag are left alone');
  const plan = C.planUpkeep([{ key: 'a', tags: ['arc v', 'yuto (arc v)'] }, { key: 'b', tags: ['arc v', 'yuto (arc v)'] }, { key: 'c', tags: ['arc v'] }], [pk]);
  check(plan.posts.length === 2 && plan.rules.length === 1 && plan.rules[0].posts === 2, 'planUpkeep groups changes by rule');
  const keep = new Set();
  check(C.mutations.upkeep([pk], keep, k => k)({ tags: ['arc v', 'yuto (arc v)'] }) === 'upkNothing', 'upkeep mutation skips when no allowed rule applies');
}
{
  // search words: a spelling with a word no other tag has is kept ahead of same-word spellings
  const h = n => ({ followers: n, notes: 1, rate: 1 });
  const st = { 'yuri arc v': h(178), 'yuri (arc v)': h(88), 'yuuri arc v': h(14), 'arc v': h(1150) };
  check(eq(C.sortTagsFair(['yuuri arc v', 'yuri (arc v)', 'yuri arc v', 'arc v'], st, { stop: ['arc v'] }), ['arc v', 'yuri arc v', 'yuuri arc v', 'yuri (arc v)']),
    'sortTagsFair: a new search word (yuuri) comes before a same-word spelling');
  // under the 20-tag cutoff the rest keeps heat order; past it, a new-word spelling moves up just enough
  check(eq(C.sortTagsFair(['arc v', 'yuri arc v', 'arc v yuri', 'yuuri arc v'], { ...st, 'arc v yuri': h(100) }, { stop: ['arc v'] }), ['arc v', 'yuri arc v', 'yuuri arc v', 'arc v yuri']),
    'sortTagsFair: under the cutoff the rest keeps heat order');
  const same = ['my', 'au', 'art', 'fanart', 'fic', 'fanfic', 'ship'].flatMap(g => ['yuri arc v ' + g, 'arc v yuri ' + g, g + ' yuri']);
  const long = ['arc v', 'yuri arc v', ...same, 'yuuri arc v'];
  // as a pack would say: all of them but "arc v" are one character
  const groups = new Map(long.slice(1).map(tg => [tg, { id: 'yuri', rank: 1 }]));
  const out = C.sortTagsFair(long, Object.fromEntries(long.map((tg, i) => [tg, h(1000 - i)])), { stop: ['arc v'], groups });
  check(out.indexOf('yuuri arc v') === 19 && out[18] === same[16] && out.length === long.length, 'sortTagsFair: past the cutoff a new-word spelling is kept within the first 20: ' + out.join());
  const pk = C.parsePack({ format: 'tth-template-pack', id: 'p', base: ['arc v'],
    characters: ['a', 'b', 'c'].map(id => ({ id, tags: id === 'a' ? ['yuri arc v', 'arc v yuri', 'yuuri arc v'] : [id + ' arc v'] })) });
  const res = C.composeTemplate(pk, { ids: ['a', 'b', 'c'], stats: { ...st, 'arc v yuri': h(50) }, rules: { manyAt: 3, spellings: 1 } });
  check(eq(res.rows.filter(r => r.item === 'a' && r.on).map(r => r.tag), ['yuri arc v', 'yuuri arc v']), 'composeTemplate keeps a spelling with a new search word past the spelling limit');
  const sg = C.suggestTagChanges(['yuri arc v', 'arc v yuri', 'yuuri arc v'], { 'yuri arc v': { ...h(178), match: 100 }, 'arc v yuri': { ...h(50), match: 100 }, 'yuuri arc v': { ...h(1), match: 100 } }, { exclude: ['arc v'], fandom: ['arc v'], rules: { coldPct: 40 } });
  check(!sg.remove.some(r => r.tag === 'yuuri arc v'), 'upkeep never suggests removing the only spelling with a search word: ' + JSON.stringify(sg.remove));
}
{
  // upkeep adds the spellings with a search word the post lacks, right after the item's own tag
  const pk = C.parsePack({ format: 'tth-template-pack', id: 'p', base: ['arc v'],
    characters: [{ id: 'yuto', tags: ['yuto arc v', 'arc v yuto', 'yuuto arc v'] }, { id: 'ruri', tags: ['ruri kurosaki'] }],
    sections: [{ id: 'f', kind: 'format', items: [{ id: 'art', tags: ['fanart', 'artists on tumblr'] }] }] });
  const r = C.upkeepTags(['arc v', 'yuto arc v', 'ruri kurosaki', 'fanart'], [pk]);
  check(eq(r.tags, ['arc v', 'yuto arc v', 'yuuto arc v', 'ruri kurosaki', 'fanart']) && r.changes.length === 1 && r.changes[0].type === 'add',
    'upkeep adds the missing search spelling after the character, not same-word ones or format tags: ' + JSON.stringify(r.tags));
  check(C.upkeepTags(['arc v', 'yuto arc v', 'yuuto arc v'], [pk]).changes.length === 0, 'upkeep adds nothing when the words are covered');
  check(C.planUpkeep([{ key: 'a', tags: ['arc v', 'yuto arc v'] }, { key: 'b', tags: ['arc v', 'yuto (arc v)'] }], [C.parsePack({ format: 'tth-template-pack', id: 'q', base: ['arc v'], characters: [{ id: 'y', tags: ['yuto arc v', 'yuuto arc v'], retired: ['yuto (arc v)'] }] })]).rules.length === 2, 'planUpkeep sorts additions next to replacements');
}
{
  // editing posts with a template: recognise items, drop and add, other tags stay
  const h = n => ({ followers: n, notes: 1, rate: 1 });
  const pk = C.parsePack({ format: 'tth-template-pack', id: 'p', base: ['arc v'],
    characters: [{ id: 'yugo', tags: ['yugo arc v', 'yuugo arc v'], retired: ['yugo (arc v)'] }, { id: 'yuri', tags: ['yuri arc v'] }, { id: 'rin', tags: ['rin arc v'] }],
    relations: [{ id: 'apple', members: ['yugo', 'rin'], type: 'romance', tags: ['appleshipping'] }] });
  const posts = [['arc v', 'yugo (arc v)', 'rin arc v', 'appleshipping', 'my doodle'], ['arc v', 'yugo arc v', 'sketch']];
  const counts = C.itemsOnPosts(posts, pk);
  check(counts.get('yugo') === 2 && counts.get('rin') === 1 && counts.get('apple') === 1 && !counts.has('yuri'), 'itemsOnPosts counts items, old spellings included: ' + JSON.stringify([...counts]));
  const st = { 'arc v': h(1000), 'yuri arc v': h(178), 'yugo arc v': h(64), 'rin arc v': h(32) };
  const out = C.retagPost(posts[0], pk, { add: ['yuri'], drop: ['yugo', 'apple'], stats: st, order: C.packGrouping([pk]) });
  check(eq(out, ['arc v', 'yuri arc v', 'rin arc v', 'my doodle']), 'retagPost swaps Yugo (and his ship) for Yuri, keeps other tags, template order: ' + JSON.stringify(out));
  check(C.mutations.retag(pk, { add: [], drop: [], stats: st, order: C.packGrouping([pk]) }, k => k)({ tags: ['arc v', 'yuri arc v'] }) === 'upkNothing', 'retag skips posts it would not change');
}
{
  // reblogs between my blogs: families, diffs, copies, sync after an edit
  check(C.reblogSource({ trail: [{ blog: { name: 'main' }, post: { id: '5' } }] }) === 'main/5' && C.reblogSource({ trail: [] }) === null, 'reblogSource reads the original from the trail');
  const cache = { blogs: {
    't:m': { name: 'main', posts: { 5: [['a', 'b'], 1, 'published', 0, null, true], 6: [['x'], 1, 'published', 0, 'stranger/1', false] } },
    't:s': { name: 'side', posts: { 9: [['a'], 1, 'private', 0, 'main/5', false], 10: [['q'], 1, 'published', 0, null, false] } },
  } };
  const fams = C.reblogFamilies(cache);
  check(fams.get('t:s:9')?.root === 't:m:5' && fams.get('t:m:5')?.members.length === 2 && !fams.has('t:m:6'), 'reblogFamilies links a reblog to its original on my blogs only');
  check(eq([...C.copyKeys(cache)], ['t:s:9']), 'copyKeys lists only the reblog copies');
  const d = C.reblogDiffs(cache);
  check(d.length === 1 && d[0].copy.blog === 't:s' && d[0].copy.id === '9' && d[0].diffs.join() === 'tags,state,label', 'reblogDiffs finds tags, visibility and label differences: ' + JSON.stringify(d));
  check(C.isCopyOf({ trail: [{ blog: { name: 'Main' }, post: { id: '5' } }] }, new Set(['main'])), 'isCopyOf recognises a reblog of my own blog');
  check(C.mutations.copyFrom === undefined && C.syncCopies === undefined, 'there is no copy repair: reblogs are frozen snapshots (R02)');
  check(eq([...C.snapshotKeys(cache)].sort(), ['t:m:6', 't:s:9']), 'snapshotKeys lists every reblog, mine or not');
}
autoTest = async () => {
  // autoMaintain: reblog a new side-blog post to main, leave older ones, fix a drifted reblog; never retry a POST
  const now = Math.floor(Date.now() / 1000);
  const mk = (id, ts, tags, extra = {}) => ({ object_type: 'post', id_string: id, state: 'published', timestamp: ts, tags, content: [], layout: [], reblog_key: 'k' + id, ...extra });
  const db = {
    't:m': [mk('20', now - 50, ['old'], { trail: [{ blog: { name: 'side' }, post: { id: '9' } }] })],
    't:s': [mk('10', now - 10, ['arc v', 'new']), mk('9', now - 9000, ['arc v', 'yuto arc v']), mk('8', now - 9500, ['arc v'])],
  };
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + path.split('?')[0]);
    const m = path.match(/^\/v2\/blog\/([^/?]+)\/posts(?:\/(\w+))?/);
    if (path.startsWith('/v2/user/info')) return { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }, { name: 'side', uuid: 't:s' }] } };
    const blog = decodeURIComponent(m[1]).replace(/^side$/, 't:s').replace(/^main$/, 't:m');
    if (opts.method === 'POST') { calls.push('BODY ' + JSON.stringify(opts.body)); return { id_string: '99' }; }
    if (m[2] && opts.method === 'PUT') { calls.push('PUT ' + blog + '/' + m[2] + ' ' + opts.body.tags); return {}; }
    if (m[2]) return JSON.parse(JSON.stringify(db[blog].find(p => p.id_string === m[2])));
    return { posts: JSON.parse(JSON.stringify(db[blog])) };
  };
  const done = await C.autoMaintain(api, k => k, now - 3600);
  check(eq(done.map(x => x.type + ':' + x.blog + '/' + x.id), ['reblog:side/10']), 'autoMaintain reblogs only the new side post and leaves the older reblog with other tags alone: ' + JSON.stringify(done));
  const body = JSON.parse(calls.find(c => c.startsWith('BODY ')).slice(5));
  check(body.parent_tumblelog_uuid === 't:s' && body.parent_post_id === '10' && body.reblog_key === 'k10' && body.state === 'published' && body.tags === 'arc v,new', 'the reblog carries the original tags: ' + JSON.stringify(body));
  check(!calls.some(c => c.startsWith('PUT')), 'no existing reblog is edited (R02)');
  // the main blog's first page doesn't reach back to a side post reblogged days ago: main is read further back
  // (before=) instead of reblogging it again
  const paged = pageOf => async (path, opts = {}) => {
    if (opts.method === 'POST') { calls.push('POST'); return { id_string: '99' }; }
    if (path.startsWith('/v2/user/info')) return api(path, opts);
    const blog = decodeURIComponent(path.match(/^\/v2\/blog\/([^/?]+)/)[1]);
    const before = +(path.match(/[?&]before=(\d+)/) || [])[1] || Infinity;
    const all = pageOf[blog].filter(p => p.timestamp < before);
    return { posts: JSON.parse(JSON.stringify(all.slice(0, 2))) };
  };
  const aged = { 't:s': [mk('31', now - 100, ['a']), mk('30', now - 200, ['a'])],
    't:m': [mk('42', now - 10, ['x']), mk('41', now - 20, ['x']), mk('40', now - 150, ['a'], { trail: [{ blog: { name: 'side' }, post: { id: '30' } }] })] };
  calls.length = 0;
  const back = await C.autoMaintain(paged(aged), k => k, now - 3600);
  check(eq(back.filter(x => x.type === 'reblog').map(x => x.id), ['31']), 'a side post already reblogged further down main is not reblogged again: ' + JSON.stringify(back));
  // a failing reblog is reported
  const postFails = async (path, opts = {}) => {
    if (opts.method === 'POST') throw Object.assign(new Error('Posting failed'), { status: 500 });
    return api(path, opts);
  };
  const partly = await C.autoMaintain(postFails, k => k, now - 3600);
  check(eq(partly.map(x => x.type + ':' + x.blog + '/' + x.id), ['fail:side/10']) && partly[0].error === 'Posting failed',
    'autoMaintain reports a failed reblog and carries on: ' + JSON.stringify(partly));
  // blog roles: material blogs and blogs with no role stay out of the reblog sync; a blog that became sharing
  // later has only its newer posts reblogged
  const roleBlogs = [{ name: 'main', uuid: 't:m', primary: true }, { name: 'side', uuid: 't:s' }, { name: 'refs', uuid: 't:r' }];
  const roles = { collect: { blog: 't:c' }, blogRoles: { 't:s': { role: 'share', at: (now - 5) * 1000 }, 't:r': { role: 'material' }, 't:x': { role: 'bogus' } } };
  check(C.blogRole(roles, roleBlogs[0]) === 'share' && C.blogRole(roles, 't:c') === 'material' && C.blogRole(roles, 't:r') === 'material'
    && C.blogRole(roles, 't:x') === null && C.libraryRole(roles, 't:x') === 'share', 'blogRole: main sharing, collection material, set roles, unknown role is unset');
  check(eq(C.unsetBlogs({}, roleBlogs).map(b => b.uuid), ['t:s', 't:r']), 'unsetBlogs lists side blogs with no role (never the main blog)');
  const scope = C.reblogScope(roles, roleBlogs);
  check(eq(scope.skip, ['t:r']) && scope.after['t:s'] === now - 5, 'reblogScope skips material blogs and keeps when a blog became sharing: ' + JSON.stringify(scope));
  check(eq(C.reblogScope({}, roleBlogs).skip, ['t:s', 't:r']), 'reblogScope skips blogs with no role yet');
  calls.length = 0;
  const late = await C.autoMaintain(api, k => k, now - 3600, scope);
  check(!late.some(x => x.type === 'reblog'), 'a side post older than the blog becoming sharing is not reblogged: ' + JSON.stringify(late));
  const none = await C.autoMaintain(api, k => k, now - 3600, C.reblogScope({ blogRoles: { 't:s': { role: 'material' } } }, roleBlogs));
  check(none.length === 0 && !calls.some(c => c.startsWith('POST')), 'a material side blog takes no part in the reblog sync');
  const rc = { blogs: { 't:m': { name: 'main', posts: { 1: [['x'], 1, 'published', 0, 'refs/5'] } }, 't:r': { name: 'refs', posts: { 5: [['light'], 1, 'published'] } } },
    blogList: roleBlogs, tagStats: {}, custom: [], hidden: [] };
  const shareView = C.roleCache(rc, roles, 'share'), matView = C.roleCache(rc, roles, 'material');
  check(eq(Object.keys(shareView.blogs), ['t:m']) && eq(Object.keys(matView.blogs), ['t:r']) && shareView.blogs['t:m'] === rc.blogs['t:m'], 'roleCache splits the blogs and shares the records');
  check(C.copyKeys(shareView).size === 0, 'a reblog from a material blog is not a copy on the sharing side');
  check(C.buildIndex(matView).tags.has('light') && !C.buildIndex(shareView).tags.has('light'), 'the material library has its own tags');
  // schema 2: the 0.9.3 collection moves into materials and its blog becomes material; done once
  const old093 = { settings: { collect: { blog: 't:c' }, lang: 'zh' }, collection: { blog: 't:c', syncedAt: 5, posts: { 1: ['a/1', 1, [], ['light']] } } };
  const mig = C.migrateMaterials(old093);
  check(mig && mig.set.materials['t:c'] === old093.collection && eq(mig.remove, ['collection']) && mig.set.settings.schema === 2
    && mig.set.settings.blogRoles['t:c'].role === 'material' && mig.set.settings.lang === 'zh', 'migrateMaterials moves the 0.9.3 collection into materials');
  check(C.migrateMaterials(mig.set) === null, 'migrateMaterials runs once');
  check(eq(C.migrateMaterials({}).set.materials, {}) && eq(C.migrateMaterials({}).remove, []), 'migrateMaterials on empty storage only sets the schema');
  let posts = 0;
  const failing = C.makeApi(async (p, { method }) => { if (method === 'POST') { posts++; throw Object.assign(new Error('boom'), { status: 503 }); } return {}; });
  await failing('/v2/blog/x/posts', { method: 'POST', body: {} }).catch(() => {});
  check(posts === 1, 'a failed POST is not retried (no double reblog)');

  // reblog control: set on my posts, opened only for a reblog between my own blogs, copied to my reblogs
  const store = { 1: mk('1', now, ['a'], { interactability_reblog: 'everyone' }) };
  const log = [];
  const rapi = async (path, opts = {}) => {
    const id = path.match(/\/posts\/(\w+)/)?.[1];
    if (opts.method === 'PUT') { log.push('PUT ' + id + ' ' + opts.body.interactability_reblog); store[id].interactability_reblog = opts.body.interactability_reblog || store[id].interactability_reblog; return {}; }
    if (opts.method === 'POST') { log.push('POST ' + opts.body.interactability_reblog + ' while ' + store[1].interactability_reblog); return { id_string: '2' }; }
    return JSON.parse(JSON.stringify(store[id]));
  };
  const r1 = await C.editPost(rapi, k => k, 'side', '1', C.mutations.reblog('noone'));
  check(r1.reblog === 'noone' && store[1].interactability_reblog === 'noone', 'mutations.reblog turns reblogs off');
  check((await C.editPost(rapi, k => k, 'side', '1', C.mutations.reblog('noone'))).unchanged, 'turning off reblogs twice changes nothing');
  log.length = 0;
  await C.editPost(rapi, k => k, 'side', '1', C.mutations.addTags(['b']));
  check(eq(log, ['PUT 1 noone']), 'other edits keep reblogs off: ' + JSON.stringify(log));
  log.length = 0;
  await C.reblogPost(rapi, 't:m', 't:s', '1', 'published');
  check(eq(log, ['POST noone while noone']), 'reblogPost reblogs a closed post of mine as is, and closes the reblog: ' + JSON.stringify(log));
  log.length = 0;
  const strict = async (path, opts = {}) => {
    if (opts.method === 'POST' && store[1].interactability_reblog === 'noone') { log.push('POST refused'); throw Object.assign(new Error('no'), { status: 403 }); }
    return rapi(path, opts);
  };
  await C.reblogPost(strict, 't:m', 't:s', '1', 'published');
  check(eq(log, ['POST refused', 'PUT 1 everyone', 'POST noone while everyone', 'PUT 1 noone']) && store[1].interactability_reblog === 'noone',
    'if Tumblr refuses, reblogPost opens the original just for the reblog and closes it again: ' + JSON.stringify(log));
  const dc = { blogs: { 't:m': { name: 'main', posts: { 5: [['a'], 1, 'published', 0, null, false, 'noone'] } }, 't:s': { name: 'side', posts: { 9: [['a'], 1, 'published', 0, 'main/5', false, 'everyone'] } } } };
  check(C.reblogDiffs(dc)[0]?.diffs.join() === 'reblog', 'reblogDiffs finds a reblog whose reblog control differs');

  // collection blog: likes paged by `before`, my own and closed posts left out, already collected ones skipped
  const img = { type: 'image', media: [{ url: 'u-big', width: 1280 }, { url: 'u-small', width: 250 }] };
  const like = (id, owner, lts, extra = {}) => ({ object_type: 'post', id_string: id, blog_name: owner, blog: { name: owner, uuid: 't:' + owner }, reblog_key: 'k' + id, liked_timestamp: lts, timestamp: lts - 5, content: [img], trail: [], ...extra });
  const likes = [like('1', 'artist', now - 10), like('2', 'other', now - 20, { trail: [{ blog: { name: 'artist' }, post: { id: '7' } }] }), like('3', 'side', now - 30),
    like('4', 'closed', now - 40, { interactability_reblog: 'noone' }), like('5', 'texty', now - 50, { content: [] }), ...Array.from({ length: 20 }, (_, i) => like('o' + i, 'old', now - 5000 - i))];
  const colDb = [{ object_type: 'post', id_string: '50', timestamp: now - 9999, trail: [{ blog: { name: 'artist' }, post: { id: '7' } }], content: [], state: 'published' }];
  const ccalls = [];
  const capi = async (path, opts = {}) => {
    if (path.startsWith('/v2/user/info')) return { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }, { name: 'side', uuid: 't:s' }, { name: 'col', uuid: 't:c' }] } };
    if (path.startsWith('/v2/user/likes')) {
      ccalls.push('LIKES ' + path);
      const before = +new URLSearchParams(path.split('?')[1]).get('before') || Infinity;
      const page = likes.filter(p => p.liked_timestamp < before).slice(0, 3);
      return { liked_posts: page, liked_count: likes.length };
    }
    if (opts.method === 'POST') { ccalls.push('POST ' + path + ' ' + JSON.stringify(opts.body)); return { id_string: 'n' + ccalls.length }; }
    return { posts: colDb };
  };
  const all = await C.likedPosts(capi);
  check(all.length === likes.length && ccalls.filter(c => c.startsWith('LIKES')).length === 10, 'likedPosts pages through all likes with before= until an empty page: ' + all.length);
  const have = new Set(colDb.map(C.rootKey));
  const why = all.slice(0, 5).map(p => C.collectSkip(p, have, new Set(['main', 'side']), { imagesOnly: true }));
  check(eq(why, ['', 'have', 'mine', 'closed', 'noImages']), 'collectSkip: new, already collected (same original), my own, reblogs off, no images: ' + JSON.stringify(why));
  check(C.collectSkip(all[4], have, new Set(), { imagesOnly: false }) === '', 'collectSkip keeps text posts when imagesOnly is off');
  ccalls.length = 0;
  const r = await C.autoCollect(capi, { blog: 't:c', tags: ['color'], imagesOnly: true }, now - 1000);
  const cposts = ccalls.filter(c => c.startsWith('POST'));
  check(cposts.length === 1 && cposts[0].includes('/v2/blog/t%3Ac/posts') && cposts[0].includes('"parent_tumblelog_uuid":"t:artist"') && cposts[0].includes('"tags":"color"'),
    'autoCollect reblogs only the new liked post to the collection with its tags: ' + JSON.stringify(cposts));
  check(r.last === now - 10 && eq(r.skipped.map(s => s.reason), ['noImages', 'closed', 'mine']), 'autoCollect moves since to the newest like and reports what it left out: ' + JSON.stringify(r));
  check(ccalls.filter(c => c.startsWith('LIKES')).length === 2, 'autoCollect stops reading likes at since');
  const limited = async (path, opts = {}) => {
    if (opts.method === 'POST') throw Object.assign(new Error('x'), { status: 400, body: { errors: [{ detail: "You've exceeded your daily post or media limit. Please try again tomorrow." }] } });
    return capi(path, opts);
  };
  const rl = await C.autoCollect(limited, { blog: 't:c', tags: [], imagesOnly: true }, now - 1000);
  check(rl.error && rl.last === now - 20 && !rl.skipped.some(s => /limit/.test(s.reason)),
    'autoCollect stops at the daily post limit and tries that like again next time: ' + JSON.stringify(rl));
  check(C.isPostLimit({ status: 429 }) && !C.isPostLimit({ status: 400, message: 'Bad request' }), 'isPostLimit');
  const m2 = await C.autoMaintain(async (path, opts = {}) => {
    if (path.startsWith('/v2/user/info')) return { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }, { name: 'col', uuid: 't:c' }] } };
    if (opts.method === 'POST') throw new Error('must not reblog');
    return { posts: path.includes('t%3Ac') ? [{ object_type: 'post', id_string: '1', timestamp: now, state: 'published', content: [], tags: [] }] : [] };
  }, k => k, now - 3600, { skip: ['t:c'] });
  check(m2.length === 0, 'autoMaintain leaves the collection blog out');


  // reference categories: every tag in one group only, each with a Chinese name; palette from pixels
  const refTags = C.REF_GROUPS.flatMap(g => g.tags);
  check(new Set(refTags).size === refTags.length && refTags.every(tg => C.key(tg) === tg && /^[a-z0-9 ]+$/.test(tg)), 'reference tags are unique, lowercase and unpunctuated');
  check(refTags.every(tg => C.STRINGS.zh.refNames[tg]), 'every reference tag has a Chinese name: ' + refTags.filter(tg => !C.STRINGS.zh.refNames[tg]));
  check(C.refGroupOf('Backlight') === 'light' && C.refGroupOf('warm palette') === 'palette' && C.refGroupOf('my own tag') === null, 'refGroupOf');
  const pix = f => { const a = new Uint8ClampedArray(32 * 32 * 4); for (let i = 0; i < 32 * 32; i++) a.set([...f(i % 32, Math.floor(i / 32)), 255], i * 4); return a; };
  const has = (tags, ...want) => want.every(w => tags.includes(w));
  const sunset = C.paletteTags(pix((x, y) => [230, 120 + y * 2, 40]));
  check(has(sunset, 'warm palette', 'high saturation') && !sunset.includes('cool palette'), 'paletteTags: sunset is warm and saturated: ' + sunset);
  const night = C.paletteTags(pix((x, y) => [20, 30 + y, 80 + y]));
  check(has(night, 'cool palette', 'low key'), 'paletteTags: night blue is cool and dark: ' + night);
  const gray = C.paletteTags(pix(x => [x * 8, x * 8, x * 8]));
  check(has(gray, 'grayscale', 'high contrast') && !gray.includes('warm palette'), 'paletteTags: a gray ramp is grayscale with high contrast: ' + gray);
  const ob = C.paletteTags(pix(x => (x < 16 ? [240, 130, 30] : [30, 90, 220])));
  check(has(ob, 'warm cool contrast', 'complementary colors'), 'paletteTags: orange against blue: ' + ob);
  check(C.paletteTags(new Uint8ClampedArray(16)).length === 0, 'paletteTags: a transparent image gives nothing');

  // AI sorting: only listed tags survive, in list order; a provider without response_format is asked again
  check(eq(C.parseAiTags('```json\n{"light": ["Soft Light", "made up"], "material": ["fur"], "palette": ["warm palette"], "x": 3}\n```'), ['soft light', 'fur']),
    'parseAiTags keeps listed hand-picked tags only, case-insensitive');
  check(eq(C.parseAiTags('{"light": ["backlight", "rim light", "side light", "fog"]}'), ['backlight', 'rim light']), 'parseAiTags keeps at most two tags per list');
  check(eq(C.parseAiTags('no json here'), []) && eq(C.parseAiTags('{broken'), []), 'parseAiTags survives replies without JSON');
  check(!C.aiPrompt().includes('warm palette') && C.aiPrompt().includes('backlight'), 'the prompt lists the hand-picked groups, not the palette');
  const aiCalls = [];
  const aiFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    aiCalls.push(url + ' ' + ('response_format' in body) + ' ' + opts.headers.Authorization);
    if (body.response_format) return { ok: false, status: 400, statusText: 'Bad', json: async () => ({ error: { message: 'response_format is not supported' } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"composition": ["close up"], "subject": ["animal"]}' } }] }) };
  };
  const aiTags = await C.aiTagImage({ base: 'https://ai.example/v1/', model: 'm' }, 'k', 'data:image/jpeg;base64,AA', aiFetch);
  check(eq(aiTags.tags, ['close up', 'animal']) && aiTags.aiArt === null && eq(aiCalls, ['https://ai.example/v1/chat/completions true Bearer k', 'https://ai.example/v1/chat/completions false Bearer k']),
    'aiTagImage posts to <base>/chat/completions and retries without response_format: ' + JSON.stringify(aiCalls));
  let aiErr = '';
  await C.aiTagImage({ base: 'https://ai.example/v1', model: 'm' }, 'k', 'x', async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) })).catch(e => { aiErr = e.message; });
  check(/tokens/.test(aiErr), 'aiTagImage says when the reply ran out of tokens');
  let multi;
  await C.aiTagImage({ base: 'https://ai.example/v1', model: 'm' }, 'k', Array.from({ length: 12 }, (_, i) => 'img' + i), async (u, init) => {
    multi = JSON.parse(init.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"light": []}' } }] }) };
  });
  check(multi.filter(c => c.type === 'image_url').length === C.AI_MAX_IMAGES && multi[0].text.includes(`These ${C.AI_MAX_IMAGES} images are all from one post`),
    'aiTagImage sends a post\'s images in one request, at most AI_MAX_IMAGES, and says they are one post');
  check(!C.aiPrompt('', 1).includes('one post') && C.aiImageSize(1) === 768 && C.aiImageSize(4) === 384 && C.aiImageSize(10) === 384, 'one image: plain prompt; more images: smaller each');

  // AI-made images: clues from tags and replies, "not ai" never counts for, one voice is not enough
  check(eq(['ai art', 'AI-generated', 'midjourney', 'stable diffusion', 'made with ai'].map(x => C.aiArtSignal(x)), ['yes', 'yes', 'yes', 'yes', 'yes']), 'aiArtSignal: AI-art tags');
  check(eq(['not ai art', 'no ai', 'anti ai', 'human art', 'ai free'].map(x => C.aiArtSignal(x)), ['no', 'no', 'no', 'no', 'no']), 'aiArtSignal: "not AI" tags count against');
  check(eq(['ai', 'Ai (character)', 'digital art', 'https://example.ai/x'].map(x => C.aiArtSignal(x)), [null, null, null, null]), 'aiArtSignal: a bare "ai", a name or a .ai link is no clue');
  check(C.aiArtSignal('this is ai', true) === 'yes' && C.aiArtSignal('is this ai?', true) === null && C.aiArtSignal('this is ai') === null, 'aiArtSignal: "this is AI" counts in replies only');
  check(C.aiArtVerdict({ owner: ['art', 'ai art'] }).verdict === 'ai' && C.aiArtVerdict({ owner: ['not ai art'], others: [{ blog: 'a', text: 'ai art' }, { blog: 'b', text: 'ai art' }] }).verdict === null,
    'aiArtVerdict: the poster\'s own tags decide first');
  const oth = n => Array.from({ length: n }, (_, i) => ({ blog: 'b' + i, text: 'ai art' }));
  check(C.aiArtVerdict({ others: oth(1) }).verdict === null && C.aiArtVerdict({ others: [...oth(1), { blog: 'B0', text: '#ai generated' }] }).verdict === null,
    'aiArtVerdict: one blog (even tagging twice) is not enough');
  check(C.aiArtVerdict({ others: oth(2) }).verdict === 'suspect' && C.aiArtVerdict({ others: [...oth(3), { blog: 'x', text: 'not ai' }] }).verdict === null,
    'aiArtVerdict: two blogs make it suspect, unless someone says it is not');
  check(C.aiArtVerdict({ vision: 'yes' }).verdict === 'suspect' && C.parseAiArt('{"light": [], "ai_generated": "yes"}') === 'yes' && C.parseAiArt('{"ai_generated": "unsure"}') === null,
    'aiArtVerdict: a sure vision model makes it suspect');
  // collecting: a like its poster tagged as AI-made is left out and unliked
  const aiLikes = [like('a1', 'artist', now - 10, { tags: ['ai art'] }), like('a2', 'other', now - 20, { trail: [{ blog: { name: 'maker' }, post: { id: '9' } }] }), like('a3', 'painter', now - 30, { tags: ['not ai art'] })];
  const aiCallsC = [];
  const aapi = async (path, opts = {}) => {
    if (path.startsWith('/v2/user/info')) return { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }, { name: 'col', uuid: 't:c' }] } };
    if (path.startsWith('/v2/user/likes')) return { liked_posts: path.includes('before') ? [] : aiLikes };
    if (path.startsWith('/v2/user/unlike')) { aiCallsC.push('UNLIKE ' + opts.body.id); return {}; }
    if (path.startsWith('/v2/blog/maker/posts/9')) return { tags: ['midjourney'] };
    if (opts.method === 'POST') { aiCallsC.push('REBLOG ' + opts.body.parent_post_id); return { id_string: 'n' }; }
    return { posts: [] };
  };
  const ac = await C.autoCollect(aapi, { blog: 't:c', tags: [], imagesOnly: true, autoPalette: false }, now - 1000);
  check(eq(aiCallsC, ['REBLOG a3', 'UNLIKE a2', 'UNLIKE a1']) && eq(ac.skipped.map(x => x.reason), ['aiArt', 'aiArt']),
    'autoCollect leaves out and unlikes posts tagged as AI by their poster (also for a reblog, by its original): ' + JSON.stringify(aiCallsC));

  // AI notes: one text block in the post, replaced on the next run; layout rows follow the blocks
  const img1 = { type: 'image', media: [] }, old = { type: 'text', text: C.AI_NOTE_MARK + 'old note' }, mine = { type: 'text', text: 'my words' };
  const c1 = C.withAiNote([img1, old, mine], 'new note');
  check(c1.length === 3 && c1[2].text === C.AI_NOTE_MARK + 'new note' && !c1.includes(old) && C.aiNoteOf(c1) === 'new note', 'withAiNote replaces the old note and keeps the rest');
  check(eq(C.withAiNote([img1, old], ''), [img1]), 'withAiNote with no text removes the note');
  const lay = C.relayout([{ type: 'rows', display: [{ blocks: [0] }, { blocks: [1] }, { blocks: [2] }] }], [img1, old, mine], c1);
  check(eq(lay[0].display.map(r => r.blocks), [[0], [1], [2]]), 'relayout: the removed note\'s row is dropped, the others follow their blocks, the new note gets a row: ' + JSON.stringify(lay));
  check(C.parseAiNotes('{"light": [], "notes": " 逆光：太阳在花后面。 "}') === '逆光：太阳在花后面。' && C.parseAiNotes('nope') === '', 'parseAiNotes');
  check(C.aiPrompt('en').includes('"notes" in English') && C.aiPrompt('zh').includes('"notes" in Simplified Chinese') && !C.aiPrompt('').includes('notes'), 'the prompt asks for notes only when wanted, in the chosen language');
  const sent = [];
  let reblogged = true;
  const napi = async (path, opts = {}) => {
    if (opts.method === 'PUT') { sent.push(opts.body); return {}; }
    return { state: 'published', tags: ['color', 'sky'], content: [], layout: [], ...(reblogged ? { parent_post_id: '1', trail: [{ blog: { name: 'a' }, post: { id: '1' }, content: [{ type: 'text', text: 'theirs' }] }] } : {}) };
  };
  // a reblog is a frozen snapshot: no tag, order, note or body change is sent (R02, R09)
  for (const mut of [n => Object.assign(n, { tags: [...n.tags, 'fog'] }), n => Object.assign(n, { tags: ['sky', 'color'] }), n => Object.assign(n, { content: C.withAiNote(n.content, 'misty') }), C.aiWrite(false, ['fog'], 'misty')]) {
    const r = await C.editPost(napi, k => k, 't:c', '5', mut);
    check(r.skipped && r.snapshot, 'editPost refuses to change a reblog\'s tags or body');
  }
  check(sent.length === 0, 'nothing was sent for the snapshot');
  // visibility of the same reblog is a separate operation and sends its own payload back unchanged
  await C.editPost(napi, k => k, 't:c', '5', C.mutations.state(k => k, x => x, 'private'));
  check(sent.length === 1 && sent[0].state === 'private' && sent[0].tags === 'color,sky' && eq(sent[0].content, []), 'hiding a reblog keeps its tags and body: ' + JSON.stringify(sent[0]));
  sent.length = 0;
  reblogged = false;
  await C.editPost(napi, k => k, 't:c', '5', n => Object.assign(n, { tags: ['color', 'fog'], content: C.withAiNote(n.content, 'misty') }));
  check(sent[0]?.tags === 'color,fog' && eq(sent[0]?.content, [{ type: 'text', text: C.AI_NOTE_MARK + 'misty' }]) && eq(sent[0]?.layout, []), 'editPost sends a changed content with the tags: ' + JSON.stringify(sent[0]));
  sent.length = 0;
  await C.editPost(napi, k => k, 't:c', '5', n => n);
  check(sent.length === 0, 'editPost leaves a post alone when nothing changed');
  const lightTag = C.REF_GROUPS.find(g => g.id === 'light').tags[0], lightTag2 = C.REF_GROUPS.find(g => g.id === 'light').tags[1];
  const redone = C.aiWrite(true, [lightTag2], 'new')({ tags: ['mine', lightTag, C.AI_MARK], content: [{ type: 'text', text: C.AI_NOTE_MARK + 'old' }] });
  check(eq(redone.tags, ['mine', C.AI_MARK, lightTag2]) || eq(redone.tags.slice().sort(), ['mine', C.AI_MARK, lightTag2].sort()), 'aiWrite redo replaces tags in the AI lists, keeps others: ' + JSON.stringify(redone.tags));
  check(eq(redone.content, [{ type: 'text', text: C.AI_NOTE_MARK + 'new' }]), 'aiWrite redo replaces the note');
  const first = C.aiWrite(false, [lightTag2])({ tags: [lightTag], content: [] });
  check(first.tags.includes(lightTag) && first.tags.includes(lightTag2) && first.tags.includes(C.AI_MARK), 'aiWrite first time keeps hand tags');
  const store2 = { posts: { a: ['x', 1, [['s1', 'b1']]], b: ['y', 1, [['s2', 'b2'], ['s3', 'b3']]], c: ['z', 1, []], d: ['w', 1, [['s4', 'b4']]] } };
  const p1 = C.dailyPick(store2, 2, 'day|0'), p2 = C.dailyPick(store2, 2, 'day|0');
  check(eq(p1, p2) && p1.length === 2 && new Set(p1.map(p => p.id)).size === 2 && !p1.some(p => p.id === 'c'), 'dailyPick: same seed, same picks; distinct posts with images: ' + JSON.stringify(p1));
  check(C.dailyPick(store2, 9, 'x').length === 3, 'dailyPick gives at most one image per post');
  const seeds = new Set(Array.from({ length: 12 }, (_, k) => C.dailyPick(store2, 1, 'day|' + k)[0].id));
  check(seeds.size >= 2, 'dailyPick changes with the seed');
};
check(C.statFresh(stats['yuto arc v']) && !C.statFresh({ match: 1, followers: 1, at: now }), 'statFresh requires co');
{
  const img = (name, width, height) => ({ type: 'image', media: [{ url: name, width, height }] });
  const p = { content: [], trail: [{ content: [img('strip', 2048, 142), img('forest', 1280, 1920), img('strip2', 2048, 142)] }] };
  check(eq(C.postImages(p).map(i => i.small), ['forest', 'strip', 'strip2']), 'postImages: decorative strips go after the real image');
  check(C.postImages({ content: [img('strip', 2048, 142)] })[0].small === 'strip', 'postImages: a strip alone is still returned');
}

// "show only recent": older posts with images go private, come back when the period gets longer or is off
const recentTest = async () => {
  const now = 1000 * 86400;
  const img = { type: 'image', media: [{ url: 'u', width: 500, height: 500 }] };
  const mk = (id, ageDays, extra = {}) => ({ object_type: 'post', id_string: id, state: 'published', timestamp: now - ageDays * 86400, tags: [], content: [img], layout: [], ...extra });
  const db = [mk('1', 1), mk('2', 10, { is_pinned: true }), mk('3', 20), mk('4', 40, { content: [{ type: 'text', text: 'x' }] }), mk('5', 50), mk('6', 60, { state: 'private' }), mk('7', 70)];
  const puts = [];
  const api = async (path, opts = {}) => {
    if (path.startsWith('/v2/user/info')) return { user: { blogs: [{ name: 'main', uuid: 't:m', primary: true }] } };
    const m = path.match(/\/posts\/(\d+)/);
    if (m && opts.method === 'PUT') { puts.push(m[1] + ':' + opts.body.state); db.find(p => p.id_string === m[1]).state = opts.body.state; return {}; }
    if (m) return JSON.parse(JSON.stringify(db.find(p => p.id_string === m[1])));
    return { posts: JSON.parse(JSON.stringify(db)) };
  };
  const set = d => ({ recentOnly: { 't:m': d } });
  check(C.recentDays(set(30), 't:m') === 30 && C.recentDays(set(13), 't:m') === 0, 'recentDays takes only listed periods');
  let r = await C.autoRecent(api, k => k, set(30), {}, { now });
  check(eq(puts, ['5:private', '7:private']) && eq(Object.keys(r.state['t:m'].ids), ['5', '7']) && r.state['t:m'].done === now - 30 * 86400,
    'autoRecent hides old image posts, not pinned, text-only, newer or already private ones: ' + JSON.stringify(puts));
  puts.length = 0;
  r = await C.autoRecent(api, k => k, set(30), r.state, { now: now + 15 * 86400 });
  check(eq(puts, ['3:private']), 'the next pass only looks at posts that aged out since: ' + JSON.stringify(puts));
  puts.length = 0;
  const capped = await C.autoRecent(api, k => k, set(7), r.state, { now: now + 15 * 86400, max: 0 });
  check(!puts.length && capped.state['t:m'].done === r.state['t:m'].done, 'a pass cut short by the cap doesn\'t move done');
  r = await C.autoRecent(api, k => k, set(90), r.state, { now: now + 30 * 86400 });
  check(eq(puts.sort(), ['3:published', '5:published']) && eq(Object.keys(r.state['t:m'].ids), ['7']), 'a longer period makes the posts in it public again: ' + JSON.stringify(puts));
  puts.length = 0;
  db.find(p => p.id_string === '7').state = 'published'; // made public by hand
  r = await C.autoRecent(api, k => k, {}, r.state, { now: now + 15 * 86400 });
  check(!puts.length && !r.state['t:m'], 'switched off: a post made public by hand is let go and the record goes');
  check(eq([...C.recentKeys({ 't:m': { ids: { 5: 1 } } })], ['t:m:5']), 'recentKeys lists hidden posts');
  const dc = { blogs: { 't:s': { name: 'side', posts: { 1: [['a'], 1, 'published', 0, null, false, 'everyone'] } }, 't:m': { name: 'main', posts: { 2: [['a'], 1, 'private', 0, 'side/1', false, 'everyone'] } } }, blogList: [], custom: [], hidden: [], tagStats: {} };
  check(C.reblogDiffs(dc).length === 1 && C.reblogDiffs(dc, new Set(['t:m:2'])).length === 0, 'reblogDiffs ignores visibility of hidden posts');
};

const guardTest = async () => {
  let managed = false; const sent = [];
  const req = C.guardWrites(async (p, o) => { sent.push(o.method); return { ok: 1 }; }, async () => managed, () => 'studio');
  await req('/a', { method: 'GET' }); await req('/b', { method: 'PUT' });
  managed = true;
  await req('/c', { method: 'GET' });
  let err = null; try { await req('/d', { method: 'POST' }); } catch (e) { err = e; }
  check(sent.join() === 'GET,PUT,GET' && err?.managed && err.message === 'studio', 'guardWrites refuses writes only while Studio is in charge');
};

autoTest().then(recentTest).then(guardTest).then(() => { console.log(failures ? `${failures} FAILED` : 'all passed'); process.exit(failures ? 1 : 0); });
