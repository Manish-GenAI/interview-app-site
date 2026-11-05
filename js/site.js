// Copy-to-clipboard buttons for install commands; docs table of contents open on wide screens.
(function () {
  var toc = document.querySelector('.doc-aside details');
  if (toc && window.matchMedia && window.matchMedia('(min-width: 961px)').matches) toc.open = true;

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button.copy');
    if (!button) return;
    var text = button.getAttribute('data-copy') || '';
    var done = function (ok) {
      button.textContent = ok ? 'Copied' : 'Select & copy';
      button.classList.toggle('done', ok);
      setTimeout(function () { button.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  });
})();
