/* ==========================================================================
 * remc-data.js  -  the data layer, identical in both apps
 * --------------------------------------------------------------------------
 * Everything read from or written to the database goes through here. The
 * pages do not know this exists: they still read from where they always did,
 * straight away, without waiting for the network.
 *
 * What it fixes
 *   - one row per record, instead of the single remc_state row
 *   - two people saving at once: the second no longer writes over the first
 *   - a phone with no signal: the save queues and goes up on its own
 *   - a retried save does not create a second record
 *   - the office sees a variation the moment it is raised on site
 *
 * How it is used
 *   remcData.configure({ url, anonKey, actor, tables:['remc_variations'] })
 *   remcData.all('remc_variations')          -> [] now, no waiting
 *   remcData.save('remc_variations', record) -> promise, resolves when saved
 *   remcData.watch('remc_variations', redraw)
 *
 * One rule: nothing in here writes the old localStorage keys by itself. That
 * is done by the "project" function each app supplies, and it is always
 * derived from the rows - never the other way round.
 * ========================================================================== */
(function (root) {
  'use strict';

  // The old sync replaces localStorage.setItem so it can catch saves and send
  // them to the single row. We keep the original here, from the prototype, so
  // the keys this layer now owns do not end up there as well.
  var RAW_SET = null, RAW_GET = null, RAW_DEL = null;
  try {
    RAW_SET = Storage.prototype.setItem;
    RAW_GET = Storage.prototype.getItem;
    RAW_DEL = Storage.prototype.removeItem;
  } catch (e) { /* not in a browser */ }

  var PREFIX = 'remcdl:v1:';

  var TABLES = {
    remc_projects:   { project: false, state: false, kind: false },
    remc_variations: { project: true,  state: true,  kind: false },
    remc_claims:     { project: true,  state: false, kind: false },
    remc_materials:  { project: true,  state: false, kind: false },
    remc_bookings:   { project: true,  state: false, kind: true  },
    remc_suppliers:  { project: false, state: false, kind: false }
  };

  // ----------------------------------------------------------------- state --
  var cfg = {
    url: '', anonKey: '', actor: '', tables: [],
    pollMs: 20000,          // safety net, in case realtime drops
    backoffMs: 1000,        // wait before retrying; doubles on each failure
    maxBackoffMs: 30000,
    pageSize: 1000,
    realtime: true,
    storage: null,          // defaults to localStorage
    fetch: null,            // defaults to the window's fetch
    now: function () { return Date.now(); },
    project: null,          // rebuilds the old keys from the rows
    merge: null,            // decides what to keep when there is a conflict
    log: function () {}
  };

  var cache    = {};        // table -> { id -> row }
  var cursors  = {};        // table -> latest timestamp seen
  var outbox   = [];        // saves not yet confirmed, in the order they left
  var watchers = {};        // table -> [function]
  var statusFns = [];
  var channels = {};
  var started   = false;
  var draining  = false;
  var drainTimer = null, pollTimer = null, backoff = 0;
  var conflicts = [];
  var lastSync  = null;
  var firstPull = null;
  var pullingNow = {};

  // --------------------------------------------------------------- helpers --
  function store() { return cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null); }

  // Captured in configure, before the old sync installs its hooks. Writing
  // through these keeps our saves from being picked up by it and sent to the
  // single row as well.
  var ownSet = null, ownGet = null, ownDel = null;
  function snapshotStore() {
    var s = store(); if (!s) return;
    var isStorage = false;
    try { isStorage = (typeof Storage !== 'undefined') && (s instanceof Storage); } catch (e) {}
    ownSet = (isStorage && RAW_SET) ? RAW_SET : s.setItem;
    ownGet = (isStorage && RAW_GET) ? RAW_GET : s.getItem;
    ownDel = (isStorage && RAW_DEL) ? RAW_DEL : s.removeItem;
  }
  function sget(k) {
    var s = store(); if (!s) return null;
    try { return (ownGet || s.getItem).call(s, k); } catch (e) { return null; }
  }
  function sset(k, v) {
    var s = store(); if (!s) return false;
    try { (ownSet || s.setItem).call(s, k, String(v)); return true; }
    catch (e) { cfg.log('browser storage is full:', k); return false; }
  }
  function sdel(k) {
    var s = store(); if (!s) return;
    try { (ownDel || s.removeItem).call(s, k); } catch (e) {}
  }
  function jparse(txt, fallback) {
    if (txt == null || txt === '') return fallback;
    try { var v = JSON.parse(txt); return (v === null || v === undefined) ? fallback : v; }
    catch (e) { return fallback; }
  }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  // Comparing two records as text does not work: Postgres does not keep keys
  // in the order we wrote them - jsonb reorders them. Compared as text, a
  // record that came back from the server always looks different from the one
  // we hold, so the app saves what has not changed, over and over.
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    var aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
      if (!same(a[ka[j]], b[ka[j]])) return false;
    }
    return true;
  }

  // An id a person can read on a history screen, and that stays unique when
  // two phones create records in the same second with no signal.
  function newId(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function online() {
    try { return typeof navigator === 'undefined' || navigator.onLine !== false; }
    catch (e) { return true; }
  }

  // --------------------------------------------------------------- on disk --
  function rowsKey(t)   { return PREFIX + 'rows:' + t; }
  function cursorKey(t) { return PREFIX + 'cursor:' + t; }
  var OUTBOX_KEY = PREFIX + 'outbox';

  function loadLocal() {
    cfg.tables.forEach(function (t) {
      cache[t]   = jparse(sget(rowsKey(t)), {}) || {};
      cursors[t] = sget(cursorKey(t)) || '';
    });
    outbox = jparse(sget(OUTBOX_KEY), []) || [];
    if (!Array.isArray(outbox)) outbox = [];
  }
  function saveRows(t)  { sset(rowsKey(t), JSON.stringify(cache[t] || {})); }
  function saveCursor(t){ if (cursors[t]) sset(cursorKey(t), cursors[t]); }
  function saveOutbox() { sset(OUTBOX_KEY, JSON.stringify(outbox)); }

  // -------------------------------------------------------------- notify ----
  var dirtyTables = {};
  var notifyTimer = null;

  function touched(t) {
    dirtyTables[t] = true;
    if (notifyTimer) return;
    notifyTimer = setTimeout(function () {
      notifyTimer = null;
      var list = Object.keys(dirtyTables); dirtyTables = {};
      list.forEach(function (t) {
        saveRows(t);
        try { if (cfg.project) cfg.project(t, api); } catch (e) { cfg.log('projection failed', t, e); }
        (watchers[t] || []).forEach(function (fn) {
          try { fn(api.all(t), t); } catch (e) { cfg.log('watcher failed', t, e); }
        });
      });
      emitStatus();
    }, 0);
  }

  function emitStatus() {
    var s = api.status();
    statusFns.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  // ------------------------------------------------------------- network ----
  // The browser's fetch has to be called bound to the window. Called loose it
  // throws "Illegal invocation" - and since that looks like any other network
  // error, the save would retry forever without ever going up.
  function doFetch(path, opts) {
    var f = cfg.fetch;
    if (!f && typeof root.remcSafeFetch === 'function') f = root.remcSafeFetch;
    if (!f && typeof root.fetch === 'function') f = root.fetch.bind(root);
    if (!f) return Promise.reject(new Error('no fetch available'));
    opts = opts || {};
    var headers = {
      'apikey': cfg.anonKey,
      'Authorization': 'Bearer ' + cfg.anonKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
    return f(cfg.url.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var body = jparse(txt, txt);
        if (!res.ok) {
          var err = new Error((body && body.message) || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = (body && body.code) || '';
          err.detail = body;
          throw err;
        }
        return body;
      });
    });
  }

  function isConflict(err) {
    if (!err) return false;
    if (err.code === '40001') return true;
    return /REMC_CONFLICT/.test(String(err.message || ''));
  }
  function isMissing(err) {
    if (!err) return false;
    if (err.code === 'P0002') return true;
    return /REMC_MISSING/.test(String(err.message || ''));
  }
  // A server-side error not worth retrying as-is: sending the same thing
  // again always gives the same answer.
  function isPermanent(err) {
    if (!err) return false;
    if (isConflict(err) || isMissing(err)) return false;
    if (err.status === 400 || err.status === 401 || err.status === 403 ||
        err.status === 404 || err.status === 422) return true;
    return /REMC_BADTABLE|REMC_BADID|REMC_NOVERSION/.test(String(err.message || ''));
  }

  // ------------------------------------------------------ read what is new --
  function pull(t) {
    if (!cfg.url || !cfg.anonKey) return Promise.resolve(0);
    if (pullingNow[t]) return pullingNow[t];

    var since = cursors[t] || '1970-01-01T00:00:00Z';
    // gte, not gt: two rows can share the same instant to the millisecond,
    // and with gt the second would never arrive. Re-reading the boundary costs
    // nothing - anything we already hold is recognised by version and ignored.
    var q = '/rest/v1/' + t +
      '?select=*&updated_at=gte.' + encodeURIComponent(since) +
      '&order=updated_at.asc&limit=' + cfg.pageSize;

    var p = doFetch(q).then(function (rows) {
      if (!Array.isArray(rows)) return 0;
      var n = 0;
      rows.forEach(function (r) { if (applyRemote(t, r)) n++; });
      if (rows.length) {
        var last = rows[rows.length - 1].updated_at;
        if (last) { cursors[t] = last; saveCursor(t); }
      }
      lastSync = new Date().toISOString();
      pullingNow[t] = null;
      if (n) touched(t); else emitStatus();
      // A full page means there may be more behind it.
      if (rows.length >= cfg.pageSize) return pull(t).then(function (m) { return n + m; });
      return n;
    }).catch(function (err) {
      pullingNow[t] = null;
      cfg.log('read failed', t, err && err.message);
      emitStatus();
      throw err;
    });

    pullingNow[t] = p;
    return p;
  }

  function hasPending(table, id) {
    for (var i = 0; i < outbox.length; i++) {
      if (outbox[i].table === table && String(outbox[i].id) === String(id)) return true;
    }
    return false;
  }

  // Takes a row from the server. Returns true if anything changed.
  function applyRemote(t, r) {
    if (!r || !r.id) return false;
    cache[t] = cache[t] || {};
    var have = cache[t][r.id];

    // If we still have unsent saves for this record, our copy is the one the
    // person is looking at. We do not replace it with a server version that
    // does not yet include what they just wrote: once the queue drains, the
    // server's reply brings back the right row.
    if (have && have._pending && hasPending(t, r.id)) return false;

    if (have && !have._pending
        && Number(have.version) === Number(r.version)
        && have.updated_at === r.updated_at) return false;      // already have it
    cache[t][r.id] = normalise(r);
    return true;
  }

  function normalise(r) {
    return {
      id: String(r.id),
      project_id: r.project_id == null ? null : String(r.project_id),
      state: r.state == null ? null : String(r.state),
      kind: r.kind == null ? null : String(r.kind),
      data: isObj(r.data) ? r.data : (jparse(r.data, {}) || {}),
      version: Number(r.version) || 1,
      deleted_at: r.deleted_at || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      updated_by: r.updated_by || null,
      created_by: r.created_by || null
    };
  }

  // --------------------------------------------------------------- writing --
  function enqueue(op) {
    outbox.push(op);
    saveOutbox();
    scheduleDrain(0);
    emitStatus();
  }

  function scheduleDrain(ms) {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(function () { drainTimer = null; drain(); }, ms || 0);
  }

  function drain() {
    if (draining || !outbox.length) return Promise.resolve();
    if (!cfg.url || !cfg.anonKey) return Promise.resolve();
    if (!online()) { scheduleDrain(2000); return Promise.resolve(); }

    draining = true;
    emitStatus();
    var op = outbox[0];

    return sendOne(op).then(function () {
      // sendOne only resolves once the operation is dealt with, one way or
      // another. It leaves the queue and the next one goes.
      outbox.shift(); saveOutbox();
      backoff = cfg.backoffMs;
      draining = false;
      emitStatus();
      if (outbox.length) scheduleDrain(0);
    }).catch(function (err) {
      draining = false;
      op.tries = (op.tries || 0) + 1;
      op.lastError = String((err && err.message) || err);

      if (isPermanent(err)) {
        // Retrying this forever only blocks everything queued behind it.
        cfg.log('save refused and dropped from the queue:', op.table, op.id, op.lastError);
        park(op, 'refused');
        outbox.shift(); saveOutbox();
        emitStatus();
        if (outbox.length) scheduleDrain(0);
        return;
      }
      saveOutbox();
      emitStatus();
      backoff = Math.min(Math.max(backoff, cfg.backoffMs) * 2, cfg.maxBackoffMs);
      scheduleDrain(backoff);
    });
  }

  function park(op, why) {
    conflicts.push({
      table: op.table, id: op.id, why: why,
      error: op.lastError || '', at: new Date().toISOString(),
      data: clone(op.data)
    });
    // The local copy is marked, so the page can show that this row did not
    // reach the server instead of pretending all is well.
    var row = cache[op.table] && cache[op.table][op.id];
    if (row) { row._pending = false; row._failed = why; touched(op.table); }
  }

  function rpcBody(op) {
    return {
      p_table:    op.table,
      p_id:       op.id,
      p_data:     op.data === undefined ? null : op.data,
      p_version:  op.expectVersion === undefined ? null : op.expectVersion,
      p_project:  op.project_id === undefined ? null : op.project_id,
      p_state:    op.state === undefined ? null : op.state,
      p_kind:     op.kind === undefined ? null : op.kind,
      p_actor:    op.actor || cfg.actor || null,
      p_write_id: op.writeId,
      p_delete:   op.del === undefined ? null : op.del
    };
  }

  function sendOne(op) {
    return doFetch('/rest/v1/rpc/remc_write', { method: 'POST', body: rpcBody(op) })
      .then(function (res) {
        var row = res && res.row;
        if (row) {
          cache[op.table] = cache[op.table] || {};
          cache[op.table][row.id] = normalise(row);
          if (row.updated_at && (!cursors[op.table] || row.updated_at > cursors[op.table])) {
            cursors[op.table] = row.updated_at; saveCursor(op.table);
          }
          touched(op.table);
        }
        if (op.resolve) op.resolve(row ? normalise(row) : null);
        return res;
      })
      .catch(function (err) {
        if (isMissing(err)) {
          // We tried to change a record that is no longer there. If this is a
          // delete, it is already gone and there is nothing to do. If it is an
          // edit, the record was created on this device and never went up:
          // send it as a create, so it is not lost.
          if (op.del === true) { if (op.resolve) op.resolve(null); return null; }
          op.expectVersion = null;
          op.writeId = newId('w');
          throw err;
        }
        if (isConflict(err)) return resolveConflict(op, err);
        if (isPermanent(err) && op.reject) op.reject(err);
        throw err;
      });
  }

  // Somebody saved first. Fetch what is there, merge, and try again from
  // their version. The default merge keeps their fields where we did not touch
  // anything, and puts ours on top where we did - which is the normal case:
  // two people working on different parts of the same record.
  function resolveConflict(op, err) {
    op.conflicts = (op.conflicts || 0) + 1;
    if (op.conflicts > 3) {
      park(op, 'conflict');
      if (op.reject) op.reject(err);
      return null;                        // leaves the queue; no endless retry
    }
    return doFetch('/rest/v1/' + op.table + '?select=*&id=eq.' + encodeURIComponent(op.id))
      .then(function (rows) {
        var theirs = Array.isArray(rows) && rows[0] ? normalise(rows[0]) : null;
        if (!theirs) { op.expectVersion = null; op.writeId = newId('w'); throw err; }

        var merged;
        if (typeof cfg.merge === 'function') {
          merged = cfg.merge(op.table, op.data, theirs.data, op);
        } else {
          merged = {};
          Object.keys(theirs.data || {}).forEach(function (k) { merged[k] = theirs.data[k]; });
          Object.keys(op.data || {}).forEach(function (k) { merged[k] = op.data[k]; });
        }
        op.data = merged;
        op.expectVersion = theirs.version;
        op.writeId = newId('w');          // a different write, different content
        // keep what was there, so a conflicts screen can show it
        op.theirs = theirs.data;
        throw err;                        // back in the queue, retried next
      });
  }

  // ------------------------------------------------------------ realtime ----
  function subscribe(t) {
    if (!cfg.realtime) return;
    var sb = root.REMC_SB || null;
    if (!sb && root.supabase && root.supabase.createClient && cfg.url && cfg.anonKey) {
      try {
        sb = root.supabase.createClient(cfg.url, cfg.anonKey, {
          global: { fetch: (typeof root.remcSafeFetch === 'function' ? root.remcSafeFetch : undefined) }
        });
        root.REMC_SB_DATA = sb;
      } catch (e) { sb = null; }
    }
    if (!sb || typeof sb.channel !== 'function') { cfg.log('no realtime; polling only'); return; }

    try {
      channels[t] = sb.channel('remcdl_' + t)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: t },
            function (payload) {
              var r = payload && (payload.new || payload.old);
              if (!r || !r.id) return;
              if (applyRemote(t, r)) touched(t);
              if (r.updated_at && (!cursors[t] || r.updated_at > cursors[t])) {
                cursors[t] = r.updated_at; saveCursor(t);
              }
            })
        .subscribe();
    } catch (e) { cfg.log('realtime failed', t, e); }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!online()) return;
      try { if (typeof document !== 'undefined' && document.hidden) return; } catch (e) {}
      cfg.tables.forEach(function (t) { pull(t).catch(function () {}); });
    }, cfg.pollMs);
  }

  // -------------------------------------------------------------- public ----
  var api = {

    configure: function (opts) {
      opts = opts || {};
      Object.keys(opts).forEach(function (k) { if (opts[k] !== undefined) cfg[k] = opts[k]; });
      cfg.tables = (cfg.tables || []).filter(function (t) {
        if (!TABLES[t]) { cfg.log('unknown table, ignored:', t); return false; }
        return true;
      });
      snapshotStore();
      backoff = cfg.backoffMs;
      loadLocal();
      return api;
    },

    /** Start up: read what is there, switch on realtime, and drain whatever
     *  was left queued from a previous session. Returns a promise that
     *  resolves on the first full read - but the pages need not wait for it. */
    start: function () {
      if (started) return firstPull;
      started = true;

      cfg.tables.forEach(function (t) {
        cache[t] = cache[t] || {};
        try { if (cfg.project) cfg.project(t, api); } catch (e) {}
        subscribe(t);
      });
      startPolling();

      try {
        root.addEventListener('online', function () { backoff = cfg.backoffMs; scheduleDrain(0);
          cfg.tables.forEach(function (t) { pull(t).catch(function () {}); }); });
        root.addEventListener('offline', function () { emitStatus(); });
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
              scheduleDrain(0);
              cfg.tables.forEach(function (t) { pull(t).catch(function () {}); });
            }
          });
        }
      } catch (e) {}

      scheduleDrain(0);
      firstPull = Promise.all(cfg.tables.map(function (t) {
        return pull(t).catch(function () { return 0; });
      })).then(function () { emitStatus(); return true; });
      return firstPull;
    },

    ready: function () { return firstPull || Promise.resolve(false); },

    /** Every row of a table, right now, with no wait for the network.
     *  Deleted rows are left out unless asked for. */
    all: function (t, opts) {
      opts = opts || {};
      var m = cache[t] || {};
      var out = [];
      Object.keys(m).forEach(function (id) {
        var r = m[id];
        if (!opts.includeDeleted && r.deleted_at) return;
        if (opts.project !== undefined && String(r.project_id) !== String(opts.project)) return;
        if (opts.state !== undefined && String(r.state) !== String(opts.state)) return;
        out.push(r);
      });
      out.sort(function (a, b) {
        var x = a.created_at || '', y = b.created_at || '';
        if (x === y) return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        return x < y ? -1 : 1;
      });
      return out;
    },

    byProject: function (t, pid) { return api.all(t, { project: pid }); },

    byId: function (t, id) {
      var r = (cache[t] || {})[String(id)];
      return (r && !r.deleted_at) ? r : null;
    },

    /** Save a record. The screen sees the change straight away; the promise
     *  resolves when the server confirms, and that is when to say "saved".
     *  rec = { id?, project_id?, state?, kind?, data } */
    save: function (t, rec, opts) {
      opts = opts || {};
      if (!TABLES[t]) return Promise.reject(new Error('unknown table: ' + t));
      rec = rec || {};

      var id = String(rec.id || newId(opts.idPrefix || 'r'));
      var existing = (cache[t] || {})[id];
      var data = isObj(rec.data) ? clone(rec.data) : {};

      // If nothing changed, nothing is saved. This holds for every area, not
      // just variations: a page that redraws and writes the same list back -
      // which is what they all do - stops waking the network for nothing.
      // A row that exists only on this device still has to go up, even if the
      // content did not change - otherwise it would stay here forever.
      if (existing && !existing._pending && !existing._failed && !existing._local
          && same(existing.data, data)
          && (rec.state === undefined || String(rec.state) === String(existing.state))
          && (rec.project_id === undefined
              || String(rec.project_id) === String(existing.project_id))
          && !existing.deleted_at) {
        return Promise.resolve(existing);
      }

      var op = {
        table: t, id: id, data: data,
        project_id: rec.project_id === undefined ? (existing ? existing.project_id : null) : rec.project_id,
        state: rec.state === undefined ? undefined : rec.state,
        kind: rec.kind === undefined ? undefined : rec.kind,
        actor: opts.actor || cfg.actor || null,
        writeId: newId('w'),
        expectVersion: existing ? Number(existing.version) : null,
        queuedAt: new Date().toISOString(),
        tries: 0
      };

      // The local copy changes now, so the screen does not wait for the network.
      cache[t] = cache[t] || {};
      cache[t][id] = {
        id: id,
        project_id: op.project_id == null ? null : String(op.project_id),
        state: op.state !== undefined ? op.state : (existing ? existing.state : (TABLES[t].state ? 'pending' : null)),
        kind: op.kind !== undefined ? op.kind : (existing ? existing.kind : null),
        data: data,
        version: existing ? Number(existing.version) + 1 : 1,
        deleted_at: null,
        created_at: existing ? existing.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: op.actor,
        created_by: existing ? existing.created_by : op.actor,
        _pending: true,
        _local: true            // not yet from the server; cleared when it is
      };
      touched(t);

      return new Promise(function (resolve, reject) {
        op.resolve = function (row) {
          var r = cache[t] && cache[t][id];
          if (r) { r._pending = false; delete r._failed; delete r._local; touched(t); }
          resolve(row || r);
        };
        op.reject = reject;
        enqueue(op);
      });
    },

    /** Mark as deleted. The row stays, with who deleted it and when. */
    remove: function (t, id, opts) {
      opts = opts || {};
      if (!TABLES[t]) return Promise.reject(new Error('unknown table: ' + t));
      id = String(id);
      var existing = (cache[t] || {})[id];
      if (!existing) return Promise.resolve(null);

      var op = {
        table: t, id: id, data: undefined, del: true,
        actor: opts.actor || cfg.actor || null,
        writeId: newId('w'),
        expectVersion: Number(existing.version),
        queuedAt: new Date().toISOString(), tries: 0
      };

      existing.deleted_at = new Date().toISOString();
      existing.version = Number(existing.version) + 1;
      existing._pending = true;
      touched(t);

      return new Promise(function (resolve, reject) {
        op.resolve = function (row) {
          var r = cache[t] && cache[t][id];
          if (r) { r._pending = false; touched(t); }
          resolve(row);
        };
        op.reject = reject;
        enqueue(op);
      });
    },

    /** Bring a deleted record back. */
    restore: function (t, id, opts) {
      opts = opts || {};
      var existing = (cache[t] || {})[String(id)];
      if (!existing) return Promise.resolve(null);
      var op = {
        table: t, id: String(id), del: false,
        actor: opts.actor || cfg.actor || null,
        writeId: newId('w'), expectVersion: Number(existing.version),
        queuedAt: new Date().toISOString(), tries: 0
      };
      existing.deleted_at = null;
      existing.version = Number(existing.version) + 1;
      existing._pending = true;
      touched(String(t));
      return new Promise(function (resolve, reject) {
        op.resolve = resolve; op.reject = reject; enqueue(op);
      });
    },

    /** Fires whenever this table changes - wherever the change came from. */
    watch: function (t, fn) {
      watchers[t] = watchers[t] || [];
      watchers[t].push(fn);
      return function () {
        watchers[t] = (watchers[t] || []).filter(function (f) { return f !== fn; });
      };
    },

    onStatus: function (fn) {
      statusFns.push(fn);
      return function () { statusFns = statusFns.filter(function (f) { return f !== fn; }); };
    },

    status: function () {
      return {
        online: online(),
        configured: !!(cfg.url && cfg.anonKey),
        pending: outbox.length,
        syncing: draining,
        lastSync: lastSync,
        conflicts: conflicts.slice(),
        tables: cfg.tables.slice()
      };
    },

    /** Send everything queued, now, without waiting. */
    flush: function () { backoff = cfg.backoffMs; scheduleDrain(0); return drain(); },

    pull: function (t) {
      if (t) return pull(t);
      return Promise.all(cfg.tables.map(function (x) { return pull(x).catch(function () { return 0; }); }));
    },

    /** A record's history: who changed what, and when. */
    history: function (t, id) {
      return doFetch('/rest/v1/remc_history?select=*&table_name=eq.' +
        encodeURIComponent(t) + '&record_id=eq.' + encodeURIComponent(id) +
        '&order=seq.desc&limit=200');
    },

    clearConflicts: function () { conflicts = []; emitStatus(); },

    /** The old localStorage keys this layer has taken over. The old sync has
     *  to leave them alone, or the two write over each other. */
    owned: {},
    owns: function (key) { return !!api.owned[key]; },
    claim: function () {
      for (var i = 0; i < arguments.length; i++) api.owned[arguments[i]] = true;
      return api;
    },

    /** Write an old key without waking the old sync.
     *  Only the projection function should use this. */
    writeLegacy: function (key, text) { return sset(key, text); },

    newId: newId,

    /** Compare two records without depending on key order. */
    same: same,

    /** Clear everything this layer keeps on this device. The database is not
     *  touched - next time it is read again from the start. */
    resetLocal: function () {
      cfg.tables.forEach(function (t) { sdel(rowsKey(t)); sdel(cursorKey(t)); cache[t] = {}; cursors[t] = ''; });
      sdel(OUTBOX_KEY); outbox = []; conflicts = [];
      emitStatus();
    },

    /** Run a full check-up and report back in plain words. For when something
     *  is not showing on the other side and nobody knows why. */
    diagnose: function () {
      var r = { configured: !!(cfg.url && cfg.anonKey), tables: cfg.tables.slice(),
                online: online(), queued: outbox.length, conflicts: conflicts.length,
                cached: {}, problems: [] };
      cfg.tables.forEach(function (t) { r.cached[t] = api.all(t).length; });
      if (outbox.length) {
        r.firstInQueue = { table: outbox[0].table, id: outbox[0].id,
                           tries: outbox[0].tries || 0,
                           lastError: outbox[0].lastError || '(none yet)' };
      }
      if (conflicts.length) r.conflictDetail = conflicts.slice(0, 5);

      return doFetch('/rest/v1/' + (cfg.tables[0] || 'remc_variations') + '?select=id&limit=1')
        .then(function () { r.reading = 'OK'; })
        .catch(function (e) {
          r.reading = 'FAILED: ' + ((e && e.message) || e);
          r.problems.push('cannot read the database');
        })
        .then(function () {
          var id = 'diag_' + Date.now().toString(36);
          return doFetch('/rest/v1/rpc/remc_write', { method: 'POST', body: {
            p_table: cfg.tables[0] || 'remc_variations', p_id: id,
            p_data: { diagnostic: true }, p_version: null, p_project: null,
            p_state: null, p_kind: null, p_actor: 'diagnostic',
            p_write_id: id + '_w', p_delete: true
          }}).then(function () { r.writing = 'OK'; })
            .catch(function (e) {
              var m = (e && e.message) || String(e);
              r.writing = 'FAILED: ' + m;
              if (/remc_write/.test(m) && /function|schema|404/i.test(m)) {
                r.problems.push('the remc_write function is missing - run 02-fixes.sql');
              } else if (/row-level security/i.test(m)) {
                r.problems.push('02-fixes.sql did not finish - run it again');
              } else if (/Illegal invocation/i.test(m)) {
                r.problems.push('the published remc-data.js is the old one - upload it again');
              } else {
                r.problems.push('writes are not getting through: ' + m);
              }
            });
        })
        .then(function () {
          if (!r.problems.length && r.reading === 'OK' && r.writing === 'OK') {
            r.verdict = 'Everything is working on this side.';
          } else {
            r.verdict = 'There is a problem: ' + r.problems.join('; ');
          }
          return r;
        });
    },

    _internal: { cache: cache, outbox: function () { return outbox; }, cfg: cfg }
  };

  root.remcData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
