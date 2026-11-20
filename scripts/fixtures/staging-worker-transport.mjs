// Child-process test seam ONLY. No real provider requests are permitted by this fixture.
const delay = (signal) => new Promise((_, reject) => {
  const abort = () => { console.log('fixture transport cancelled'); reject(signal.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});
let returnedOutage = false;
globalThis.fetch = async (url, init) => {
  if (new URL(url).hostname !== 'generativelanguage.googleapis.com') throw new Error('Unexpected test transport destination');
  const request = JSON.parse(init.body);
  const prompt = JSON.stringify(request.contents);
  if (prompt.includes('fixture-cancel')) return delay(init.signal);
  if (prompt.includes('fixture-auth-denied')) return Response.json({ error: { message: 'Access denied' } }, { status: 401 });
  if (prompt.includes('fixture-transient-once') && process.env.WORKER_FIXTURE_OUTAGE === '1' && !returnedOutage) {
    returnedOutage = true;
    return Response.json({ error: { message: 'Maintenance' } }, { status: 503 });
  }
  const planning = JSON.stringify(request.systemInstruction).includes('planning module');
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: planning ?
    '{"steps":[{"description":"Answer the staging objective"}]}' : 'Verified fixture response.' }] } }] });
};
