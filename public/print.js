// Opens the print dialog automatically on the printable invoice page.
// Kept in a file (not inline) so it is allowed by `script-src 'self'` in production.
window.addEventListener('load', () => {
  window.print();
});
