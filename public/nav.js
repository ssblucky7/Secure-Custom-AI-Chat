(function () {
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  const backdrop = document.getElementById('navBackdrop');
  if (!toggle || !links) return;

  toggle.setAttribute('aria-controls', 'navLinks');

  const DESKTOP_QUERY = window.matchMedia('(min-width: 768px)');

  function openNav() {
    toggle.classList.add('open');
    links.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function closeNav() {
    if (!links.classList.contains('open')) return;
    toggle.classList.remove('open');
    links.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', function () {
    links.classList.contains('open') ? closeNav() : openNav();
  });

  if (backdrop) backdrop.addEventListener('click', closeNav);

  links.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') closeNav();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const wasOpen = links.classList.contains('open');
      closeNav();
      if (wasOpen) toggle.focus();
    }
  });

  function handleViewportChange(event) {
    if (event.matches) {
      closeNav();
    }
  }
  if (typeof DESKTOP_QUERY.addEventListener === 'function') {
    DESKTOP_QUERY.addEventListener('change', handleViewportChange);
  } else if (typeof DESKTOP_QUERY.addListener === 'function') {
    DESKTOP_QUERY.addListener(handleViewportChange);
  }
})();
