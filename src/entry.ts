const view = new URLSearchParams(window.location.search).get('view')

if (view === 'popup') {
  void import('./popup')
} else {
  void import('./main')
}
