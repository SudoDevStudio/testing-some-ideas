const $ = (id) => document.getElementById(id);
let snapshot;
let loading = false;
let sending = false;

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function preview() {
  if (loading || sending) return;
  loading = true;
  snapshot = undefined;
  $('send').disabled = true;
  $('reload-preview').disabled = true;
  $('send-result').hidden = true;
  $('response-section').hidden = true;
  showError('preview-error', '');
  try {
    const response = await fetch('/push-event/preview', { signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Could not load recent errors');
    snapshot = body;
    const event = body.event;
    $('preview-count').textContent = event.summary.errorCount;
    $('preview-500').textContent = event.summary.byStatus['500'] || 0;
    $('preview-503').textContent = event.summary.byStatus['503'] || 0;
    $('preview-window').textContent = `${new Date(event.window.from).toLocaleTimeString()} – ${new Date(event.window.to).toLocaleTimeString()}`;
    $('payload').textContent = JSON.stringify(event, null, 2);
    const notes = [];
    if (event.coverage.truncated) notes.push('High volume: only the latest 1,000 errors are included. Counts describe those included errors.');
    if (event.coverage.currentSessionOnly) notes.push('Local mode: limited to errors retained in this server session’s 500-log buffer.');
    if (!event.summary.errorCount) notes.push('No errors found in this five-minute window. You can still send the empty summary.');
    $('coverage-note').textContent = notes.join(' ');
    $('coverage-note').hidden = !notes.length;
    $('send').disabled = false;
  } catch (error) {
    showError('preview-error', `${error.message}. Use Refresh to try again.`);
    $('payload').textContent = 'Preview unavailable.';
    $('preview-window').textContent = 'Could not load recent errors';
    for (const id of ['preview-count', 'preview-500', 'preview-503']) $(id).textContent = '—';
    $('coverage-note').hidden = true;
  } finally {
    loading = false;
    $('reload-preview').disabled = false;
  }
}

$('reload-preview').addEventListener('click', preview);
$('push-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !snapshot) return;
  showError('form-error', '');
  let headers;
  try {
    headers = JSON.parse($('headers').value.trim() || '{}');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((value) => typeof value !== 'string')) throw new Error();
  } catch {
    showError('form-error', 'Headers must be a JSON object with string values, for example {"Authorization":"Bearer token"}.');
    $('headers').focus();
    return;
  }
  if (Date.now() >= Date.parse(snapshot.expiresAt)) {
    snapshot = undefined;
    $('send').disabled = true;
    showError('form-error', 'This preview expired. Refresh it before sending.');
    return;
  }
  sending = true;
  $('send').disabled = true;
  $('send').textContent = 'Sending…';
  $('reload-preview').disabled = true;
  $('send-result').hidden = true;
  $('response-section').hidden = true;
  try {
    const response = await fetch('/push-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('destination').value, headers, eventId: snapshot.event.eventId }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 || response.status === 502) snapshot = undefined;
      throw new Error(body.error?.message || 'Unable to send event');
    }
    snapshot = undefined;
    $('send-result').classList.toggle('failed', !body.delivered);
    $('send-result').textContent = body.delivered
      ? `Event sent with ${body.errorCount} errors. Destination returned HTTP ${body.destinationStatus}. Refresh the preview to send another event.`
      : `Destination returned HTTP ${body.destinationStatus}. Check its response below. The event was not automatically retried.`;
    $('send-result').hidden = false;
    $('destination-response').textContent = `${body.response || '(Empty response)'}${body.responseTruncated ? '\n[Response shortened]' : ''}`;
    $('response-section').hidden = false;
  } catch (error) {
    if (error.name === 'TimeoutError' || error instanceof TypeError) {
      snapshot = undefined;
      showError('form-error', 'Delivery could not be confirmed. Check the destination before refreshing and trying again.');
    } else showError('form-error', error.message);
  } finally {
    sending = false;
    $('send').disabled = !snapshot;
    $('send').textContent = 'Send event →';
    $('reload-preview').disabled = false;
  }
});
preview();
