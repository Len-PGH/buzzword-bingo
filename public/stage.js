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
    var wins = s.winners || [];
    $('m-winners').textContent = wins.length;
    $('m-pattern').textContent = PATTERN_LABEL[s.activePattern] || s.activePattern || '—';
    // winners
    var host = $('winlist'); host.innerHTML = '';
    if (!wins.length) { var n = document.createElement('span'); n.className = 'none'; n.textContent = 'First bingo puts a name up here…'; host.appendChild(n); }
    else wins.forEach(function (w) { var el = document.createElement('span'); el.className = 'w'; el.textContent = w.name; host.appendChild(el); });
    // celebrate a brand-new winner (skip on first paint)
    if (booted && wins.length > lastWinnerCount) {
      var latest = wins[wins.length - 1];
      celebrate(latest ? latest.name : '');
    }
    lastWinnerCount = wins.length;
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
