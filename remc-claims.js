/* ==========================================================================
 * remc-claims.js  -  progress claims, one row per claim
 * --------------------------------------------------------------------------
 * Everything about a job's claims used to sit in a single key,
 * remc_progress_claims, holding three different things side by side:
 *
 *     <jobId>          the claims themselves, in order
 *     meta_<jobId>     the header details typed once per job
 *     works_<jobId>    the schedule of works, shared by every claim
 *
 * Saving one percentage rewrote all three, for every job. Now each claim is a
 * row of its own in remc_claims, and the header and the schedule are a row
 * each per job. Typing a percentage sends one row.
 *
 * The pages did not change. This file rebuilds that single key from the rows,
 * and turns a save of the whole key into the smallest set of row changes.
 * ========================================================================== */
(function (root) {
  'use strict';

  var TABLE = 'remc_claims';
  var KEY   = 'remc_progress_claims';

  var d = null;
  var opts = { actor: function () { return ''; }, log: function () {} };
  var _cache = null;

  // Which of the three kinds a row holds. Kept inside data because
  // remc_claims has no column for it and does not need one.
  function kindOf(row) { return (row.data && row.data._kind) || 'claim'; }

  // ------------------------------------------------------------ projection --
  function build() {
    var out = {};
    d.all(TABLE).forEach(function (row) {
      var pid = String(row.project_id);
      var k = kindOf(row);

      if (k === 'meta') {
        var m = {};
        Object.keys(row.data || {}).forEach(function (f) { if (f !== '_kind') m[f] = row.data[f]; });
        out['meta_' + pid] = m;
        return;
      }
      if (k === 'works') {
        out['works_' + pid] = Array.isArray(row.data.items) ? row.data.items.slice() : [];
        return;
      }

      var rec = {};
      Object.keys(row.data || {}).forEach(function (f) { if (f !== '_kind') rec[f] = row.data[f]; });
      rec.id = row.id;
      if (row._pending) rec._pending = true;
      if (row._failed) rec._failed = row._failed;
      (out[pid] = out[pid] || []).push(rec);
    });

    // Claims run in sequence, and the page expects them in that order.
    Object.keys(out).forEach(function (k) {
      if (/^(meta|works)_/.test(k) || !Array.isArray(out[k])) return;
      out[k].sort(function (a, b) {
        var x = parseInt(a.no, 10) || 0, y = parseInt(b.no, 10) || 0;
        if (x !== y) return x - y;
        return String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1;
      });
    });
    return out;
  }

  function project() {
    _cache = build();
    d.writeLegacy(KEY, JSON.stringify(_cache));
  }

  // --------------------------------------------------------------- writing --
  /** Takes the whole remc_progress_claims object, exactly as the page already
   *  wrote it, and works out the smallest set of row changes. A page that
   *  redraws and saves the same object back sends nothing. */
  function writeAll(obj) {
    obj = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    var jobs = [];
    var seen = {};

    Object.keys(obj).forEach(function (key) {
      var v = obj[key];

      // ---- the header details of a job ----
      var mm = /^meta_(.+)$/.exec(key);
      if (mm) {
        var pid = mm[1];
        var id = 'meta_' + pid;
        seen[id] = true;
        var data = { _kind: 'meta' };
        Object.keys(v || {}).forEach(function (f) { data[f] = v[f]; });
        jobs.push(upsert(id, pid, data));
        return;
      }

      // ---- the schedule of works of a job ----
      var wm = /^works_(.+)$/.exec(key);
      if (wm) {
        var wpid = wm[1];
        var wid = 'works_' + wpid;
        seen[wid] = true;
        jobs.push(upsert(wid, wpid, { _kind: 'works', items: Array.isArray(v) ? v : [] }));
        return;
      }

      // ---- the claims of a job ----
      if (!Array.isArray(v)) return;
      v.forEach(function (rec) {
        if (!rec) return;
        if (!rec.id) rec.id = d.newId('pcl');
        seen[String(rec.id)] = true;
        var cd = { _kind: 'claim' };
        Object.keys(rec).forEach(function (f) {
          if (f === 'id' || f === '_pending' || f === '_failed') return;
          cd[f] = rec[f];
        });
        jobs.push(upsert(String(rec.id), key, cd));
      });
    });

    // Anything that was there and is not any more has been deleted on the page.
    d.all(TABLE).forEach(function (row) {
      if (!seen[row.id]) jobs.push(d.remove(TABLE, row.id, { actor: opts.actor() }));
    });

    return Promise.all(jobs);
  }

  function upsert(id, pid, data) {
    var existing = d.byId(TABLE, id);
    if (existing && d.same(existing.data, data)
        && String(existing.project_id) === String(pid)) {
      return Promise.resolve(existing);          // nothing changed, nothing goes up
    }
    return d.save(TABLE, { id: id, project_id: String(pid), data: data },
                  { actor: opts.actor(), idPrefix: 'pcl' });
  }

  // ---------------------------------------------------- what was here before -
  // The first projection rewrites the key from rows that start out empty, so a
  // copy of whatever this computer held is kept once, beforehand.
  var BK = 'remcdl:v1:legacy:claims';

  function keepLegacyCopy() {
    var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return;
    var already = null;
    try { already = s.getItem(BK); } catch (e) {}
    if (already) return;
    var cur = null;
    try { cur = s.getItem(KEY); } catch (e) {}
    if (!cur) return;
    d.writeLegacy(BK, JSON.stringify({ at: new Date().toISOString(), v: cur }));
    opts.log('copy of what was here before kept under ' + BK);
  }

  /** Bring into the table whatever this computer held before. Safe to run
   *  twice: every record keeps its own id. */
  function importLegacy() {
    var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var raw = null;
    try { raw = s && s.getItem(BK); } catch (e) {}
    if (!raw) return Promise.resolve({ claims: 0, note: 'nothing was kept' });
    var bk, obj;
    try { bk = JSON.parse(raw); obj = JSON.parse(bk.v || '{}') || {}; }
    catch (e) { return Promise.reject(new Error('the kept copy cannot be read')); }

    var n = 0;
    Object.keys(obj).forEach(function (k) {
      if (Array.isArray(obj[k])) n += obj[k].length; else n += 1;
    });
    return writeAll(obj).then(function () { return { claims: n }; });
  }

  // ----------------------------------------------------------------- public -
  var api = {
    TABLE: TABLE,
    init: function (o) {
      o = o || {};
      d = o.data || root.remcData;
      if (!d) throw new Error('remc-claims needs the data layer');
      if (o.actor) opts.actor = (typeof o.actor === 'function') ? o.actor : function () { return o.actor; };
      if (o.log) opts.log = o.log;
      d.claim(KEY);
      keepLegacyCopy();
      return api;
    },
    project: function (table) { if (table === TABLE) project(); },
    map: function () { return _cache || (_cache = build()); },
    writeAll: writeAll,
    claimsFor: function (pid) { return api.map()[String(pid)] || []; },
    watch: function (fn) { return d.watch(TABLE, function () { fn(api.map()); }); },

    /** How much this computer had saved before the change. */
    legacyCopy: function () {
      var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      var raw = null; try { raw = s && s.getItem(BK); } catch (e) {}
      if (!raw) return null;
      try {
        var bk = JSON.parse(raw), obj = JSON.parse(bk.v || '{}') || {};
        var claims = 0, jobs = 0;
        Object.keys(obj).forEach(function (k) {
          if (/^(meta|works)_/.test(k)) return;
          jobs++; claims += (obj[k] || []).length;
        });
        return { keptAt: bk.at, jobs: jobs, claims: claims };
      } catch (e) { return null; }
    },
    importLegacy: importLegacy,
    _rebuild: function () { _cache = null; }
  };

  root.remcClaims = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
