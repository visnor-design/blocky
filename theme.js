// Spúšťa sa pred vykreslením, aby appka neblikla v inej farbe.
(function () {
  var d = document.documentElement, s = {};
  try { s = JSON.parse(localStorage.getItem('blocky-settings')) || {}; } catch (e) { /* ignoruj */ }
  d.dataset.accent = s.accent || 'teal';
  d.dataset.contrast = s.contrast || 'medium';
})();
