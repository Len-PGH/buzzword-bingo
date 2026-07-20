'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var socket = io({ transports: ['websocket', 'polling'] });
  var KEY = '';
  try { KEY = localStorage.getItem('bb_opkey') || ''; } catch (e) {}

  function op(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-operator-key': KEY }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  // ---- auth ----
  function unlock(key) {
    socket.emit('operator-auth', { key: key }, function (res) {
      if (res && res.ok) {
        KEY = key;
        try { localStorage.setItem('bb_opkey', key); } catch (e) {}
        $('gate').style.display = 'none';
        $('app').style.display = '';
        refreshClaims();
        refreshBuzzwords();
      } else {
        $('gate-err').textContent = 'Wrong key.';
        $('gate').style.display = ''; $('app').style.display = 'none';
      }
    });
  }
  $('key-go').addEventListener('click', function () { unlock($('key').value.trim()); });
  $('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(this.value.trim()); });

  // ---- overview ----
  function renderOverview(o) {
    if (!o) return;
    $('s-players').textContent = o.players;
    $('s-claims').textContent = o.pendingClaims;
    $('s-winners').textContent = (o.winners || []).length;
    var s = o.sentiment || { positivePct: 0, negativePct: 0 };
    $('m-p').style.width = s.positivePct + '%'; $('m-n').style.width = s.negativePct + '%';
    $('m-pp').textContent = s.positivePct + '%'; $('m-np').textContent = s.negativePct + '%';
    if (o.activePattern && $('pattern').value !== o.activePattern) $('pattern').value = o.activePattern;
    if ($('round-pill')) $('round-pill').textContent = 'Round ' + (o.round || 1);
    // QR / join link
    if (o.qr) { $('qr').src = o.qr; $('qr').style.display = ''; }
    $('url').textContent = o.publicUrl || 'no public URL yet (run behind the tunnel to get one)';
    // winners
    var ul = $('winners'); ul.innerHTML = '';
    (o.winners || []).forEach(function (w) {
      var li = document.createElement('li');
      var a = document.createElement('span'); a.textContent = w.name;
      var b = document.createElement('span'); b.className = 'muted';
      b.textContent = new Date(w.won_at).toLocaleTimeString();
      li.appendChild(a); li.appendChild(b); ul.appendChild(li);
    });
    if (!(o.winners || []).length) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'None yet.'; ul.appendChild(li); }
  }

  // ---- claims ----
  function renderClaims(data) {
    var claims = (data && data.claims) || [];
    $('no-claims').style.display = claims.length ? 'none' : '';
    var host = $('claims'); host.innerHTML = '';
    claims.forEach(function (c) {
      var el = document.createElement('div'); el.className = 'claim';
      var h = document.createElement('h3'); h.textContent = c.name; el.appendChild(h);
      var meta = document.createElement('div'); meta.className = 'muted'; meta.style.fontSize = '13px';
      meta.textContent = 'Claimed: ' + (c.completed && c.completed.length ? c.completed.join(', ') : c.pattern);
      el.appendChild(meta);
      // mini card
      var mg = document.createElement('div'); mg.className = 'minigrid';
      var markedSet = {}; (c.marked || []).forEach(function (i) { markedSet[i] = true; });
      c.card.cells.forEach(function (cell, i) {
        var m = document.createElement('div');
        m.className = 'minicell' + (cell.free ? ' free' : '') + (markedSet[i] ? ' marked' : '');
        m.textContent = cell.free ? '★' : cell.word;
        mg.appendChild(m);
      });
      el.appendChild(mg);
      var words = document.createElement('div'); words.className = 'muted'; words.style.fontSize = '12px';
      words.textContent = 'Blotted: ' + (c.markedWords || []).join(', ');
      el.appendChild(words);
      var row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '10px';
      var ok = document.createElement('button'); ok.className = 'btn approve'; ok.style.width = 'auto'; ok.style.flex = '1'; ok.textContent = '✓ Approve — they win';
      var no = document.createElement('button'); no.className = 'btn reject'; no.style.width = 'auto'; no.style.flex = '1'; no.textContent = '✗ Reject';
      ok.addEventListener('click', function () { review(c.id, 'approve'); });
      no.addEventListener('click', function () { review(c.id, 'reject'); });
      row.appendChild(ok); row.appendChild(no); el.appendChild(row);
      host.appendChild(el);
    });
  }
  function refreshClaims() { op('/api/operator/claims').then(function (r) { if (r.ok) renderClaims(r.j); }); }
  function review(id, decision) {
    op('/api/operator/review', { id: id, decision: decision }).then(function () { refreshClaims(); });
  }

  $('pattern').addEventListener('change', function () {
    op('/api/operator/pattern', { pattern: this.value });
  });
  $('new-round').addEventListener('click', function () {
    if (!window.confirm('Start a new round for the next speaker? Everyone gets a fresh card and the board clears.')) return;
    op('/api/operator/round', {}).then(function () { refreshClaims(); });
  });

  // ---- buzzwords ----
  var CAT_COLOR = { positive: 'var(--pos)', negative: 'var(--neg)', name: 'var(--name)' };
  var CAT_LABEL = { positive: 'positive', negative: 'negative', name: 'name' };
  function refreshBuzzwords() {
    op('/api/operator/buzzwords').then(function (r) {
      if (!r.ok) return;
      var c = r.j.counts || {};
      $('bw-counts').textContent = 'Pools: ' + c.positive + ' positive · ' + c.negative + ' negative · ' + c.names + ' names.';
      var host = $('bw-list'); host.innerHTML = '';
      var custom = r.j.custom || [];
      if (!custom.length) { var n = document.createElement('span'); n.className = 'muted'; n.textContent = 'No custom words yet — the built-in lists are in use.'; host.appendChild(n); return; }
      custom.forEach(function (w) {
        var chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin:0 8px 8px 0;padding:6px 12px;border-radius:999px;background:var(--panel2);border:1px solid var(--line)';
        var dot = document.createElement('span'); dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + (CAT_COLOR[w.category] || '#888');
        var txt = document.createElement('span'); txt.textContent = w.word;
        var x = document.createElement('button'); x.textContent = '×'; x.title = 'remove';
        x.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1;padding:0';
        x.addEventListener('click', function () { op('/api/operator/buzzwords/remove', { id: w.id }).then(refreshBuzzwords); });
        chip.appendChild(dot); chip.appendChild(txt); chip.appendChild(x); host.appendChild(chip);
      });
    });
  }
  $('bw-add').addEventListener('click', function () {
    $('bw-err').textContent = '';
    var word = $('bw-word').value.trim();
    if (!word) { $('bw-err').textContent = 'Enter a word.'; return; }
    op('/api/operator/buzzwords', { word: word, category: $('bw-cat').value }).then(function (r) {
      if (!r.ok) { $('bw-err').textContent = (r.j && r.j.error) || 'Could not add.'; return; }
      $('bw-word').value = ''; refreshBuzzwords();
    });
  });
  $('bw-word').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('bw-add').click(); });

  // ---- realtime ----
  socket.on('overview', renderOverview);
  socket.on('claim', function () { refreshClaims(); });

  // auto-unlock if we have a stored key
  if (KEY) unlock(KEY);
})();
