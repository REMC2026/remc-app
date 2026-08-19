/* ==========================================================================
 * remc-data.js  -  a camada de dados, igual nas duas apps
 * --------------------------------------------------------------------------
 * Tudo o que se le e escreve na base de dados passa por aqui. As paginas nao
 * sabem que isto existe: continuam a ler do sitio do costume, de forma
 * imediata, sem esperar pela rede.
 *
 * O que resolve
 *   - uma linha por registo, em vez da linha unica remc_state
 *   - duas pessoas a gravar ao mesmo tempo: a segunda ja nao escreve por cima
 *   - o telemovel sem rede: fica em fila e sobe sozinho quando a rede volta
 *   - uma gravacao repetida nao cria um segundo registo
 *   - o escritorio ve a variacao no momento em que ela e levantada na obra
 *
 * Como e usada
 *   remcData.configure({ url, anonKey, actor, tables:['remc_variations'] })
 *   remcData.all('remc_variations')            -> [] ja, sem esperar
 *   remcData.save('remc_variations', registo)  -> promessa, confirma no fim
 *   remcData.watch('remc_variations', redesenhar)
 *
 * Uma regra: nada aqui dentro escreve nas chaves antigas do localStorage por
 * si so. Isso e feito pela funcao "project" que cada app entrega, e e sempre
 * derivado das linhas - nunca ao contrario.
 * ========================================================================== */
(function (root) {
  'use strict';

  // A app antiga substitui o localStorage.setItem para apanhar as gravacoes e
  // as mandar para a linha unica. Guardamos aqui o original, do prototipo, para
  // as chaves que esta camada passa a mandar nao irem la parar duas vezes.
  var RAW_SET = null, RAW_GET = null, RAW_DEL = null;
  try {
    RAW_SET = Storage.prototype.setItem;
    RAW_GET = Storage.prototype.getItem;
    RAW_DEL = Storage.prototype.removeItem;
  } catch (e) { /* fora do browser */ }

  var PREFIX = 'remcdl:v1:';

  var TABLES = {
    remc_projects:   { project: false, state: false, kind: false },
    remc_variations: { project: true,  state: true,  kind: false },
    remc_claims:     { project: true,  state: false, kind: false },
    remc_materials:  { project: true,  state: false, kind: false },
    remc_bookings:   { project: true,  state: false, kind: true  },
    remc_suppliers:  { project: false, state: false, kind: false }
  };

  // ---------------------------------------------------------------- estado --
  var cfg = {
    url: '', anonKey: '', actor: '', tables: [],
    pollMs: 20000,          // rede de seguranca, caso o tempo real caia
    backoffMs: 1000,        // espera antes de repetir; duplica a cada falha
    maxBackoffMs: 30000,
    pageSize: 1000,
    realtime: true,
    storage: null,          // por omissao: o localStorage
    fetch: null,            // por omissao: o fetch da janela
    now: function () { return Date.now(); },
    project: null,          // funcao que reconstroi as chaves antigas
    merge: null,            // funcao que decide em caso de conflito
    log: function () {}
  };

  var cache    = {};        // tabela -> { id -> linha }
  var cursors  = {};        // tabela -> ultima data vista
  var outbox   = [];        // gravacoes por confirmar, na ordem em que sairam
  var watchers = {};        // tabela -> [funcao]
  var statusFns = [];
  var channels = {};
  var started   = false;
  var draining  = false;
  var drainTimer = null, pollTimer = null, backoff = 0;
  var conflicts = [];
  var lastSync  = null;
  var firstPull = null;
  var pullingNow = {};

  // ----------------------------------------------------------- ferramentas --
  function store() { return cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null); }

  // Guardadas no configure, antes de a app antiga por os seus ganchos. E por
  // aqui que se escreve, para uma gravacao nossa nao ser apanhada por ela e
  // enviada tambem para a linha unica.
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
    catch (e) { cfg.log('sem espaco no armazenamento do browser:', k); return false; }
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

  // Um id que uma pessoa consegue ler num ecra de historico, e que continua
  // unico quando dois telemoveis criam registos no mesmo segundo sem rede.
  function newId(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function online() {
    try { return typeof navigator === 'undefined' || navigator.onLine !== false; }
    catch (e) { return true; }
  }

  // ------------------------------------------------------------ persistir ---
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

  // ------------------------------------------------------------- avisar -----
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
        try { if (cfg.project) cfg.project(t, api); } catch (e) { cfg.log('projeccao falhou', t, e); }
        (watchers[t] || []).forEach(function (fn) {
          try { fn(api.all(t), t); } catch (e) { cfg.log('watcher falhou', t, e); }
        });
      });
      emitStatus();
    }, 0);
  }

  function emitStatus() {
    var s = api.status();
    statusFns.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  // -------------------------------------------------------------- rede ------
  function doFetch(path, opts) {
    var f = cfg.fetch || (typeof root.remcSafeFetch === 'function' ? root.remcSafeFetch : root.fetch);
    if (!f) return Promise.reject(new Error('sem fetch'));
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
  // Um erro do lado do servidor que nao vale a pena repetir tal e qual:
  // repetir sem mudar nada da sempre o mesmo resultado.
  function isPermanent(err) {
    if (!err) return false;
    if (isConflict(err) || isMissing(err)) return false;
    if (err.status === 400 || err.status === 401 || err.status === 403 ||
        err.status === 404 || err.status === 422) return true;
    return /REMC_BADTABLE|REMC_BADID|REMC_NOVERSION/.test(String(err.message || ''));
  }

  // ---------------------------------------------------------- ler o novo ----
  function pull(t) {
    if (!cfg.url || !cfg.anonKey) return Promise.resolve(0);
    if (pullingNow[t]) return pullingNow[t];

    var since = cursors[t] || '1970-01-01T00:00:00Z';
    // gte, nao gt: duas linhas podem partilhar o mesmo instante ao milissegundo,
    // e com gt a segunda nunca chegaria. Repetir a fronteira nao custa nada -
    // o que ja temos e reconhecido pela versao e ignorado.
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
      // Uma pagina cheia quer dizer que pode haver mais a seguir.
      if (rows.length >= cfg.pageSize) return pull(t).then(function (m) { return n + m; });
      return n;
    }).catch(function (err) {
      pullingNow[t] = null;
      cfg.log('leitura falhou', t, err && err.message);
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

  // Aceita uma linha vinda do servidor. Devolve true se mudou alguma coisa.
  function applyRemote(t, r) {
    if (!r || !r.id) return false;
    cache[t] = cache[t] || {};
    var have = cache[t][r.id];

    // Se ainda temos gravacoes por enviar para este registo, a nossa copia e a
    // que a pessoa esta a ver. Nao a substituimos por uma versao do servidor
    // que ainda nao inclui o que ela acabou de escrever: quando a fila esvaziar,
    // a resposta do servidor traz a linha certa.
    if (have && have._pending && hasPending(t, r.id)) return false;

    if (have && Number(have.version) >= Number(r.version) && !have._pending) {
      if (have.updated_at === r.updated_at) return false;
    }
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

  // ------------------------------------------------------------ escrever ----
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
      // sendOne so resolve quando a operacao esta tratada, de uma maneira ou
      // de outra. Sai da fila e a proxima segue.
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
        // Repetir isto para sempre so entope a fila atras dele.
        cfg.log('gravacao recusada e retirada da fila:', op.table, op.id, op.lastError);
        park(op, 'recusada');
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
    // A copia local fica marcada, para a pagina poder mostrar que aquela linha
    // nao chegou ao servidor em vez de fingir que esta tudo bem.
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
          // Quisemos alterar um registo que ja nao esta la. Se e um apagar,
          // ja esta apagado e nao ha nada a fazer. Se e uma alteracao, o
          // registo foi criado neste aparelho e nunca chegou a subir: manda-o
          // como criacao, para nao se perder.
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

  // Alguem gravou primeiro. Vamos buscar o que la esta, juntamos, e tentamos
  // outra vez a partir da versao dele. O merge por omissao mantem os campos
  // dele que nos nao tocamos, e poe os nossos por cima nos que tocamos - que e
  // o caso normal: duas pessoas a mexer em partes diferentes do mesmo registo.
  function resolveConflict(op, err) {
    op.conflicts = (op.conflicts || 0) + 1;
    if (op.conflicts > 3) {
      park(op, 'conflito');
      if (op.reject) op.reject(err);
      return null;                        // sai da fila; nao repete para sempre
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
        op.writeId = newId('w');          // e outra escrita, com outro conteudo
        // guarda o que la estava, para o ecra de conflitos poder mostrar
        op.theirs = theirs.data;
        throw err;                        // volta a fila, tenta ja a seguir
      });
  }

  // ------------------------------------------------------- tempo real -------
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
    if (!sb || typeof sb.channel !== 'function') { cfg.log('sem tempo real; fica o sondar'); return; }

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
    } catch (e) { cfg.log('tempo real falhou', t, e); }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!online()) return;
      try { if (typeof document !== 'undefined' && document.hidden) return; } catch (e) {}
      cfg.tables.forEach(function (t) { pull(t).catch(function () {}); });
    }, cfg.pollMs);
  }

  // ------------------------------------------------------------- publico ----
  var api = {

    configure: function (opts) {
      opts = opts || {};
      Object.keys(opts).forEach(function (k) { if (opts[k] !== undefined) cfg[k] = opts[k]; });
      cfg.tables = (cfg.tables || []).filter(function (t) {
        if (!TABLES[t]) { cfg.log('tabela desconhecida, ignorada:', t); return false; }
        return true;
      });
      snapshotStore();
      backoff = cfg.backoffMs;
      loadLocal();
      return api;
    },

    /** Arranca: le o que ha, liga o tempo real, e esvazia a fila que ficou de
     *  uma sessao anterior. Devolve uma promessa que resolve na primeira
     *  leitura completa - mas as paginas nao precisam de esperar por ela. */
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

    /** Todas as linhas de uma tabela, ja, sem esperar pela rede.
     *  Sem as apagadas, a nao ser que se peca. */
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

    /** Grava um registo. O ecra ve a alteracao imediatamente; a promessa
     *  resolve quando o servidor confirma, e e ai que se diz "gravado".
     *  rec = { id?, project_id?, state?, kind?, data } */
    save: function (t, rec, opts) {
      opts = opts || {};
      if (!TABLES[t]) return Promise.reject(new Error('tabela desconhecida: ' + t));
      rec = rec || {};

      var id = String(rec.id || newId(opts.idPrefix || 'r'));
      var existing = (cache[t] || {})[id];
      var data = isObj(rec.data) ? clone(rec.data) : {};

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

      // A copia local muda ja, para o ecra nao ficar a espera da rede.
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
        _pending: true
      };
      touched(t);

      return new Promise(function (resolve, reject) {
        op.resolve = function (row) {
          var r = cache[t] && cache[t][id];
          if (r) { r._pending = false; delete r._failed; touched(t); }
          resolve(row || r);
        };
        op.reject = reject;
        enqueue(op);
      });
    },

    /** Marca como apagado. A linha fica la, com quem a apagou e quando. */
    remove: function (t, id, opts) {
      opts = opts || {};
      if (!TABLES[t]) return Promise.reject(new Error('tabela desconhecida: ' + t));
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

    /** Repoe um registo apagado. */
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

    /** Avisa sempre que esta tabela muda - venha de onde vier a mudanca. */
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

    /** Manda tudo o que esta em fila, agora, sem esperar. */
    flush: function () { backoff = cfg.backoffMs; scheduleDrain(0); return drain(); },

    pull: function (t) {
      if (t) return pull(t);
      return Promise.all(cfg.tables.map(function (x) { return pull(x).catch(function () { return 0; }); }));
    },

    /** O historico de um registo: quem mudou o que, e quando. */
    history: function (t, id) {
      return doFetch('/rest/v1/remc_history?select=*&table_name=eq.' +
        encodeURIComponent(t) + '&record_id=eq.' + encodeURIComponent(id) +
        '&order=seq.desc&limit=200');
    },

    clearConflicts: function () { conflicts = []; emitStatus(); },

    /** As chaves antigas do localStorage que esta camada passou a mandar.
     *  A sincronizacao antiga tem de as deixar em paz, ou as duas escrevem
     *  por cima uma da outra. */
    owned: {},
    owns: function (key) { return !!api.owned[key]; },
    claim: function () {
      for (var i = 0; i < arguments.length; i++) api.owned[arguments[i]] = true;
      return api;
    },

    /** Escreve uma chave antiga sem acordar a sincronizacao antiga.
     *  So a funcao de projeccao deve usar isto. */
    writeLegacy: function (key, text) { return sset(key, text); },

    newId: newId,

    /** Apaga tudo o que esta camada guarda neste aparelho. A base de dados
     *  nao e tocada - da proxima vez volta a ser lida do inicio. */
    resetLocal: function () {
      cfg.tables.forEach(function (t) { sdel(rowsKey(t)); sdel(cursorKey(t)); cache[t] = {}; cursors[t] = ''; });
      sdel(OUTBOX_KEY); outbox = []; conflicts = [];
      emitStatus();
    },

    _internal: { cache: cache, outbox: function () { return outbox; }, cfg: cfg }
  };

  root.remcData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
