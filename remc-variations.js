/* ==========================================================================
 * remc-variations.js  -  as variacoes, uma linha por variacao
 * --------------------------------------------------------------------------
 * Ate aqui a mesma variacao vivia em dois sitios: um registo em
 * remc_variations e um pedido em remc_variation_requests, ligados por um
 * campo. Manter os dois a par era o que fazia as variacoes do telemovel nao
 * chegarem ao escritorio.
 *
 * Agora e uma linha so, na tabela remc_variations. Onde ela esta no percurso
 * de aprovacao e uma coluna dessa linha:
 *
 *     approval   levantada na obra, a espera do escritorio
 *     check      o escritorio esta a ver
 *     approved   aprovada - e so aqui que entra na obra
 *     declined   nao avanca
 *
 * As paginas nao mudaram. Este ficheiro reconstroi, a partir das linhas, as
 * duas chaves que elas ja liam - e traduz as gravacoes delas em alteracoes as
 * linhas. Enquanto isto se mantiver, cada area seguinte e um ficheiro destes,
 * nao uma reescrita.
 * ========================================================================== */
(function (root) {
  'use strict';

  var TABLE = 'remc_variations';
  var KEY_V = 'remc_variations';
  var KEY_R = 'remc_variation_requests';

  var d = null;                 // a camada de dados
  var opts = { actor: function () { return ''; }, log: function () {} };
  var _mapCache = null, _reqCache = null;

  // Um registo levantado na obra fica fora da obra ate ser aprovado. As paginas
  // reconhecem isso por um campo "state" com o valor 'pending'; quando ele
  // desaparece, a variacao esta na obra. Mantemos essa linguagem para nao ter
  // de mexer em nada do que desenha os ecras.
  function legacyState(rowState) {
    if (rowState === 'approved' || rowState == null || rowState === '') return null;
    return 'pending';
  }

  function isReqOnly(row) { return !!(row.data && row.data._reqOnly); }

  // ------------------------------------------------------------ projeccao ---
  function buildMap() {
    var out = {};
    d.all(TABLE).forEach(function (row) {
      if (isReqOnly(row)) return;                 // pedido sem registo na obra
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
    // A ordem com que estavam: mais antigo primeiro, como o telemovel espera.
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

  // -------------------------------------------------------------- escrita ---
  function sameData(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  /** Grava uma variacao. rec e o registo tal como as paginas o escrevem. */
  function saveRecord(pid, rec, o) {
    o = o || {};
    var id = String(rec.id || d.newId('vr'));
    var existing = d.byId(TABLE, id);
    var data = {};
    Object.keys(rec).forEach(function (k) {
      if (k === 'id' || k === 'state' || k === '_pending' || k === '_failed') return;
      data[k] = rec[k];
    });
    // o que era so do pedido fica onde estava
    if (existing && existing.data && existing.data._req) data._req = existing.data._req;
    if (existing && existing.data && existing.data._reqOnly) data._reqOnly = existing.data._reqOnly;
    if (o.req) data._req = o.req;

    var state = o.state;
    if (!state) {
      if (rec.state === 'pending') {
        // ja estava a espera: mantem o sitio exacto onde estava na aprovacao
        state = (existing && existing.state && existing.state !== 'approved')
          ? existing.state : 'approval';
      } else {
        state = 'approved';
      }
    }

    if (existing && sameData(existing.data, data) && existing.state === state &&
        String(existing.project_id) === String(pid)) {
      return Promise.resolve(existing);        // nada mudou, nada sobe
    }

    return d.save(TABLE, {
      id: id, project_id: pid == null ? null : String(pid),
      state: state, data: data
    }, { actor: opts.actor(), idPrefix: 'vr' });
  }

  function removeRecord(id) { return d.remove(TABLE, String(id), { actor: opts.actor() }); }

  /** Recebe a lista inteira de variacoes de uma obra, como as paginas ja a
   *  escreviam, e transforma-a nas alteracoes minimas. So sobe o que mudou. */
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

  /** O mesmo para a lista de pedidos da pagina Variations. */
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
        // Um pedido levantado no escritorio sem registo na obra: fica so como
        // pedido. Se for aprovado, e ai que nasce a variacao na obra.
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

    // Um pedido retirado da lista. Se so existia como pedido, sai. Se ja tinha
    // entrado na obra, a variacao fica la - so deixa de ter pedido, que e
    // exactamente o que a pagina avisa quando se apaga um pedido aprovado.
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

  // ------------------------------------------------------ o que ja existia --
  // Assim que a projeccao corre pela primeira vez, ela reescreve as duas
  // chaves antigas a partir das linhas - que a comecar estao vazias. O que
  // este computador tinha guardado desapareceria sem ninguem dar por isso.
  // Por isso guarda-se uma copia, uma unica vez, antes de a projeccao mexer.
  var BK = 'remcdl:v1:antigo:variacoes';

  function guardarAntigo() {
    var s = d._internal.cfg.storage ||
            (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return;
    var ja = null;
    try { ja = s.getItem(BK); } catch (e) {}
    if (ja) return;                                   // ja foi guardado antes
    var v = null, r = null;
    try { v = s.getItem(KEY_V); r = s.getItem(KEY_R); } catch (e) {}
    if (!v && !r) return;
    d.writeLegacy(BK, JSON.stringify({ at: new Date().toISOString(), v: v || '{}', r: r || '[]' }));
    opts.log('copia do que ja existia guardada em ' + BK);
  }

  /** Traz para as tabelas o que este computador tinha antes. So corre quando
   *  se pede, e nao faz mal correr duas vezes: cada registo mantem o seu id,
   *  por isso o segundo import nao cria copias. */
  function importarAntigo() {
    var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var raw = null;
    try { raw = s && s.getItem(BK); } catch (e) {}
    if (!raw) return Promise.resolve({ variacoes: 0, pedidos: 0, nota: 'nao havia nada guardado' });

    var bk; try { bk = JSON.parse(raw); } catch (e) { return Promise.reject(new Error('copia ilegivel')); }
    var mapa = {}, pedidos = [];
    try { mapa = JSON.parse(bk.v || '{}') || {}; } catch (e) {}
    try { pedidos = JSON.parse(bk.r || '[]') || []; } catch (e) {}

    var porRec = {};
    pedidos.forEach(function (p) { if (p && p.recId) porRec[String(p.recId)] = p; });

    var jobs = [], nV = 0, nP = 0;
    Object.keys(mapa).forEach(function (pid) {
      (mapa[pid] || []).forEach(function (rec) {
        if (!rec || !rec.id) return;
        if (d.byId(TABLE, rec.id)) return;            // ja esta la
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

    // pedidos que nunca chegaram a ter registo na obra
    pedidos.forEach(function (p) {
      if (!p || !p.id) return;
      if (p.recId) return;
      if (d.byId(TABLE, p.id)) return;
      nP++;
      jobs.push(writeRequests([p]));
    });

    return Promise.all(jobs).then(function () {
      return { variacoes: nV, pedidos: nP };
    });
  }

  // ---------------------------------------------------------------- publico -
  var api = {
    TABLE: TABLE,
    init: function (o) {
      o = o || {};
      d = o.data || root.remcData;
      if (!d) throw new Error('remc-variations precisa da camada de dados');
      if (o.actor) opts.actor = (typeof o.actor === 'function') ? o.actor : function () { return o.actor; };
      if (o.log) opts.log = o.log;
      d.claim(KEY_V, KEY_R);
      guardarAntigo();
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

    /** Quanto e que este computador tinha guardado antes da mudanca. */
    antigo: function () {
      var s = d._internal.cfg.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      var raw = null; try { raw = s && s.getItem(BK); } catch (e) {}
      if (!raw) return null;
      try {
        var bk = JSON.parse(raw);
        var mapa = JSON.parse(bk.v || '{}') || {};
        var n = 0; Object.keys(mapa).forEach(function (k) { n += (mapa[k] || []).length; });
        return { guardadoEm: bk.at, variacoes: n, pedidos: (JSON.parse(bk.r || '[]') || []).length };
      } catch (e) { return null; }
    },
    importarAntigo: importarAntigo,
    _rebuild: function () { _mapCache = null; _reqCache = null; }
  };

  root.remcVariations = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
