#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Correlate private native fixture evidence; never print transcript contents."""
import json
import sys


def validate(proof, receipt, frames):
    assert proof.get('ok') is True, 'SDK observation failed'
    finals = [f for f in proof['finals'] if f.get('streamId') == receipt['streamId']]
    assert len(finals) == 1, 'expected exactly one native final for current stream'
    final = finals[0]
    assert final['utteranceId'] == receipt.get('utteranceId'), 'native utterance/receipt mismatch'
    text = final['text'].strip()
    assert text, 'native final text empty'
    assert receipt.get('delivered') is True and receipt.get('ackFinals') == 1, 'native admission missing'
    cursor = proof['baselineCursor']
    events = sorted((r['event'] for r in proof['snapshot']['records'] if r.get('type') == 'event' and r['event']['seq'] > cursor), key=lambda e: e['seq'])
    def message_text(event):
        data = event.get('data', {})
        message = data.get('message', data)
        return ''.join(b.get('text', '') for b in message.get('content', []) if b.get('type') == 'text').strip()
    users = [e for e in events if e['type'] == 'user/message' and message_text(e) == text]
    assert len(users) == 1, 'recognized final must equal one NEW durable user record after baseline'
    user = users[0]
    # Real rc.1 agent-loop appends turn/start BEFORE consuming user/message.
    # Require a fresh turn containing this user, not a historical open snapshot.
    starts = [e for e in events if e['type'] == 'turn/start' and e['seq'] < user['seq']]
    assert starts, 'no new turn containing native user record after baseline'
    start = starts[-1]
    assert not any(e['type'] == 'turn/end' and start['seq'] < e['seq'] < user['seq'] for e in events), 'native user outside new turn'
    expected = proof['expectedEcho']
    assistants = [e for e in events if e['type'] == 'assistant/message' and e['seq'] > user['seq'] and message_text(e) == expected]
    assert assistants, 'native-specific durable assistant message absent'
    assistant = assistants[0]
    ends = [e for e in events if e['type'] == 'turn/end' and e['seq'] > assistant['seq']]
    assert ends, 'new native assistant turn did not complete'
    end = ends[0]
    if 'turn' in start.get('data', {}) and 'turn' in end.get('data', {}):
        assert start['data']['turn'] == end['data']['turn'], 'assistant turn identities differ'
    assert any(f.get('t') == 'assistant' and f.get('text', '').strip() == expected and f.get('done') is True for f in frames), 'native-specific completed assistant missing from SSE'
    assert any(f.get('t') == 'session' and f.get('running') is True for f in frames), 'new running transition absent'
    synths = [s for s in proof['syntheses'] if s['text'].strip() == expected]
    assert synths, 'production synthesis not correlated to native assistant'
    for synth in synths:
        sid = synth['speechId']
        relevant = [f for f in frames if f.get('speechId') == sid]
        started = any(f.get('t') == 'speech-started' for f in relevant)
        audio = [f for f in relevant if f.get('t') == 'audio' and f.get('pcmBase64')]
        done = any(f.get('t') == 'audio-done' and f.get('cancelled') is False for f in relevant)
        if started and audio and done:
            return {'userSeq': user['seq'], 'turnEndSeq': end['seq'], 'audioChunks': len(audio), 'finalChars': len(text)}
    raise AssertionError('production speechId must match started/audio/completed SSE chain')


def main():
    proof, receipt = (json.load(open(p)) for p in sys.argv[1:3])
    frames = []
    for line in open(sys.argv[3], errors='replace'):
        if line.startswith('data:'):
            frames.append(json.loads(line[5:]))
    result = validate(proof, receipt, frames)
    print('native correlated proof PASS: finalChars={finalChars} newUserSeq={userSeq} completedTurnSeq={turnEndSeq} productionAudioChunks={audioChunks}'.format(**result))


if __name__ == '__main__':
    main()
