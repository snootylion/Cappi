#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Verify a real fixture model-requested tool callback in the durable SDK log."""
import json
import sys


def validate(proof):
    assert proof.get('ok') is True, 'callback SDK observation failed'
    events = [r['event'] for r in proof['snapshot']['records'] if r.get('type') == 'event' and r['event']['seq'] > proof['baselineCursor']]
    matches = []
    for e in events:
        if e['type'] != 'tool/result':
            continue
        for block in e.get('data', {}).get('message', {}).get('content', []):
            if block.get('type') == 'tool-result' and block.get('toolCallId') == proof['callId']:
                assert block.get('isError') is not True and not e.get('data', {}).get('error'), 'real callback tool failed'
                matches.append((e, block))
    assert len(matches) == 1, 'exactly one new SDK tool result required for current callback callId'
    event, block = matches[0]
    expected_name = 'fixture_approval' if proof['kind'] == 'approval' else 'ask_user_question'
    calls = [e for e in events if e['type'] == 'tool/call' and e.get('data', {}).get('callId') == proof['callId'] and e['data'].get('name') == expected_name]
    assert len(calls) == 1 and calls[0]['seq'] < event['seq'], 'one real model-requested SDK tool call must precede result'
    starts = [e for e in events if e['type'] == 'turn/start' and e['seq'] < calls[0]['seq']]
    assert starts, 'callback must execute inside a fresh SDK turn after baseline'
    start = starts[-1]
    assert any(e['type'] == 'user/message' and start['seq'] < e['seq'] < calls[0]['seq'] for e in events), 'fresh fixture user prompt must drive callback turn'
    assert not any(e['type'] == 'turn/end' and start['seq'] < e['seq'] < event['seq'] for e in events), 'SDK callback result outside its open turn'
    for member in (calls[0], event):
        if 'turn' in member.get('data', {}): assert member['data']['turn'] == start['data']['turn'], 'SDK callback turn correlation mismatch'
    contents = [b['text'] for b in block.get('content', []) if b.get('type') == 'text']
    values = [json.loads(text) for text in contents]
    if proof['kind'] == 'approval':
        assert any(v.get('outcome') == 'allowed-once' for v in values), 'actual approval promise did not resolve allowed-once'
        asked = [e for e in events if e['type'] == 'approval/asked' and e.get('data', {}).get('callId') == proof['callId']]
        assert len(asked) == 1, 'one actual approval audit ask required'
        decided = [e for e in events if e['type'] == 'approval/decided' and e.get('data', {}).get('id') == asked[0]['data']['id']]
        assert len(decided) == 1 and decided[0]['data']['outcome'] == 'allowed-once', 'one matching approval audit decision required'
        assert asked[0]['seq'] < decided[0]['seq'] < event['seq'], 'approval ask/decision/result audit ordering'
    else:
        assert any(v.get('answers') == [{'id': 'fixture-choice', 'selected': ['fixture-answer']}] for v in values), 'actual question promise did not resolve selected answer'
    assert any(e['type'] == 'turn/end' and e['seq'] > event['seq'] for e in events), 'callback model turn did not complete'
    return event['seq']


if __name__ == '__main__':
    seq = validate(json.load(open(sys.argv[1])))
    print('real SDK callback proof PASS: one correlated durable tool result, completed turn, seq=%d' % seq)
