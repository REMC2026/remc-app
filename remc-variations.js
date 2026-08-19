/* ==========================================================================
 * remc-variations.js  -  variations, one row per variation
 * --------------------------------------------------------------------------
 * Until now the same variation lived in two places: a record in
 * remc_variations and a request in remc_variation_requests, tied together by
 * a field. Keeping the two in step is what made variations raised on a phone
 * fail to reach the office.
 *
 * Now it is a single row in remc_variations. Where it sits in the approval
 * run is a column on that row:
 *
 *     approval   raised on site, waiting on the office
 *     check      the office is looking at it
 *     approved   approved - only now does it land on the job
 *     declined   not going ahead
 *
 * The pages did not change. This file rebuilds, from the rows, the two keys
 * they already read - and turns their saves into changes to the rows. As long
 * as that holds, each area after this one is a file like this, not a rewrite.
 * ========================================================================== */
(function (root) {
  'use strict';

  var TABLE = 'remc_variations';
  var KEY_V = 'remc_variations';
  var KEY_R = 'remc_variation_requests';

  var d = null;                 // the data layer
  var opts = { actor: function () { return ''; }, log: function () {} };
  var _mapCache = null, _reqCache = null;

  // A record raised on site stays off the job until it is approved. The pages
  // recognise that by a "state" field holding 'pending'; when it goes away,
  // the variation is on the job. We keep that wording so nothing that draws
  // the screens has to change.
  function legacyState(rowState) {
    if (rowState === 'approved' || rowState == null || rowState === '') return null;
    return 'pending';
  }

  function isReqOnly(row) { return !!(row.data && row.data._reqOnly); }

  // ------------------------------------------------------------ projection --
  function buildMap() {
    var out = {};
    d.all(TABLE).forEach(function (row) {
      if (isReqOnly(row)) return;                 // a request with no job record
      if (row.project_id == null) return;
      var rec = {};
      Object.keys(row.data || {}).forEach(function (k) {
        if (k === '_req' || k === '_reqOnly') return;
        rec[k] = row.data[k];
      });
      rec.id = row.id;
      var st = legacyState(row.state);
      if (st) rec.state = st; else delete rec.state;
      if (row._pending) rec._pending = true;
      if (row._failed) rec._failed = row._failed;
      (out[String(row.project_id)] = out[String(row.project_id)] || []).push(rec);
    });
    // The order they were in: oldest first, which is what the phone expects.
    Object.keys(out).forEach(function (pid) {
      out[pid].sort(function (a, b) {
        var x = a.createdAt || '', y = b.createdAt || '';
        return x < y ? -1 : (x > y ? 1 : 0);
      });
    });
    return out;
  }

  function buildRequests() {
    var out = [];
    d.all(TABLE).forEach(function (row) {
      var r = row.data && row.data._req;
      if (!r) return;
      var req = {};
      Object.keys(r).forEach(function (k) { req[k] = r[k]; });
      req.id = r.id || row.id;
      req.state = row.state || 'approval';
      req.pid = row.project_id;
      if (!isReqOnly(row)) req.recId = row.id;
      out.push(req);
    });
    out.sort(function (a, b) { var x = a.at || '', y = b.at || ''; return x < y ? 1 : (x > y ? -1 : 0); });
    return out;
  }

  function project() {
    _mapCache = buildMap();
    _reqCache = buildRequests();
    d.writeLegacy(KEY_V, JSON.stringify(_mapCache));
    d.writeLegacy(KEY_R, JSON.stringify(_reqCache));
  }

  // --------------------------------------------------------------- writing --
  // Not as text: see the comment in remc-data.js. Compared as text, a record
  // that came back from the server always looks different from the one we
  // hold, and the page saves what has not changed - every two seconds.
  function sameData(a, b) { return d.same(a, b); }

  /** Save a variation. rec is the record exactly as the pages write it. */
  function saveRecord(pid, rec, o) {
    o = o || {};
    var id = String(rec.id || d.newId('vr'));
    var existing = d.byId(TABLE, id);
    var data = {};
    Object.keys(rec).forEach(function (k) {
      if (k === 'id' || k === 'state' || k === '_pending' || k === '_failed') return;
      data[k] = rec[k];
    });
    // anything that belonged to the request stays where it was
    if (existing && existing.data && existing.data._req) data._req = existing.data._req;
    if (existing && existing.data && existing.data._reqOnly) data._reqOnly = existing.data._reqOnly;
    if (o.req) data._req = o.req;

    var state = o.state;
    if (!state) {
      if (rec.state === 'pending') {
        // already waiting: keep the exact place it had in the approval run
        state = (existing && existing.state && existing.state !== 'approved')
          ? existing.state : 'approval';
      } else {
        state = 'approved';
      }
    }

    if (existing && sameData(existing.data, data) && existing.state === state &&
        String(existing.project_id) === String(pid)) {
      return Promise.resolve(existing);        // nothing changed, nothing goes up
    }

    return d.save(TABLE, {
      id: id, project_id: pid == null ? null : String(pid),
      state: state, data: data
    }, { actor: opts.actor(), idPrefix: 'vr' });
  }

  function removeRecord(id) { return d.remove(TABLE, String(id), { actor: opts.actor() }); }

  /** Takes a job's whole list of variations, exactly as the pages already
   *  wrote it, and turns it into the smallest set of changes. Only what
   *  actually changed goes up. */
  function writeMap(pid, list) {
    list = Array.isArray(list) ? list : [];
    var keep = {};
    var jobs = [];
    list.forEach(function (rec) {
      if (!rec) return;
      if (!rec.id) rec.id = d.newId('vr');
      keep[String(rec.id)] = true;
      jobs.push(saveRecord(pid, rec));
    });
    d.byProject(TABLE, pid).forEach(function (row) {
      if (isReqOnly(row)) return;
      if (!keep[row.id]) jobs.push(removeRecord(row.id));
    });
    return Promise.all(jobs);
  }

  /** The same for the request list on the Variations page. */
  function writeRequests(list) {
    list = Array.isArray(list) ? list : [];
    var seen = {};
    var jobs = [];

    list.forEach(function (req) {
      if (!req || !req.id) return;
      var rowId = String(req.recId || req.id);
      var row = d.byId(TABLE, rowId);
      if (!row && req.recId) row = d.byId(TABLE, String(req.recId));
      seen[rowId] = true;

      var reqFields = {};
      Object.keys(req).forEach(function (k) {
        if (k === 'state' || k === 'recId' || k === 'pid') return;
        reqFields[k] = req[k];
      });

      var data = {};
      if (row && row.data) {
        Object.keys(row.data).forEach(function (k) { if (k !== '_req') data[k] = row.data[k]; });
      } else {
        // A request raised in the office with no record on the job: it stays
        // a request only. If it is approved, that is when the variation on the
        // job comes into being.
        data._reqOnly = true;
        data.desc = req.desc || '';
        data.amount = req.amount || 0;
        data.createdAt = req.at || new Date().toISOString();
      }
      data._req = reqFields;

      var state = req.state || 'approval';
      if (row && sameData(row.data, data) && row.state === state &&
          String(row.project_id) === String(req.pid == null ? null : req.pid)) return;

      jobs.push(d.save(TABLE, {
        id: rowId,
        project_id: req.pid == null ? (row ? row.project_id : null) : String(req.pid),
        state: state, data: data
      }, { actor: opts.actor() }));
    });

    // A request taken off the list. If it only ever existed as a request, it
    // goes. If it had already landed on the job, the variation stays - it just
    // stops having a request, which is exactly what the page warns about when
    // an approved request is deleted.
    d.all(TABLE).forEach(function (row) {
      if (!row.data || !row.data._req) return;
      if (seen[row.id]) return;
      if (isReqOnly(row)) { jobs.push(removeRecord(row.id)); return; }
      var data = {};
      Object.keys(row.data).forEach(function (k) { if (k !== '_req') data[k] = row.data[k]; });
      jobs.push(d.save(TABLE, { id: row.id, project_id: row.project_id,
                                state: row.state, data: data }, { actor: opts.actor() }));
    });

    return Promise.all(jobs);
  }

  // ---------------------------------------------------- what was here before -
  // The moment the projection runs for the first time, it rewrites the two old
  // keys from the rows - which start out empty. Whatever this computer had
  // saved would vanish without anyone noticing. So a copy is kept, once, before
  // the projection touches anything.
  var BK = 'remcdl:v1:legacy:variations';

  function keepLegacyCopy() {
    var s = d._internal.cfg.storage ||
            (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return;
    var ja = null;
    try { ja = s.getItem(BK); } catch (e) {}
    if (ja) return;                                   // already kept earlier
    var v = null, r = null;
    try { v = s.getItem(KEY_V); r = s.getItem(KEY_R); } catch (e) {}
    if (!v && !r) return;
    d.writeLegacy(BK, JSON.stringify({ at: new Date().toISOString(), v: v || '{}', r: r || '[]' }));
    opts.log('copy of what was here before kept under ' + BK);
  }

  /** Bring into the tables whatever this computer held before. It only runs
   *  when asked, and running it twice does no harm: every record keeps its own
   *  id, so a second import does not create copies. */
  function importLegacy() {
    var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var raw = null;
    try { raw = s && s.getItem(BK); } catch (e) {}
    if (!raw) return Promise.resolve({ variations: 0, requests: 0, note: 'nothing was kept' });

    var bk; try { bk = JSON.parse(raw); } catch (e) { return Promise.reject(new Error('the kept copy cannot be read')); }
    var mapa = {}, pedidos = [];
    try { mapa = JSON.parse(bk.v || '{}') || {}; } catch (e) {}
    try { pedidos = JSON.parse(bk.r || '[]') || []; } catch (e) {}

    var porRec = {};
    pedidos.forEach(function (p) { if (p && p.recId) porRec[String(p.recId)] = p; });

    var jobs = [], nV = 0, nP = 0;
    Object.keys(mapa).forEach(function (pid) {
      (mapa[pid] || []).forEach(function (rec) {
        if (!rec || !rec.id) return;
        if (d.byId(TABLE, rec.id)) return;            // already there
        var p = porRec[String(rec.id)];
        var estado = p ? (p.state || 'approval') : (rec.state === 'pending' ? 'approval' : 'approved');
        var req = null;
        if (p) {
          req = {}; Object.keys(p).forEach(function (k) {
            if (k !== 'state' && k !== 'recId' && k !== 'pid') req[k] = p[k];
          });
          nP++;
        }
        nV++;
        jobs.push(saveRecord(pid, rec, { state: estado, req: req }));
      });
    });

    // requests that never came to have a record on the job
    pedidos.forEach(function (p) {
      if (!p || !p.id) return;
      if (p.recId) return;
      if (d.byId(TABLE, p.id)) return;
      nP++;
      jobs.push(writeRequests([p]));
    });

    return Promise.all(jobs).then(function () {
      return { variations: nV, requests: nP };
    });
  }

  // ----------------------------------------------------------------- public -
  var api = {
    TABLE: TABLE,
    init: function (o) {
      o = o || {};
      d = o.data || root.remcData;
      if (!d) throw new Error('remc-variations needs the data layer');
      if (o.actor) opts.actor = (typeof o.actor === 'function') ? o.actor : function () { return o.actor; };
      if (o.log) opts.log = o.log;
      d.claim(KEY_V, KEY_R);
      keepLegacyCopy();
      return api;
    },
    project: function (table) { if (table === TABLE) project(); },
    map: function () { return _mapCache || (_mapCache = buildMap()); },
    requests: function () { return _reqCache || (_reqCache = buildRequests()); },
    listFor: function (pid) { return api.map()[String(pid)] || []; },
    saveRecord: saveRecord,
    removeRecord: removeRecord,
    writeMap: writeMap,
    writeRequests: writeRequests,
    watch: function (fn) { return d.watch(TABLE, function () { fn(api.map(), api.requests()); }); },

    /** How much this computer had saved before the change. */
    legacyCopy: function () {
      var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      var raw = null; try { raw = s && s.getItem(BK); } catch (e) {}
      if (!raw) return null;
      try {
        var bk = JSON.parse(raw);
        var mapa = JSON.parse(bk.v || '{}') || {};
        var n = 0; Object.keys(mapa).forEach(function (k) { n += (mapa[k] || []).length; });
        return { keptAt: bk.at, variations: n, requests: (JSON.parse(bk.r || '[]') || []).length };
      } catch (e) { return null; }
    },
    importLegacy: importLegacy,
    _rebuild: function () { _mapCache = null; _reqCache = null; }
  };

  root.remcVariations = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
