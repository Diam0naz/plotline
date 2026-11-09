// Plotline pitch deck controller — external file because the site CSP is
// script-src 'self': an inline script is blocked and the deck would be stuck
// on slide 1 (this actually happened in production).
const slides = [...document.querySelectorAll('.slide')];
let i = 0;
const dots = document.getElementById('dots');
slides.forEach((_, n) => { const d = document.createElement('span'); d.className = 'dot'; d.onclick = () => go(n); dots.append(d); });
document.getElementById('footer').style.display = 'flex';

let booting = true; // booting go(0) must not push a history entry — physical Back should still exit the deck from slide 1

function go(n, fromPop = false) {
  i = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((s, k) => s.classList.toggle('active', k === i));
  [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
  document.getElementById('pageno').textContent = `${i + 1} / ${slides.length}`;
  document.getElementById('prev').disabled = i === 0;
  document.getElementById('next').disabled = i === slides.length - 1;
  // a long slide scrolled down keeps its scroll position when you swipe back — reset it
  slides[i].scrollTop = 0;
  // Anchor each slide in history: on Android/Chrome a touch-drag right fires
  // the browser back gesture, which would otherwise leave the deck entirely
  // (observed: pitch-deck -> about:blank). With these entries, that gesture
  // turns to the previous slide instead.
  if (!fromPop && !booting) history.pushState({ slide: i }, '', location.href);
}
addEventListener('popstate', (e) => {
  go(e.state && Number.isInteger(e.state.slide) ? e.state.slide : 0, true);
});
addEventListener('keydown', (e) => {
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(i + 1); }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(i - 1); }
  if (e.key === 'Home') go(0);
  if (e.key === 'End') go(slides.length - 1);
});
document.getElementById('prev').addEventListener('click', () => go(i - 1));
document.getElementById('next').addEventListener('click', () => go(i + 1));
// Horizontal swipe = page turn anywhere on a phone. Only a clearly
// horizontal gesture counts, so vertical scroll on tall slides stays scroll.
let tX = 0, tY = 0;
addEventListener('touchstart', (e) => { tX = e.touches[0].clientX; tY = e.touches[0].clientY; }, { passive: true });
addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - tX, dy = e.changedTouches[0].clientY - tY;
  if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy)) go(dx < 0 ? i + 1 : i - 1);
}, { passive: true });
// Touch detection by capability, not the pointer media query (headless and
// some desktops report pointer:none with no physical input devices). A
// touch-capable browser gets swipe + footer controls; a desktop keeps the
// presenter click zones.
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
// Edge click zones stay for desktop presenting, but must not steal the taps
// the footer buttons and dots are for on touch devices.
addEventListener('click', (e) => {
  if (e.target.closest('.foot')) return;
  if (isTouch) return;
  if (e.clientX > innerWidth * .66) go(i + 1); if (e.clientX < innerWidth * .33) go(i - 1);
});
go(0);
booting = false;
