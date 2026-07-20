'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var socket = io({ transports: ['websocket', 'polling'] });

  var PATTERN_LABEL = {
    any_line: 'Any line', four_corners: 'Four corners', x: 'An X',
    plus: 'A plus (+)', frame: 'Full frame', blackout: 'Blackout',
  };
  var lastWinnerCount = 0;
  var booted = false;

  function render(s) {
    if (!s) return;
    var sub = s.eventName || 'Play along from your seat';
    if (s.round && s.round > 1) sub = 'Round ' + s.round + ' · ' + sub;
    $('sub').textContent = sub;
    // QR / join link
    if (s.qr) { $('qr').src = s.qr; }
    $('url').textContent = (s.publicUrl || 'starting the tunnel…').replace(/^https?:\/\//, '');
    // buzz meter
    var b = s.sentiment || { positivePct: 0, negativePct: 0 };
    $('pp').textContent = b.positivePct + '%';
    $('np').textContent = b.negativePct + '%';
    $('bp').style.width = b.positivePct + '%';
    $('bn').style.width = b.negativePct + '%';
    // metrics
    $('m-players').textContent = s.players || 0;
    var hist = s.history || [];
    $('m-winners').textContent = hist.length;   // total across the whole event
    $('m-pattern').textContent = PATTERN_LABEL[s.activePattern] || s.activePattern || '—';
    // winners by round (persists across rounds)
    var host = $('winlist'); host.innerHTML = '';
    if (!hist.length) {
      var n = document.createElement('span'); n.className = 'none'; n.textContent = 'First bingo puts a name up here…'; host.appendChild(n);
    } else {
      var byRound = {};
      hist.forEach(function (w) { (byRound[w.round] = byRound[w.round] || []).push(w); });
      Object.keys(byRound).map(Number).sort(function (a, b) { return a - b; }).forEach(function (rnd) {
        var row = document.createElement('div'); row.className = 'rrow';
        var lbl = document.createElement('span'); lbl.className = 'rlbl'; lbl.textContent = 'Round ' + rnd; row.appendChild(lbl);
        byRound[rnd].forEach(function (w) {
          var chip = document.createElement('span'); chip.className = 'w'; chip.textContent = w.name;
          if (w.wonAt) chip.title = 'won at ' + new Date(w.wonAt).toLocaleTimeString();
          row.appendChild(chip);
        });
        host.appendChild(row);
      });
    }
    // celebrate a brand-new winner (skip on first paint)
    if (booted && hist.length > lastWinnerCount) {
      var latest = hist[hist.length - 1];
      celebrate(latest ? latest.name : '');
    }
    lastWinnerCount = hist.length;
    booted = true;
  }

  function celebrate(name) {
    $('flash-who').textContent = name;
    var f = $('flash'); f.classList.add('show');
    setTimeout(function () { f.classList.remove('show'); }, 4500);
  }

  socket.on('public', render);
  // initial paint in case the socket is slow
  fetch('/api/public').then(function (r) { return r.json(); }).then(render).catch(function () {});
})();
