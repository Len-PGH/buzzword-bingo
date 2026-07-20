'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var socket = io({ transports: ['websocket', 'polling'] });

  var PATTERN_LABEL = {
    any_line: 'Any line — row, column, or diagonal',
    four_corners: 'Four corners',
    x: 'An X',
    plus: 'A plus (+)',
    frame: 'The full frame (outer edge)',
    blackout: 'Blackout — the whole card',
  };

  var card = null;      // { size, cells:[{word,polarity,free}], ... }
  var marked = new Set();
  var pattern = 'any_line';
  var claimPending = false;
  var won = false;

  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  // ---- rendering ----
  function renderTarget() {
    $('target').innerHTML = 'Target: ';
    var b = document.createElement('b');
    b.textContent = PATTERN_LABEL[pattern] || pattern;
    $('target').appendChild(b);
  }

  function renderGrid() {
    var g = $('grid');
    g.innerHTML = '';
    card.cells.forEach(function (cell, i) {
      var el = document.createElement('button');
      el.className = 'cell ' + cell.polarity + (marked.has(i) ? ' marked' : '') + (marked.has(i) && !cell.free ? ' blotword' : '');
      el.type = 'button';
      if (!cell.free) { var dot = document.createElement('span'); dot.className = 'pol'; el.appendChild(dot); }
      var span = document.createElement('span'); span.textContent = cell.word; el.appendChild(span);
      if (!cell.free && !won) el.addEventListener('click', function () { toggle(i); });
      g.appendChild(el);
    });
  }

  function renderMeter(s) {
    if (!s) s = { positivePct: 0, negativePct: 0, total: 0 };
    $('meter-p').style.width = s.positivePct + '%';
    $('meter-n').style.width = s.negativePct + '%';
    $('pct-p').textContent = s.positivePct + '%';
    $('pct-n').textContent = s.negativePct + '%';
  }

  function setBingoEnabled(complete) {
    var btn = $('bingo');
    if (won) { btn.style.display = 'none'; return; }
    if (claimPending) { btn.disabled = true; btn.textContent = 'Sent to the judges…'; return; }
    btn.disabled = !complete;
    btn.textContent = complete ? '🎉 Call BINGO!' : 'Fill the pattern to call bingo';
  }

  function showStatus() {
    var s = $('status');
    s.innerHTML = '';
    if (won) {
      var w = document.createElement('div'); w.className = 'banner won';
      w.textContent = '🏆 BINGO! You won — see the organizers for your prize!';
      s.appendChild(w);
    } else if (claimPending) {
      var p = document.createElement('div'); p.className = 'banner pending';
      p.textContent = '⏳ Bingo sent! Waiting for an organizer to confirm your card…';
      s.appendChild(p);
    }
  }

  // ---- actions ----
  function toggle(i) {
    if (won || claimPending) return;
    var on = !marked.has(i);
    if (on) marked.add(i); else marked.delete(i);
    renderGrid();
    api('/api/mark', { index: i, on: on }).then(function (r) {
      if (!r.ok) { // revert on failure
        if (on) marked.delete(i); else marked.add(i);
        renderGrid();
        return;
      }
      marked = new Set(r.j.marked);
      renderGrid();
      renderMeter(r.j.sentiment);
      setBingoEnabled(r.j.complete);
    });
  }

  $('bingo').addEventListener('click', function () {
    if ($('bingo').disabled) return;
    api('/api/claim', {}).then(function (r) {
      if (!r.ok) { flashStatus(r.j.error || 'Not yet!'); return; }
      claimPending = true; setBingoEnabled(false); showStatus();
    });
  });

  function flashStatus(msg, kind) {
    var s = $('status'); s.innerHTML = '';
    var b = document.createElement('div'); b.className = 'banner ' + (kind || 'lost'); b.textContent = msg;
    s.appendChild(b);
    setTimeout(function () { if (!won && !claimPending) s.innerHTML = ''; }, 3000);
  }

  $('draw').addEventListener('click', function () {
    $('reg-err').textContent = '';
    var body = { name: $('f-name').value, email: $('f-email').value, phone: $('f-phone').value };
    $('draw').disabled = true;
    api('/api/register', body).then(function (r) {
      $('draw').disabled = false;
      if (!r.ok) { $('reg-err').textContent = r.j.error || 'Something went wrong.'; return; }
      enterGame(r.j);
    });
  });

  function enterGame(data) {
    card = data.card;
    marked = new Set(data.marked || []);
    pattern = data.pattern || 'any_line';
    won = !!data.wonAt;
    $('register').style.display = 'none';
    $('game').style.display = '';
    if (data.name) $('whoami').textContent = 'Playing as ' + data.name + '.';
    renderTarget();
    renderGrid();
    // ask server for a fresh sentiment + complete state
    api('/api/me').then(function (r) {
      renderMeter(r.j.sentiment);
      setBingoEnabled(r.j.complete);
      showStatus();
    });
  }

  // ---- realtime ----
  socket.on('result', function (msg) {
    if (msg.approved) { won = true; claimPending = false; renderGrid(); setBingoEnabled(false); showStatus(); }
    else { claimPending = false; setBingoEnabled(true); flashStatus('Not confirmed — keep an eye on the talk and try again.'); }
  });
  socket.on('pattern', function (msg) {
    pattern = msg.pattern; renderTarget();
    api('/api/me').then(function (r) { setBingoEnabled(r.j.complete); });
  });
  // New speaker → everyone gets a fresh card; refetch and reset.
  socket.on('round', function () {
    if (!card) return; // still on the registration screen
    won = false; claimPending = false; marked = new Set();
    api('/api/me').then(function (r) {
      var d = r.j;
      card = d.card; marked = new Set(d.marked || []); pattern = d.pattern || 'any_line'; won = !!d.wonAt;
      $('status').innerHTML = '';
      renderTarget(); renderGrid(); renderMeter(d.sentiment); setBingoEnabled(d.complete);
      flashStatus("🆕 New round — here's your fresh card!", 'pending');
    });
  });

  // ---- boot: reload-safe ----
  api('/api/me').then(function (r) {
    var d = r.j;
    if (d.eventName) $('event-sub').textContent = d.eventName;
    if (d.registered && d.card) { enterGame(d); }
    else { $('register').style.display = ''; }
  });
})();
