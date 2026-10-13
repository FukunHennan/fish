async function setupVideoProbe(options) {
  const player = document.querySelector('video');
  const peer = new RTCPeerConnection({ iceServers: options.iceServers, iceTransportPolicy: options.policy });
  const state = { peer, player, events: [], firstFrameMs: null, lastFrameAt: null, maxFrameGapMs: 0, renderedFrames: 0 };
  window.videoProbe = state;
  const started = performance.now();
  for (const name of ['connectionstatechange', 'iceconnectionstatechange']) {
    peer.addEventListener(name, () => state.events.push({
      elapsedMs: Math.round(performance.now() - started),
      connection: peer.connectionState, ice: peer.iceConnectionState,
    }));
  }
  const receiver = peer.addTransceiver('video', { direction: 'recvonly' }).receiver;
  if (options.bufferMs !== null) {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = options.bufferMs;
    else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = options.bufferMs / 1000;
  }
  function onFrame(now) {
    if (state.firstFrameMs === null) state.firstFrameMs = now - started;
    if (state.lastFrameAt !== null) state.maxFrameGapMs = Math.max(state.maxFrameGapMs, now - state.lastFrameAt);
    state.lastFrameAt = now;
    state.renderedFrames += 1;
    state.frameCallback = player.requestVideoFrameCallback(onFrame);
  }
  if (player.requestVideoFrameCallback) state.frameCallback = player.requestVideoFrameCallback(onFrame);
  peer.ontrack = async event => {
    player.srcObject = event.streams[0] || new MediaStream([event.track]);
    await player.play();
  };
  await peer.setLocalDescription(await peer.createOffer());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('ICE gathering timeout')), options.timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      if (error) reject(error); else resolve();
    }
    function changed() { if (peer.iceGatheringState === 'complete') finish(); }
    peer.addEventListener('icegatheringstatechange', changed);
    changed();
  });
  return { sdp: peer.localDescription.sdp, type: peer.localDescription.type };
}

async function sampleVideoProbe() {
  const state = window.videoProbe;
  const report = await state.peer.getStats();
  let inbound = null;
  let pair = null;
  report.forEach(entry => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
    if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = report.get(entry.selectedCandidatePairId);
  });
  const sample = {
    timestampMs: performance.now(), connection: state.peer.connectionState, ice: state.peer.iceConnectionState,
    renderedFrames: state.renderedFrames, firstFrameMs: state.firstFrameMs,
    videoWidth: state.player.videoWidth, videoHeight: state.player.videoHeight,
    maxFrameGapMs: Math.max(state.maxFrameGapMs, state.lastFrameAt === null ? 0 : performance.now() - state.lastFrameAt),
    selectedPath: null,
  };
  if (inbound) {
    for (const name of ['framesDecoded', 'framesDropped', 'bytesReceived', 'packetsReceived', 'packetsLost',
      'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'freezeCount', 'totalFreezesDuration', 'nackCount', 'pliCount']) {
      sample[name] = inbound[name] ?? null;
    }
  }
  if (pair) {
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    sample.rttMs = pair.currentRoundTripTime === undefined ? null : pair.currentRoundTripTime * 1000;
    sample.selectedPath = { local: local?.candidateType, remote: remote?.candidateType,
      protocol: local?.protocol, relayProtocol: local?.relayProtocol };
  }
  return sample;
}
